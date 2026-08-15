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
 * The platform owns one schedule coordinator per vacuum.
 * Each Roborock timer is exposed as its own HAP switch accessory.
 *
 * Schedule accessories are intentionally named from the vacuum name so the
 * Home app presents the schedules together under the vacuum's schedule
 * grouping:
 *
 *   <vacuum> Schedule 1
 *   <vacuum> Schedule 2
 *   ...
 *
 * The schedule ID remains part of the accessory UUID/context and is therefore
 * stable even if the displayed name changes.
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

  async initialize(vacuumName: string): Promise<boolean> {
    this.vacuumName = vacuumName;

    const displayName = `${vacuumName} Schedules`;
    this.managerAccessory.displayName = displayName;

    this.managerAccessory.context = {
      kind: HAP_EXTENSION_KIND,
      extension: HAP_SCHEDULE_EXTENSION,
      duid: this.duid,
    } satisfies HapScheduleContext;

    const info =
      this.managerAccessory.getService(
        this.platform.Service.AccessoryInformation
      ) ||
      this.managerAccessory.addService(
        this.platform.Service.AccessoryInformation
      );

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
      `${this.duid}:schedules`
    );
    info.setCharacteristic(
      this.platform.Characteristic.Name,
      displayName
    );

    // Do not remove existing schedule switches before discovery succeeds.
    // A transient offline/error response must preserve an already-valid
    // schedule group.
    return this.refresh();
  }

  async refresh(): Promise<boolean> {
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
      return this.scheduleAccessories.size > 0;
    }

    const schedules = parseServerTimers(raw);
    this.platform.log.info(
      `Schedule parser: parsed ${this.duid}; result count=${schedules.length}.`
    );

    this.sync(schedules);

    return schedules.length > 0;
  }

  dispose(): void {
    for (const schedule of this.scheduleAccessories.values()) {
      schedule.dispose();
    }

    this.scheduleAccessories.clear();

    // Keep the manager accessory registered so it can be rebuilt
    // when schedules are enabled again.
    for (const service of [...this.managerAccessory.services]) {
      if (service.UUID === this.platform.Service.Switch.UUID) {
        this.managerAccessory.removeService(service);
      }
    }

    this.platform.api.updatePlatformAccessories([this.managerAccessory]);
  }

  private sync(schedules: RoborockSchedule[]): void {
    this.platform.log.info(
      `Schedule sync: ${this.duid} received ${schedules.length} parsed schedule(s).`
    );

    const ids = new Set(schedules.map((schedule) => schedule.id));

    for (let i = 0; i < schedules.length; i++) {
      const schedule = schedules[i];
      const displayName =
        `${this.vacuumName} Schedule ${i + 1}`;
      const existing = this.scheduleAccessories.get(schedule.id);

      if (existing) {
        existing.updateIdentity(displayName, schedule);
        continue;
      }

      const child = new RoborockHapScheduleSwitchAccessory(
        this.platform,
        this.managerAccessory,
        this.duid,
        schedule.id
      );

      child.initialize(displayName, schedule);
      this.scheduleAccessories.set(schedule.id, child);

      this.platform.log.info(
        `Schedule sync: ${this.scheduleAccessories.has(schedule.id) ? "restored" : "added"} HAP switch '${displayName}' for ${schedule.id}.`
      );
    }

    for (const [id, child] of this.scheduleAccessories) {
      if (ids.has(id)) continue;

      this.platform.log.info(
        `Schedule sync: removing stale HAP switch for ${id}.`
      );
      child.dispose();

      const service = this.managerAccessory.getServiceById(
        this.platform.Service.Switch,
        `${SERVICE_PREFIX}${encodeURIComponent(id)}`
      );

      if (service) {
        this.managerAccessory.removeService(service);
      }

      this.scheduleAccessories.delete(id);
      this.platform.api.updatePlatformAccessories([this.managerAccessory]);
    }
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

  // If Roborock rejects/doesn't reflect a command, don't allow HomeKit
  // to immediately hammer the same command over and over.
  private readonly failedCommands = new Map<
    string,
    { enabled: boolean; timestamp: number }
  >();

  private static readonly FAILED_COMMAND_COOLDOWN_MS = 30000;

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
    this.failedCommands.clear();
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

    const failed = this.failedCommands.get(this.scheduleId);
    if (
      failed &&
      failed.enabled === enabled &&
      now - failed.timestamp <
        RoborockHapScheduleSwitchAccessory.FAILED_COMMAND_COOLDOWN_MS
    ) {
      this.updateService(previous);
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

      this.failedCommands.delete(this.scheduleId);

      this.suppression.set(this.scheduleId, {
        enabled,
        timestamp: Date.now(),
      });
      this.updateService(enabled);
    } catch (error) {
      this.updateService(previous);

      this.failedCommands.set(this.scheduleId, {
        enabled,
        timestamp: Date.now(),
      });

      const message = error instanceof Error ? error.message : String(error);

      this.platform.log.warn(
        `Unable to ${enabled ? "enable" : "disable"} Roborock schedule ${this.scheduleId}: ${message}. ` +
        `Further attempts for this same state are suppressed for ` +
        `${RoborockHapScheduleSwitchAccessory.FAILED_COMMAND_COOLDOWN_MS / 1000}s.`
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
