import { PlatformAccessory } from "homebridge";
import RoborockPlatform from "./platform";
import { getServerTimers, updateServerTimer, updateTimer } from "./hap_schedule_api";
import { HAP_PLUGIN_IDENTIFIER, PLATFORM_NAME } from "./settings";

const VERIFY_DELAY_MS = 3000;
const WRITE_SUPPRESSION_MS = 5000;
const SERVICE_PREFIX = "roborock-schedule-";

export const HAP_EXTENSION_KIND = "hapExtension" as const;
export const HAP_SCHEDULE_EXTENSION = "schedules" as const;

export interface HapScheduleContext {
  kind: typeof HAP_EXTENSION_KIND;
  extension: typeof HAP_SCHEDULE_EXTENSION;
  duid: string;
  scheduleId?: string;
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
    result.set(id, {
      id,
      enabled: rawStatus === "on",
      timer: [...timer],
    });
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

/**
 * The platform still owns one lightweight schedule coordinator per vacuum.
 * The coordinator's old single accessory is deliberately not exposed to
 * HomeKit. Each Roborock timer is its own PlatformAccessory so Apple Home gets
 * one tile/name per schedule instead of collapsing all switches under
 * "<vacuum> Schedules".
 */
export default class RoborockHapScheduleAccessory {
  private readonly scheduleAccessories = new Map<
    string,
    RoborockHapScheduleSwitchAccessory
  >();
  private readonly managerAccessory: PlatformAccessory;
  private vacuumName = "";
  private managerRemoved = false;

  constructor(
    private readonly platform: RoborockPlatform,
    accessory: PlatformAccessory,
    private readonly duid: string
  ) {
    this.managerAccessory = accessory;
    accessory.context = {
      kind: HAP_EXTENSION_KIND,
      extension: HAP_SCHEDULE_EXTENSION,
      duid,
    } satisfies HapScheduleContext;
  }

  async initialize(vacuumName: string): Promise<void> {
    this.vacuumName = vacuumName;
    this.removeCoordinatorAccessory();
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

    const schedules = parseServerTimers(raw);
    this.platform.log.info(
      `Schedule parser: parsed ${this.duid}; result count=${schedules.length}.`
    );
    this.sync(schedules);
  }

  dispose(): void {
    for (const schedule of this.scheduleAccessories.values()) {
      schedule.dispose();
    }
    this.scheduleAccessories.clear();
  }

  private sync(schedules: RoborockSchedule[]): void {
    this.platform.log.info(
      `Schedule sync: ${this.duid} received ${schedules.length} parsed schedule(s).`
    );

    const ids = new Set(schedules.map((schedule) => schedule.id));

    for (let i = 0; i < schedules.length; i++) {
      const schedule = schedules[i];
      const displayName = `${this.vacuumName} Schedule ${i + 1}`;
      const existing = this.scheduleAccessories.get(schedule.id);

      if (existing) {
        existing.updateIdentity(displayName, schedule);
        continue;
      }

      const uuid = this.platform.api.hap.uuid.generate(
        `hap:roborock:schedule:${this.duid}:${schedule.id}`
      );

      const cached = this.findCachedScheduleAccessory(uuid, schedule.id);
      const accessory =
        cached ||
        new this.platform.api.platformAccessory(displayName, uuid);
      const isNew = !cached;

      const child = new RoborockHapScheduleSwitchAccessory(
        this.platform,
        accessory,
        this.duid,
        schedule.id
      );

      child.initialize(displayName, schedule);
      this.scheduleAccessories.set(schedule.id, child);

      this.platform.log.info(
        `Schedule sync: ${isNew ? "adding" : "restoring"} HAP accessory '${displayName}' for ${schedule.id}.`
      );

      if (isNew) {
        this.platform.api.registerPlatformAccessories(
          HAP_PLUGIN_IDENTIFIER,
          PLATFORM_NAME,
          [accessory]
        );
      }
    }

    for (const [id, child] of this.scheduleAccessories) {
      if (ids.has(id)) continue;

      this.platform.log.info(
        `Schedule sync: removing stale HAP accessory for ${id}.`
      );
      child.dispose();
      this.platform.api.unregisterPlatformAccessories(
        HAP_PLUGIN_IDENTIFIER,
        PLATFORM_NAME,
        [child.accessory]
      );
      this.removeFromPlatformCache(child.accessory);
      this.scheduleAccessories.delete(id);
    }
  }

  private findCachedScheduleAccessory(
    uuid: string,
    scheduleId: string
  ): PlatformAccessory | null {
    const cachedAccessories = ((this.platform as any).accessories ?? []) as PlatformAccessory[];
    return (
      cachedAccessories.find((accessory) => {
        if (accessory.UUID !== uuid || !isHapScheduleAccessory(accessory)) {
          return false;
        }
        const context = accessory.context as Partial<HapScheduleContext>;
        return context.duid === this.duid && context.scheduleId === scheduleId;
      }) ?? null
    );
  }

  private removeCoordinatorAccessory(): void {
    if (this.managerRemoved) return;
    this.managerRemoved = true;

    // This accessory was created by the existing platform.ts coordinator path.
    // It is the legacy "<vacuum> Schedules" tile. Remove it before publishing
    // the real per-schedule accessories.
    this.platform.api.unregisterPlatformAccessories(
      HAP_PLUGIN_IDENTIFIER,
      PLATFORM_NAME,
      [this.managerAccessory]
    );
    this.removeFromPlatformCache(this.managerAccessory);
  }

  private removeFromPlatformCache(accessory: PlatformAccessory): void {
    const cachedAccessories = ((this.platform as any).accessories ?? []) as PlatformAccessory[];
    const index = cachedAccessories.indexOf(accessory);
    if (index >= 0) {
      cachedAccessories.splice(index, 1);
    }
  }
}

class RoborockHapScheduleSwitchAccessory {
  private readonly writes = new Set<string>();
  private readonly suppression = new Map<
    string,
    { enabled: boolean; timestamp: number }
  >();
  private schedule: RoborockSchedule;

  constructor(
    private readonly platform: RoborockPlatform,
    public readonly accessory: PlatformAccessory,
    private readonly duid: string,
    private readonly scheduleId: string
  ) {
    this.schedule = {
      id: scheduleId,
      enabled: false,
      timer: [scheduleId, "off"],
    };

    accessory.context = {
      kind: HAP_EXTENSION_KIND,
      extension: HAP_SCHEDULE_EXTENSION,
      duid,
      scheduleId,
    } satisfies HapScheduleContext;
  }

  initialize(displayName: string, schedule: RoborockSchedule): void {
    this.updateIdentity(displayName, schedule);

    const info =
      this.accessory.getService(this.platform.Service.AccessoryInformation) ||
      this.accessory.addService(this.platform.Service.AccessoryInformation);
    info.setCharacteristic(this.platform.Characteristic.Manufacturer, "Roborock");
    info.setCharacteristic(this.platform.Characteristic.Model, "Roborock Schedule");
    info.setCharacteristic(
      this.platform.Characteristic.SerialNumber,
      `${this.duid}:${this.scheduleId}`
    );

    const subtype = `${SERVICE_PREFIX}${encodeURIComponent(this.scheduleId)}`;
    let service = this.accessory.getServiceById(
      this.platform.Service.Switch,
      subtype
    );

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
      .onSet((value) => this.setSchedule(Boolean(value)))
      .onGet(() => this.schedule.enabled);
    service.updateCharacteristic(
      this.platform.Characteristic.On,
      schedule.enabled
    );
  }

  updateIdentity(displayName: string, schedule: RoborockSchedule): void {
    this.schedule = { ...schedule, timer: [...schedule.timer] };
    this.accessory.displayName = displayName;

    const switchService = this.accessory.getServiceById(
      this.platform.Service.Switch,
      `${SERVICE_PREFIX}${encodeURIComponent(this.scheduleId)}`
    );
    if (switchService) {
      switchService.setCharacteristic(
        this.platform.Characteristic.Name,
        displayName
      );
      switchService.addOptionalCharacteristic(
        this.platform.Characteristic.ConfiguredName
      );
      switchService.setCharacteristic(
        this.platform.Characteristic.ConfiguredName,
        displayName
      );
      switchService.updateCharacteristic(
        this.platform.Characteristic.On,
        schedule.enabled
      );
    }
  }

  dispose(): void {
    this.writes.clear();
    this.suppression.clear();
  }

  private async setSchedule(enabled: boolean): Promise<void> {
    const previous = this.schedule.enabled;
    const now = Date.now();
    const last = this.suppression.get(this.scheduleId);

    if (
      last &&
      last.enabled === enabled &&
      now - last.timestamp < WRITE_SUPPRESSION_MS
    ) {
      return;
    }

    if (this.writes.has(this.scheduleId)) {
      this.updateService(previous);
      return;
    }

    this.writes.add(this.scheduleId);

    try {
      const api = this.platform.roborockAPI as any;

      this.platform.log.info(
        `Schedule command: ${enabled ? "enabling" : "disabling"} ${this.duid}/${this.scheduleId}; params=[[${JSON.stringify(this.scheduleId)}, ${JSON.stringify(enabled ? "on" : "off")}]].`
      );

      await updateServerTimer(api, this.duid, this.scheduleId, enabled, {
        requestTimeoutMs: 10000,
      });

      if (!(await this.verify(api, enabled))) {
        this.platform.log.warn(
          `Roborock schedule ${this.scheduleId} did not reflect upd_server_timer; trying upd_timer fallback.`
        );

        await updateTimer(api, this.duid, this.scheduleId, enabled, {
          requestTimeoutMs: 10000,
        });

        if (!(await this.verify(api, enabled))) {
          throw new Error(
            `Roborock did not confirm schedule ${this.scheduleId} as ${enabled ? "enabled" : "disabled"}`
          );
        }
      }

      this.schedule.enabled = enabled;
      this.schedule.timer[1] = enabled ? "on" : "off";
      this.suppression.set(this.scheduleId, {
        enabled,
        timestamp: Date.now(),
      });
      this.updateService(enabled);
    } catch (error) {
      this.updateService(previous);
      const message = error instanceof Error ? error.message : String(error);
      this.platform.log.error(
        `Unable to ${enabled ? "enable" : "disable"} Roborock schedule ${this.scheduleId}: ${message}`
      );
    } finally {
      this.writes.delete(this.scheduleId);
    }
  }

  private async verify(api: any, enabled: boolean): Promise<boolean> {
    await new Promise((resolve) => setTimeout(resolve, VERIFY_DELAY_MS));
    const raw = await getServerTimers(api, this.duid, {
      requestTimeoutMs: 10000,
    });

    if (!Array.isArray(raw)) {
      return false;
    }

    const schedules = parseServerTimers(raw);
    const current = schedules.find(
      (schedule) => schedule.id === this.scheduleId
    );
    if (!current) {
      return false;
    }

    this.schedule = { ...current, timer: [...current.timer] };
    this.updateService(current.enabled);
    return current.enabled === enabled;
  }

  private updateService(enabled: boolean): void {
    const service = this.accessory.getServiceById(
      this.platform.Service.Switch,
      `${SERVICE_PREFIX}${encodeURIComponent(this.scheduleId)}`
    );
    service?.updateCharacteristic(this.platform.Characteristic.On, enabled);
  }
}
