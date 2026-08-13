import { PlatformAccessory } from "homebridge";
import RoborockPlatform from "./platform";
import {
  getServerTimers,
  updateServerTimer,
  updateTimer,
} from "./hap_schedule_api";

const VERIFY_DELAY_MS = 1500;
const WRITE_SUPPRESSION_MS = 5000;
const SERVICE_PREFIX = "roborock-schedule-";

export const HAP_EXTENSION_KIND = "hapExtension" as const;
export const HAP_SCHEDULE_EXTENSION = "schedules" as const;

export interface HapScheduleContext {
  kind: typeof HAP_EXTENSION_KIND;
  extension: typeof HAP_SCHEDULE_EXTENSION;
  duid: string;
}

export interface RoborockSchedule {
  id: string;
  enabled: boolean;
  timer: unknown[];
}

export function parseServerTimers(value: unknown): RoborockSchedule[] {
  if (!Array.isArray(value)) return [];
  const result = new Map<string, RoborockSchedule>();
  for (const timer of value) {
    if (!Array.isArray(timer) || timer.length < 2) continue;
    const [rawId, rawStatus] = timer;
    if (
      (typeof rawId !== "string" && typeof rawId !== "number") ||
      (rawStatus !== "on" && rawStatus !== "off")
    ) {
      continue;
    }
    const id = String(rawId);
    if (!id || result.has(id)) continue;
    result.set(id, { id, enabled: rawStatus === "on", timer: [...timer] });
  }
  return [...result.values()];
}

export function isHapScheduleAccessory(accessory: PlatformAccessory): boolean {
  const context = (accessory.context ?? {}) as Partial<HapScheduleContext>;
  return (
    context.kind === HAP_EXTENSION_KIND &&
    context.extension === HAP_SCHEDULE_EXTENSION &&
    typeof context.duid === "string" &&
    context.duid.length > 0
  );
}

export default class RoborockHapScheduleAccessory {
  private readonly services = new Map<string, any>();
  private readonly writes = new Set<string>();
  private readonly suppression = new Map<
    string,
    { enabled: boolean; timestamp: number }
  >();
  private schedules = new Map<string, RoborockSchedule>();
  private vacuumName = "";

  constructor(
    private readonly platform: RoborockPlatform,
    public readonly accessory: PlatformAccessory,
    private readonly duid: string
  ) {
    accessory.context = {
      kind: HAP_EXTENSION_KIND,
      extension: HAP_SCHEDULE_EXTENSION,
      duid,
    } satisfies HapScheduleContext;
  }

  async initialize(vacuumName: string): Promise<void> {
    this.vacuumName = vacuumName;
    this.accessory.displayName = `${vacuumName} Schedules`;
    const info =
      this.accessory.getService(this.platform.Service.AccessoryInformation) ||
      this.accessory.addService(this.platform.Service.AccessoryInformation);
    info.setCharacteristic(
      this.platform.Characteristic.Manufacturer,
      "Roborock"
    );
    info.setCharacteristic(
      this.platform.Characteristic.Model,
      "Roborock Schedules"
    );
    info.setCharacteristic(
      this.platform.Characteristic.SerialNumber,
      this.duid
    );
    await this.refresh();
  }

  async refresh(): Promise<void> {
    const api = this.platform.roborockAPI as any;
    const raw = await getServerTimers(api, this.duid, {
      requestTimeoutMs: 10000,
    });

    this.platform.log.info(
      `Schedule discovery for ${this.duid}: ` +
        `type=${Array.isArray(raw) ? "array" : typeof raw}, ` +
        `value=${JSON.stringify(raw)}`
    );

    if (!Array.isArray(raw)) {
      this.platform.log.warn(
        `Unable to reliably read Roborock schedules for ${this.duid}: ` +
          `get_server_timer returned ${typeof raw}; preserving existing schedules.`
      );
      return;
    }

    this.sync(parseServerTimers(raw));
  }

  dispose(): void {
    this.writes.clear();
    this.suppression.clear();
  }

  private sync(schedules: RoborockSchedule[]): void {
    const ids = new Set(schedules.map((s) => s.id));

    for (let i = 0; i < schedules.length; i++) {
      const schedule = schedules[i];
      const subtype = `${SERVICE_PREFIX}${encodeURIComponent(schedule.id)}`;
      // Put the ordinal first so the Home app cannot make otherwise similar
      // schedules look identical after truncating long names. The Roborock
      // timer id remains in the visible name as a stable troubleshooting key.
      const displayName = `Schedule ${i + 1} — ${this.vacuumName} — ${schedule.id}`;

      let service =
        this.services.get(schedule.id) ||
        this.accessory.getServiceById(this.platform.Service.Switch, subtype);

      if (!service) {
        service = this.accessory.addService(
          this.platform.Service.Switch,
          displayName,
          subtype
        );
      }

      service.setCharacteristic(this.platform.Characteristic.Name, displayName);
      service.addOptionalCharacteristic(
        this.platform.Characteristic.ConfiguredName
      );
      service.setCharacteristic(
        this.platform.Characteristic.ConfiguredName,
        displayName
      );

      service
        .getCharacteristic(this.platform.Characteristic.On)
        .onSet((value) => this.setSchedule(schedule.id, Boolean(value)))
        .onGet(
          () => this.schedules.get(schedule.id)?.enabled ?? schedule.enabled
        );
      service.updateCharacteristic(
        this.platform.Characteristic.On,
        schedule.enabled
      );
      this.services.set(schedule.id, service);
    }

    for (const [id, service] of this.services) {
      if (!ids.has(id)) {
        this.accessory.removeService(service);
        this.services.delete(id);
      }
    }

    this.schedules = new Map(schedules.map((s) => [s.id, s]));
  }

  private async setSchedule(id: string, enabled: boolean): Promise<void> {
    const previous = this.schedules.get(id)?.enabled ?? !enabled;
    const now = Date.now();
    const last = this.suppression.get(id);

    if (
      last &&
      last.enabled === enabled &&
      now - last.timestamp < WRITE_SUPPRESSION_MS
    ) {
      return;
    }

    if (this.writes.has(id)) {
      this.updateService(id, previous);
      return;
    }

    this.writes.add(id);
    try {
      const api = this.platform.roborockAPI as any;
      await updateServerTimer(api, this.duid, id, enabled, {
        requestTimeoutMs: 10000,
      });

      if (!(await this.verify(api, id, enabled))) {
        this.platform.log.warn(
          `Roborock schedule ${id} did not reflect the server timer update for ${this.vacuumName}; retrying with the standard timer update command.`
        );

        await updateTimer(api, this.duid, id, enabled, {
          requestTimeoutMs: 10000,
        });

        if (!(await this.verify(api, id, enabled))) {
          throw new Error(
            `Roborock schedule ${id} still reports ${
              enabled ? "disabled" : "enabled"
            } after update.`
          );
        }
      }

      const timer = this.schedules.get(id)?.timer ?? [
        id,
        enabled ? "on" : "off",
      ];
      timer[1] = enabled ? "on" : "off";
      this.schedules.set(id, { id, enabled, timer });
      this.suppression.set(id, { enabled, timestamp: Date.now() });
      this.updateService(id, enabled);
    } catch (error) {
      this.updateService(id, previous);
      const message = error instanceof Error ? error.message : String(error);
      this.platform.log.error(
        `Unable to ${enabled ? "enable" : "disable"} Roborock schedule ${id}: ${message}`
      );
    } finally {
      this.writes.delete(id);
    }
  }

  private async verify(
    api: any,
    id: string,
    enabled: boolean
  ): Promise<boolean> {
    await new Promise((resolve) => setTimeout(resolve, VERIFY_DELAY_MS));
    const raw = await getServerTimers(api, this.duid, {
      requestTimeoutMs: 10000,
    });

    if (!Array.isArray(raw)) {
      return false;
    }

    const schedules = parseServerTimers(raw);
    this.sync(schedules);
    return this.schedules.get(id)?.enabled === enabled;
  }

  private updateService(id: string, enabled: boolean): void {
    this.services
      .get(id)
      ?.updateCharacteristic(this.platform.Characteristic.On, enabled);
  }
}
