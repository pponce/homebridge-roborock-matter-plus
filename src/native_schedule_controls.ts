import type RoborockPlatform from "./platform";
import type { PlatformAccessory } from "homebridge";
import type { ScheduleAccountCoordinator } from "./hap_schedule_accessory";
import { HAP_PLUGIN_IDENTIFIER, PLATFORM_NAME } from "./settings";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

const { NativeScheduleController } = require("../roborockLib/lib/nativeScheduleController");
const { ScheduleControlStore } = require("../roborockLib/lib/scheduleControlStore");
const { createNativeScheduleApi } = require("../roborockLib/lib/nativeScheduleApi");
const { redactSecrets } = require("../roborockLib/lib/redactSecrets");
const KIND = "nativeScheduleControl";
type Control = "pause" | "pauseUntilTomorrow" | "delay" | "delayActive";
type Context = { kind: string; control: Control; duid: string | null };

export function isNativeScheduleControl(accessory: { context?: unknown }): boolean {
  const context = accessory.context as Partial<Context> | undefined;
  return context?.kind === KIND && ["pause", "pauseUntilTomorrow", "delay", "delayActive"].includes(context.control || "") &&
    (context.control !== "pauseUntilTomorrow" || context.duid === null) &&
    (context.duid === null || typeof context.duid === "string");
}

export class NativeScheduleControls {
  private controller: any;
  private ready: Promise<void> = Promise.resolve();
  private started = false;
  private disposed = false;
  private devices = new Map<string, string>();
  private bindings = new Map<string, PlatformAccessory>();
  private resetTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private delayPulses = new Set<string | null>();
  private commandTail: Promise<void> = Promise.resolve();
  private pending = new Map<string, { token: object; value: boolean }>();
  private failedValues = new Map<string, boolean>();
  private pendingPausePreference?: { token: object; value: boolean };

  constructor(private readonly platform: RoborockPlatform, private readonly accessories: PlatformAccessory[], coordinator: ScheduleAccountCoordinator, storagePath: string) {
    const config = platform.platformConfig;
    if (typeof storagePath !== "string") return;
    const identity = createHash("sha256").update(`${config.email || ""}\n${config.baseURL || ""}\n${config.name || PLATFORM_NAME}`).digest("hex").slice(0, 16);
    const filename = join(storagePath, `roborock-schedule-controls-${identity}.json`);
    if (!config.enableSchedulePauseUntilTomorrow && !config.enableScheduleDelay && !existsSync(filename)) return;
    try {
      this.controller = new NativeScheduleController({
        api: createNativeScheduleApi(platform.roborockAPI, coordinator),
        store: new ScheduleControlStore(filename), config,
        changed: () => this.refresh(),
        log: (duid: string, message: string) => platform.log.info(`${this.name(duid)}: ${message}`),
      });
    } catch (error) {
      platform.log.error(`Schedule controls could not load their saved state: ${this.describeError(error)}`);
    }
  }
  get size(): number { return this.bindings.size; }
  private name(duid: string | null): string {
    return duid === null ? "All Vacuums" : this.devices.get(duid) || this.platform.roborockAPI.getVacuumDeviceInfo?.(duid, "name") || "Roborock";
  }
  private describeError(error: unknown): string {
    return String(redactSecrets(error instanceof Error ? error.message : String(error)));
  }
  sync(devices: any[]): void {
    if (this.disposed) return;
    if (devices.length) this.devices = new Map<string, string>(devices.filter((d) => d?.duid).map((d) => [String(d.duid), String(d.name || "Roborock")]));
    if (!devices.length && !this.devices.size) {
      for (const accessory of this.accessories) {
        if (isNativeScheduleControl(accessory) && accessory.context.duid) this.devices.set(accessory.context.duid, "Roborock");
      }
    }
    const config = this.platform.platformConfig;
    const enabled: Control[] = [];
    if (config.enableSchedulePauseUntilTomorrow === true) enabled.push("pause");
    if (config.enableScheduleDelay === true) enabled.push("delay", "delayActive");
    if (enabled.length) enabled.push("pauseUntilTomorrow");
    const wanted = new Map<string, Context>();
    const ids: Array<string | null> = [null, ...this.devices.keys()];
    for (const duid of ids) for (const control of enabled) {
      if (control === "pauseUntilTomorrow" && duid !== null) continue;
      const uuid = this.platform.api.hap.uuid.generate(`hap:roborock:native-schedule:${duid === null ? "all" : `robot:${duid}`}:${control}`);
      wanted.set(uuid, { kind: KIND, control, duid });
    }
    for (const accessory of [...this.accessories]) {
      if (!isNativeScheduleControl(accessory) || wanted.has(accessory.UUID)) continue;
      // Empty discovery is not evidence that a robot disappeared.
      const context = accessory.context as Context;
      if (!devices.length && enabled.includes(context.control)) continue;
      this.platform.api.unregisterPlatformAccessories(HAP_PLUGIN_IDENTIFIER, PLATFORM_NAME, [accessory]);
      this.accessories.splice(this.accessories.indexOf(accessory), 1);
      this.bindings.delete(accessory.UUID);
      clearTimeout(this.resetTimers.get(accessory.UUID)); this.resetTimers.delete(accessory.UUID);
      if (context.control === "delay") this.delayPulses.delete(context.duid);
    }
    if (!this.controller) return;
    for (const [uuid, context] of wanted) {
      let accessory = this.accessories.find((item) => item.UUID === uuid);
      const isNew = !accessory;
      const suffix = context.control === "pause" ? "Pause Active" : context.control === "delayActive" ? "Delay Active" : `Delay ${config.scheduleDelayMinutes ?? 60} Minutes`;
      const name = context.control === "pauseUntilTomorrow" ? "Pause Until Tomorrow"
        : !devices.length && accessory ? accessory.displayName : `${this.name(context.duid)} ${suffix}`;
      if (!accessory) { accessory = new this.platform.api.platformAccessory(name, uuid); this.accessories.push(accessory); }
      accessory.context = context;
      accessory.displayName = name;
      const { Service, Characteristic } = this.platform;
      const info = accessory.getService(Service.AccessoryInformation) || accessory.addService(Service.AccessoryInformation);
      info.setCharacteristic(Characteristic.Manufacturer, "Roborock")
        .setCharacteristic(Characteristic.Name, name)
        .setCharacteristic(Characteristic.Model, "Schedule Controls")
        .setCharacteristic(Characteristic.SerialNumber, uuid);
      const service = accessory.getService(Service.Switch) || accessory.addService(Service.Switch, name);
      service.setCharacteristic(Characteristic.Name, name);
      const characteristic = service.getCharacteristic(Characteristic.On);
      characteristic.removeAllListeners("get"); characteristic.removeAllListeners("set");
      characteristic.onGet(() => this.value(context));
      characteristic.onSet((value) => this.accept(accessory!, context, Boolean(value)));
      this.bindings.set(uuid, accessory);
      if (isNew) {
        this.platform.api.registerPlatformAccessories(HAP_PLUGIN_IDENTIFIER, PLATFORM_NAME, [accessory]);
        this.platform.log.info(`Added '${name}'.`);
      }
    }
    if (!this.started) {
      this.started = true;
      this.ready = this.controller.initialize().catch((error: unknown) => {
        this.platform.log.error(`Schedule recovery needs attention: ${this.describeError(error)}`);
      });
    }
    this.refresh();
  }
  private value(context: Context): boolean {
    if (!this.controller) return false;
    if (context.control === "pauseUntilTomorrow") return this.pendingPausePreference?.value ?? this.controller.pauseUntilTomorrow;
    if (context.control === "delay") return this.delayPulses.has(context.duid);
    const ids = context.duid === null ? [...new Set([...this.devices.keys(), ...Object.keys(this.controller.state.robots)])] : [context.duid];
    return ids.some((id: string) => {
      const key = JSON.stringify([id, context.control]);
      const pending = this.pending.get(key);
      if (pending) return pending.value;
      const status = this.controller.status(id);
      // A failed pause can leave a tentative journal flag while recovery restores
      // partially changed schedules. Do not display that flag as a successful ON.
      if (this.failedValues.has(key)) {
        if (status.recovering) return this.failedValues.get(key)!;
        this.failedValues.delete(key);
      }
      return context.control === "pause" ? status.paused : status.delayed;
    });
  }
  private accept(accessory: PlatformAccessory, context: Context, value: boolean): void {
    if (this.disposed || !this.controller || (context.control === "delay" && !value)) return;
    if (context.control === "pauseUntilTomorrow") { this.acceptPausePreference(value); return; }
    const pressedAt = Date.now();
    const action = context.control === "pause" ? (value ? "pause" : "resume") : context.control === "delay" ? "delay" : value ? "startDelay" : "cancelDelay";
    const ids = context.duid === null
      ? [...new Set([...this.devices.keys(), ...(["resume", "cancelDelay"].includes(action) ? Object.keys(this.controller.state.robots) : [])])]
      : [context.duid];
    const token = {};
    if (context.control !== "delay") {
      for (const id of ids) this.pending.set(JSON.stringify([id, context.control]), { token, value });
    }
    clearTimeout(this.resetTimers.get(accessory.UUID));
    if (context.control === "delay") this.delayPulses.add(context.duid);
    const timer = setTimeout(() => {
      this.resetTimers.delete(accessory.UUID);
      if (context.control === "delay") {
        this.delayPulses.delete(context.duid);
        // A GET may already have cached OFF. Force a notification so Home's
        // optimistic ON is reset even when the cached value is unchanged.
        accessory.getService(this.platform.Service.Switch)?.getCharacteristic(this.platform.Characteristic.On).sendEventNotification(false);
      } else this.refresh();
    }, context.control === "delay" ? 1500 : 0);
    timer.unref(); this.resetTimers.set(accessory.UUID, timer);
    // GETs and refreshes use the requested state immediately, including the
    // aggregate tile. Serialize whole requests so all-vacuum and individual
    // presses execute in order; older completions cannot clear newer intent.
    this.commandTail = this.commandTail.then(() => this.ready).then(async () => {
      if (this.disposed) return;
      for (const id of ids) {
        if (this.disposed) break;
        const key = JSON.stringify([id, context.control]);
        const status = this.controller.status(id);
        const previous = status.recovering && this.failedValues.has(key) ? this.failedValues.get(key)!
          : Boolean(context.control === "pause" ? status.paused : status.delayed);
        try {
          await this.controller.execute(id, action, pressedAt);
          this.failedValues.delete(key);
        } catch (error) {
          const status = this.controller.status(id);
          // An unsuccessful ON can still leave edited times or stopped timers.
          // Keep Delay Active visible until rollback has actually completed.
          const unresolvedDelay = context.control === "delayActive" && status.recovering && status.delayed;
          const fallback = Boolean(previous || unresolvedDelay);
          if (context.control !== "delay") this.failedValues.set(key, fallback);
          const newer = this.pending.get(key)?.token !== token;
          this.platform.log.error(`[SCHEDULE CONTROL FAILED] ${this.name(id)}: ${action}: ${this.describeError(error)}. ` +
            (context.control === "delay" ? "Delay request failed." : newer ? "A newer switch request is still pending." : unresolvedDelay ? "Delay Active remains ON until schedule restoration finishes." : `Switch reverted to ${fallback ? "ON" : "OFF"}.`) +
            (status.recovering ? " Schedule restoration is still pending; saved originals will be retried." : ""));
        } finally {
          if (this.pending.get(key)?.token === token) this.pending.delete(key);
          this.refresh();
        }
      }
    }).catch((error) => {
      for (const id of ids) {
        const key = JSON.stringify([id, context.control]);
        if (this.pending.get(key)?.token === token) this.pending.delete(key);
      }
      this.platform.log.error(`[SCHEDULE CONTROL FAILED] ${this.name(context.duid)}: ${action}: ${this.describeError(error)}. Switches refreshed from saved state.`);
    }).finally(() => this.refresh());
  }
  private acceptPausePreference(value: boolean): void {
    const token = {};
    this.pendingPausePreference = { token, value };
    // Keep preference changes ordered with presses, but do not contact the cloud
    // for a local setting. Failed persistence restores its previous saved value.
    this.commandTail = this.commandTail.then(() => this.ready).then(async () => {
      if (!this.disposed) await this.controller.setPauseUntilTomorrow(value);
    }).catch((error) => {
      this.platform.log.error(`[SCHEDULE CONTROL FAILED] Pause Until Tomorrow: ${this.describeError(error)}. ` +
        (this.pendingPausePreference?.token !== token ? "A newer switch request is still pending." : `Switch reverted to ${this.controller.pauseUntilTomorrow ? "ON" : "OFF"}.`));
    }).finally(() => {
      if (this.pendingPausePreference?.token === token) this.pendingPausePreference = undefined;
      this.refresh();
    });
  }
  private refresh(): void {
    if (this.disposed) return;
    for (const accessory of this.bindings.values()) {
      const context = accessory.context as Context;
      if (context.control !== "delay") accessory.getService(this.platform.Service.Switch)?.updateCharacteristic(this.platform.Characteristic.On, this.value(context));
    }
  }
  dispose(): void {
    this.disposed = true; this.controller?.dispose();
    for (const timer of this.resetTimers.values()) clearTimeout(timer);
    this.resetTimers.clear();
    this.delayPulses.clear();
    this.pending.clear(); this.failedValues.clear();
    this.pendingPausePreference = undefined;
  }
}
