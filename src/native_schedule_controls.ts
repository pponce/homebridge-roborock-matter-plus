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
type Control = "pause" | "delay" | "delayActive";
type Context = { kind: string; control: Control; duid: string | null };

export function isNativeScheduleControl(accessory: { context?: unknown }): boolean {
  const context = accessory.context as Partial<Context> | undefined;
  return context?.kind === KIND && ["pause", "delay", "delayActive"].includes(context.control || "") &&
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
    const wanted = new Map<string, Context>();
    const ids: Array<string | null> = [null, ...this.devices.keys()];
    for (const duid of ids) for (const control of enabled) {
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
    }
    if (!this.controller) return;
    for (const [uuid, context] of wanted) {
      let accessory = this.accessories.find((item) => item.UUID === uuid);
      const isNew = !accessory;
      const suffix = context.control === "pause" ? "Pause Until Tomorrow" : context.control === "delayActive" ? "Delay Active" : `Delay ${config.scheduleDelayMinutes ?? 60} Minutes`;
      const name = !devices.length && accessory ? accessory.displayName : `${this.name(context.duid)} ${suffix}`;
      if (!accessory) { accessory = new this.platform.api.platformAccessory(name, uuid); this.accessories.push(accessory); }
      accessory.context = context;
      accessory.displayName = name;
      const { Service, Characteristic } = this.platform;
      const info = accessory.getService(Service.AccessoryInformation) || accessory.addService(Service.AccessoryInformation);
      info.setCharacteristic(Characteristic.Manufacturer, "Roborock")
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
    if (!this.controller || context.control === "delay") return false;
    const ids = context.duid === null ? Object.keys(this.controller.state.robots) : [context.duid];
    return ids.some((id: string) => {
      const status = this.controller.status(id);
      return context.control === "pause" ? status.paused : status.delayed;
    });
  }
  private accept(accessory: PlatformAccessory, context: Context, value: boolean): void {
    if (this.disposed || !this.controller || (context.control === "delay" && !value)) return;
    const pressedAt = Date.now();
    const action = context.control === "pause" ? (value ? "pause" : "resume") : context.control === "delay" ? "delay" : value ? "startDelay" : "cancelDelay";
    clearTimeout(this.resetTimers.get(accessory.UUID));
    const timer = setTimeout(() => {
      this.resetTimers.delete(accessory.UUID);
      if (context.control === "delay") accessory.getService(this.platform.Service.Switch)?.updateCharacteristic(this.platform.Characteristic.On, false);
      else this.refresh();
    }, context.control === "delay" ? 1500 : 0);
    timer.unref(); this.resetTimers.set(accessory.UUID, timer);
    // Acknowledge the Home command promptly. The cloud operation may exceed
    // HAP's write timeout, so confirmed state is published when it finishes.
    void this.ready.then(async () => {
      if (this.disposed) return;
      const ids = context.duid === null
        ? [...new Set([...this.devices.keys(), ...(["resume", "cancelDelay"].includes(action) ? Object.keys(this.controller.state.robots) : [])])]
        : [context.duid];
      for (const id of ids) {
        try { await this.controller.execute(id, action, pressedAt); }
        catch (error) { this.platform.log.error(`${this.name(id)} schedule control failed: ${this.describeError(error)}`); }
      }
    }).catch((error) => this.platform.log.error(`Schedule control failed: ${this.describeError(error)}`)).finally(() => this.refresh());
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
  }
}
