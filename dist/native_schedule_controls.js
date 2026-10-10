"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NativeScheduleControls = void 0;
exports.isNativeScheduleControl = isNativeScheduleControl;
const settings_1 = require("./settings");
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const { NativeScheduleController } = require("../roborockLib/lib/nativeScheduleController");
const { ScheduleControlStore } = require("../roborockLib/lib/scheduleControlStore");
const { createNativeScheduleApi } = require("../roborockLib/lib/nativeScheduleApi");
const { scheduleControlOptions } = require("../roborockLib/lib/scheduleControlOptions");
const { redactSecrets } = require("../roborockLib/lib/redactSecrets");
const KIND = "nativeScheduleControl";
function isNativeScheduleControl(accessory) {
    const context = accessory.context;
    return (context === null || context === void 0 ? void 0 : context.kind) === KIND && ["pause", "pauseUntilTomorrow", "delay", "delayActive"].includes(context.control || "") &&
        (context.control !== "pauseUntilTomorrow" || context.duid === null) &&
        (context.duid === null || typeof context.duid === "string");
}
class NativeScheduleControls {
    constructor(platform, accessories, coordinator, storagePath) {
        this.platform = platform;
        this.accessories = accessories;
        this.ready = Promise.resolve();
        this.started = false;
        this.disposed = false;
        this.devices = new Map();
        this.bindings = new Map();
        this.resetTimers = new Map();
        this.delayPulses = new Set();
        this.commandTail = Promise.resolve();
        this.pending = new Map();
        this.failedValues = new Map();
        const config = platform.platformConfig;
        if (typeof storagePath !== "string")
            return;
        const identity = (0, node_crypto_1.createHash)("sha256").update(`${config.email || ""}\n${config.baseURL || ""}\n${config.name || settings_1.PLATFORM_NAME}`).digest("hex").slice(0, 16);
        const filename = (0, node_path_1.join)(storagePath, `roborock-schedule-controls-${identity}.json`);
        const options = scheduleControlOptions(config);
        if (!options.pauseEnabled && !options.delayEnabled && !(0, node_fs_1.existsSync)(filename))
            return;
        try {
            this.controller = new NativeScheduleController({
                api: createNativeScheduleApi(platform.roborockAPI, coordinator),
                store: new ScheduleControlStore(filename), config,
                changed: () => this.refresh(),
                log: (duid, message) => platform.log.info(`${this.name(duid)}: ${message}`),
            });
        }
        catch (error) {
            platform.log.error(`Schedule controls could not load their saved state: ${this.describeError(error)}`);
        }
    }
    get size() { return this.bindings.size; }
    name(duid) {
        var _a, _b;
        return duid === null ? "All Vacuums" : this.devices.get(duid) || ((_b = (_a = this.platform.roborockAPI).getVacuumDeviceInfo) === null || _b === void 0 ? void 0 : _b.call(_a, duid, "name")) || "Roborock";
    }
    describeError(error) {
        return String(redactSecrets(error instanceof Error ? error.message : String(error)));
    }
    sync(devices) {
        var _a;
        if (this.disposed)
            return;
        if (devices.length)
            this.devices = new Map(devices.filter((d) => d === null || d === void 0 ? void 0 : d.duid).map((d) => [String(d.duid), String(d.name || "Roborock")]));
        if (!devices.length && !this.devices.size) {
            for (const accessory of this.accessories) {
                if (isNativeScheduleControl(accessory) && accessory.context.duid)
                    this.devices.set(accessory.context.duid, "Roborock");
            }
        }
        const config = this.platform.platformConfig;
        const options = scheduleControlOptions(config);
        const selected = ({ control, duid }) => {
            if (control === "pauseUntilTomorrow")
                return duid === null && (options.pauseEnabled || options.delayEnabled);
            if (control === "pause")
                return duid === null ? options.pauseAll : options.pausePerVacuum;
            return duid === null ? options.delayAll : options.delayPerVacuum;
        };
        const controls = ["pause", "delay", "delayActive", "pauseUntilTomorrow"];
        const wanted = new Map();
        const ids = [null, ...this.devices.keys()];
        for (const duid of ids)
            for (const control of controls) {
                if (!selected({ control, duid }))
                    continue;
                const uuid = this.platform.api.hap.uuid.generate(`hap:roborock:native-schedule:${duid === null ? "all" : `robot:${duid}`}:${control}`);
                wanted.set(uuid, { kind: KIND, control, duid });
            }
        for (const accessory of [...this.accessories]) {
            if (!isNativeScheduleControl(accessory) || wanted.has(accessory.UUID))
                continue;
            // Empty discovery is not evidence that a robot disappeared.
            const context = accessory.context;
            if (!devices.length && selected(context))
                continue;
            this.platform.api.unregisterPlatformAccessories(settings_1.HAP_PLUGIN_IDENTIFIER, settings_1.PLATFORM_NAME, [accessory]);
            this.accessories.splice(this.accessories.indexOf(accessory), 1);
            this.bindings.delete(accessory.UUID);
            clearTimeout(this.resetTimers.get(accessory.UUID));
            this.resetTimers.delete(accessory.UUID);
            if (context.control === "delay")
                this.delayPulses.delete(context.duid);
        }
        if (!this.controller)
            return;
        for (const [uuid, context] of wanted) {
            let accessory = this.accessories.find((item) => item.UUID === uuid);
            const isNew = !accessory;
            const suffix = context.control === "pause" ? "Pause Active" : context.control === "delayActive" ? "Delay Active" : `Delay ${(_a = config.scheduleDelayMinutes) !== null && _a !== void 0 ? _a : 60} Minutes`;
            const name = context.control === "pauseUntilTomorrow" ? "Pause Until Tomorrow"
                : !devices.length && accessory ? accessory.displayName : `${this.name(context.duid)} ${suffix}`;
            if (!accessory) {
                accessory = new this.platform.api.platformAccessory(name, uuid);
                this.accessories.push(accessory);
            }
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
            characteristic.removeAllListeners("get");
            characteristic.removeAllListeners("set");
            characteristic.onGet(() => this.value(context));
            characteristic.onSet((value) => this.accept(accessory, context, Boolean(value)));
            this.bindings.set(uuid, accessory);
            if (isNew) {
                this.platform.api.registerPlatformAccessories(settings_1.HAP_PLUGIN_IDENTIFIER, settings_1.PLATFORM_NAME, [accessory]);
                this.platform.log.info(`Added '${name}'.`);
            }
        }
        if (!this.started) {
            this.started = true;
            this.ready = this.controller.initialize().catch((error) => {
                this.platform.log.error(`Schedule recovery needs attention: ${this.describeError(error)}`);
            });
        }
        this.refresh();
    }
    value(context) {
        var _a, _b;
        if (!this.controller)
            return false;
        if (context.control === "pauseUntilTomorrow")
            return (_b = (_a = this.pendingPausePreference) === null || _a === void 0 ? void 0 : _a.value) !== null && _b !== void 0 ? _b : this.controller.pauseUntilTomorrow;
        if (context.control === "delay")
            return this.delayPulses.has(context.duid);
        const ids = context.duid === null ? [...new Set([...this.devices.keys(), ...Object.keys(this.controller.state.robots)])] : [context.duid];
        return ids.some((id) => {
            const key = JSON.stringify([id, context.control]);
            const pending = this.pending.get(key);
            if (pending)
                return pending.value;
            const status = this.controller.status(id);
            // A failed pause can leave a tentative journal flag while recovery restores
            // partially changed schedules. Do not display that flag as a successful ON.
            if (this.failedValues.has(key)) {
                if (status.recovering)
                    return this.failedValues.get(key);
                this.failedValues.delete(key);
            }
            return context.control === "pause" ? status.paused : status.delayed;
        });
    }
    accept(accessory, context, value) {
        if (this.disposed || !this.controller || (context.control === "delay" && !value))
            return;
        if (context.control === "pauseUntilTomorrow") {
            this.acceptPausePreference(value);
            return;
        }
        const pressedAt = Date.now();
        const action = context.control === "pause" ? (value ? "pause" : "resume") : context.control === "delay" ? "delay" : value ? "startDelay" : "cancelDelay";
        const ids = context.duid === null
            ? [...new Set([...this.devices.keys(), ...(["resume", "cancelDelay"].includes(action) ? Object.keys(this.controller.state.robots) : [])])]
            : [context.duid];
        const token = {};
        if (context.control !== "delay") {
            for (const id of ids)
                this.pending.set(JSON.stringify([id, context.control]), { token, value });
        }
        clearTimeout(this.resetTimers.get(accessory.UUID));
        if (context.control === "delay")
            this.delayPulses.add(context.duid);
        const timer = setTimeout(() => {
            var _a;
            this.resetTimers.delete(accessory.UUID);
            if (context.control === "delay") {
                this.delayPulses.delete(context.duid);
                // A GET may already have cached OFF. Force a notification so Home's
                // optimistic ON is reset even when the cached value is unchanged.
                (_a = accessory.getService(this.platform.Service.Switch)) === null || _a === void 0 ? void 0 : _a.getCharacteristic(this.platform.Characteristic.On).sendEventNotification(false);
            }
            else
                this.refresh();
        }, context.control === "delay" ? 1500 : 0);
        timer.unref();
        this.resetTimers.set(accessory.UUID, timer);
        // GETs and refreshes use the requested state immediately, including the
        // aggregate tile. Serialize whole requests so all-vacuum and individual
        // presses execute in order; older completions cannot clear newer intent.
        this.commandTail = this.commandTail.then(() => this.ready).then(async () => {
            var _a, _b;
            if (this.disposed)
                return;
            for (const id of ids) {
                if (this.disposed)
                    break;
                const key = JSON.stringify([id, context.control]);
                const status = this.controller.status(id);
                const previous = status.recovering && this.failedValues.has(key) ? this.failedValues.get(key)
                    : Boolean(context.control === "pause" ? status.paused : status.delayed);
                try {
                    await this.controller.execute(id, action, pressedAt);
                    this.failedValues.delete(key);
                }
                catch (error) {
                    const status = this.controller.status(id);
                    // An unsuccessful ON can still leave edited times or stopped timers.
                    // Keep Delay Active visible until rollback has actually completed.
                    const unresolvedDelay = context.control === "delayActive" && status.recovering && status.delayed;
                    const fallback = Boolean(previous || unresolvedDelay);
                    if (context.control !== "delay")
                        this.failedValues.set(key, fallback);
                    const newer = ((_a = this.pending.get(key)) === null || _a === void 0 ? void 0 : _a.token) !== token;
                    this.platform.log.error(`[SCHEDULE CONTROL FAILED] ${this.name(id)}: ${action}: ${this.describeError(error)}. ` +
                        (context.control === "delay" ? "Delay request failed." : newer ? "A newer switch request is still pending." : unresolvedDelay ? "Delay Active remains ON until schedule restoration finishes." : `Switch reverted to ${fallback ? "ON" : "OFF"}.`) +
                        (status.recovering ? " Schedule restoration is still pending; saved originals will be retried." : ""));
                }
                finally {
                    if (((_b = this.pending.get(key)) === null || _b === void 0 ? void 0 : _b.token) === token)
                        this.pending.delete(key);
                    this.refresh();
                }
            }
        }).catch((error) => {
            var _a;
            for (const id of ids) {
                const key = JSON.stringify([id, context.control]);
                if (((_a = this.pending.get(key)) === null || _a === void 0 ? void 0 : _a.token) === token)
                    this.pending.delete(key);
            }
            this.platform.log.error(`[SCHEDULE CONTROL FAILED] ${this.name(context.duid)}: ${action}: ${this.describeError(error)}. Switches refreshed from saved state.`);
        }).finally(() => this.refresh());
    }
    acceptPausePreference(value) {
        const token = {};
        this.pendingPausePreference = { token, value };
        // Keep preference changes ordered with presses, but do not contact the cloud
        // for a local setting. Failed persistence restores its previous saved value.
        this.commandTail = this.commandTail.then(() => this.ready).then(async () => {
            if (!this.disposed)
                await this.controller.setPauseUntilTomorrow(value);
        }).catch((error) => {
            var _a;
            this.platform.log.error(`[SCHEDULE CONTROL FAILED] Pause Until Tomorrow: ${this.describeError(error)}. ` +
                (((_a = this.pendingPausePreference) === null || _a === void 0 ? void 0 : _a.token) !== token ? "A newer switch request is still pending." : `Switch reverted to ${this.controller.pauseUntilTomorrow ? "ON" : "OFF"}.`));
        }).finally(() => {
            var _a;
            if (((_a = this.pendingPausePreference) === null || _a === void 0 ? void 0 : _a.token) === token)
                this.pendingPausePreference = undefined;
            this.refresh();
        });
    }
    refresh() {
        var _a;
        if (this.disposed)
            return;
        for (const accessory of this.bindings.values()) {
            const context = accessory.context;
            if (context.control !== "delay")
                (_a = accessory.getService(this.platform.Service.Switch)) === null || _a === void 0 ? void 0 : _a.updateCharacteristic(this.platform.Characteristic.On, this.value(context));
        }
    }
    dispose() {
        var _a;
        this.disposed = true;
        (_a = this.controller) === null || _a === void 0 ? void 0 : _a.dispose();
        for (const timer of this.resetTimers.values())
            clearTimeout(timer);
        this.resetTimers.clear();
        this.delayPulses.clear();
        this.pending.clear();
        this.failedValues.clear();
        this.pendingPausePreference = undefined;
    }
}
exports.NativeScheduleControls = NativeScheduleControls;
//# sourceMappingURL=native_schedule_controls.js.map