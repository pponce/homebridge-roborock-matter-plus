"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HAP_SCHEDULE_EXTENSION = exports.HAP_EXTENSION_KIND = void 0;
exports.parseServerTimers = parseServerTimers;
exports.isHapScheduleAccessory = isHapScheduleAccessory;
const hap_schedule_api_1 = require("./hap_schedule_api");
const settings_1 = require("./settings");
const VERIFY_DELAY_MS = 3000;
const WRITE_SUPPRESSION_MS = 5000;
const SERVICE_PREFIX = "roborock-schedule-";
exports.HAP_EXTENSION_KIND = "hapExtension";
exports.HAP_SCHEDULE_EXTENSION = "schedules";
function parseServerTimers(value) {
    if (!Array.isArray(value))
        return [];
    const result = new Map();
    for (const timer of value) {
        if (!Array.isArray(timer) || timer.length < 2)
            continue;
        const [rawId, rawStatus] = timer;
        if ((typeof rawId !== "string" && typeof rawId !== "number") ||
            (rawStatus !== "on" && rawStatus !== "off")) {
            continue;
        }
        const id = String(rawId);
        if (!id || result.has(id))
            continue;
        result.set(id, {
            id,
            enabled: rawStatus === "on",
            timer: [...timer],
        });
    }
    return [...result.values()];
}
function isHapScheduleAccessory(accessory) {
    var _a;
    const context = ((_a = accessory.context) !== null && _a !== void 0 ? _a : {});
    return (context.kind === exports.HAP_EXTENSION_KIND &&
        context.extension === exports.HAP_SCHEDULE_EXTENSION &&
        typeof context.duid === "string" &&
        context.duid.length > 0);
}
/**
 * The platform still owns one lightweight schedule coordinator per vacuum.
 * The coordinator's old single accessory is deliberately not exposed to
 * HomeKit. Each Roborock timer is its own PlatformAccessory so Apple Home gets
 * one tile/name per schedule instead of collapsing all switches under
 * "<vacuum> Schedules".
 */
class RoborockHapScheduleAccessory {
    constructor(platform, accessory, duid) {
        this.platform = platform;
        this.duid = duid;
        this.scheduleAccessories = new Map();
        this.vacuumName = "";
        this.managerRemoved = false;
        this.managerAccessory = accessory;
        accessory.context = {
            kind: exports.HAP_EXTENSION_KIND,
            extension: exports.HAP_SCHEDULE_EXTENSION,
            duid,
        };
    }
    async initialize(vacuumName) {
        this.vacuumName = vacuumName;
        this.removeCoordinatorAccessory();
        await this.refresh();
    }
    async refresh() {
        const api = this.platform.roborockAPI;
        const raw = await (0, hap_schedule_api_1.getServerTimers)(api, this.duid, {
            requestTimeoutMs: 10000,
        });
        this.platform.log.info(`Schedule discovery for ${this.duid}: ` +
            `type=${Array.isArray(raw) ? "array" : typeof raw}, ` +
            `value=${JSON.stringify(raw)}`);
        if (!Array.isArray(raw)) {
            this.platform.log.warn(`Unable to reliably read Roborock schedules for ${this.duid}: ` +
                `get_server_timer returned ${typeof raw}; preserving existing schedules.`);
            return;
        }
        const schedules = parseServerTimers(raw);
        this.platform.log.info(`Schedule parser: parsed ${this.duid}; result count=${schedules.length}.`);
        this.sync(schedules);
    }
    dispose() {
        for (const schedule of this.scheduleAccessories.values()) {
            schedule.dispose();
        }
        this.scheduleAccessories.clear();
    }
    sync(schedules) {
        this.platform.log.info(`Schedule sync: ${this.duid} received ${schedules.length} parsed schedule(s).`);
        const ids = new Set(schedules.map((schedule) => schedule.id));
        for (let i = 0; i < schedules.length; i++) {
            const schedule = schedules[i];
            const displayName = `${this.vacuumName} Schedule ${i + 1} (${schedule.id})`;
            const existing = this.scheduleAccessories.get(schedule.id);
            if (existing) {
                existing.updateIdentity(displayName, schedule);
                continue;
            }
            const uuid = this.platform.api.hap.uuid.generate(`hap:roborock:schedule:v2:${this.duid}:${schedule.id}`);
            const cached = this.findCachedScheduleAccessory(uuid, schedule.id);
            const accessory = cached ||
                new this.platform.api.platformAccessory(displayName, uuid);
            const isNew = !cached;
            const child = new RoborockHapScheduleSwitchAccessory(this.platform, accessory, this.duid, schedule.id);
            child.initialize(displayName, schedule);
            this.scheduleAccessories.set(schedule.id, child);
            this.platform.log.info(`Schedule sync: ${isNew ? "adding" : "restoring"} HAP accessory '${displayName}' for ${schedule.id}.`);
            if (isNew) {
                this.platform.api.registerPlatformAccessories(settings_1.HAP_PLUGIN_IDENTIFIER, settings_1.PLATFORM_NAME, [accessory]);
            }
        }
        for (const [id, child] of this.scheduleAccessories) {
            if (ids.has(id))
                continue;
            this.platform.log.info(`Schedule sync: removing stale HAP accessory for ${id}.`);
            child.dispose();
            this.platform.api.unregisterPlatformAccessories(settings_1.HAP_PLUGIN_IDENTIFIER, settings_1.PLATFORM_NAME, [child.accessory]);
            this.removeFromPlatformCache(child.accessory);
            this.scheduleAccessories.delete(id);
        }
    }
    findCachedScheduleAccessory(uuid, scheduleId) {
        var _a, _b;
        const cachedAccessories = ((_a = this.platform.accessories) !== null && _a !== void 0 ? _a : []);
        return ((_b = cachedAccessories.find((accessory) => {
            if (accessory.UUID !== uuid || !isHapScheduleAccessory(accessory)) {
                return false;
            }
            const context = accessory.context;
            return context.duid === this.duid && context.scheduleId === scheduleId;
        })) !== null && _b !== void 0 ? _b : null);
    }
    removeCoordinatorAccessory() {
        if (this.managerRemoved)
            return;
        this.managerRemoved = true;
        // This accessory was created by the existing platform.ts coordinator path.
        // It is the legacy "<vacuum> Schedules" tile. Remove it before publishing
        // the real per-schedule accessories.
        this.platform.api.unregisterPlatformAccessories(settings_1.HAP_PLUGIN_IDENTIFIER, settings_1.PLATFORM_NAME, [this.managerAccessory]);
        this.removeFromPlatformCache(this.managerAccessory);
    }
    removeFromPlatformCache(accessory) {
        var _a;
        const cachedAccessories = ((_a = this.platform.accessories) !== null && _a !== void 0 ? _a : []);
        const index = cachedAccessories.indexOf(accessory);
        if (index >= 0) {
            cachedAccessories.splice(index, 1);
        }
    }
}
exports.default = RoborockHapScheduleAccessory;
class RoborockHapScheduleSwitchAccessory {
    constructor(platform, accessory, duid, scheduleId) {
        this.platform = platform;
        this.accessory = accessory;
        this.duid = duid;
        this.scheduleId = scheduleId;
        this.writes = new Set();
        this.suppression = new Map();
        // If Roborock rejects/doesn't reflect a command, don't allow HomeKit
        // to immediately hammer the same command over and over.
        this.failedCommands = new Map();
        this.schedule = {
            id: scheduleId,
            enabled: false,
            timer: [scheduleId, "off"],
        };
        accessory.context = {
            kind: exports.HAP_EXTENSION_KIND,
            extension: exports.HAP_SCHEDULE_EXTENSION,
            duid,
            scheduleId,
        };
    }
    initialize(displayName, schedule) {
        this.updateIdentity(displayName, schedule);
        const info = this.accessory.getService(this.platform.Service.AccessoryInformation) ||
            this.accessory.addService(this.platform.Service.AccessoryInformation);
        info.setCharacteristic(this.platform.Characteristic.Manufacturer, "Roborock");
        info.setCharacteristic(this.platform.Characteristic.Model, "Roborock Schedule");
        info.setCharacteristic(this.platform.Characteristic.SerialNumber, `${this.duid}:${this.scheduleId}`);
        // HomeKit uses AccessoryInformation.Name for the accessory/tile identity.
        // Setting only the Switch service Name is not sufficient and can leave
        // every restored schedule displayed as "<vacuum> Schedules".
        info.setCharacteristic(this.platform.Characteristic.Name, displayName);
        const subtype = `${SERVICE_PREFIX}${encodeURIComponent(this.scheduleId)}`;
        let service = this.accessory.getServiceById(this.platform.Service.Switch, subtype);
        if (!service) {
            service = this.accessory.addService(this.platform.Service.Switch, displayName, subtype);
        }
        service.setCharacteristic(this.platform.Characteristic.Name, displayName);
        service.addOptionalCharacteristic(this.platform.Characteristic.ConfiguredName);
        service.setCharacteristic(this.platform.Characteristic.ConfiguredName, displayName);
        service
            .getCharacteristic(this.platform.Characteristic.On)
            .onSet((value) => this.setSchedule(Boolean(value)))
            .onGet(() => this.schedule.enabled);
        service.updateCharacteristic(this.platform.Characteristic.On, schedule.enabled);
    }
    updateIdentity(displayName, schedule) {
        this.schedule = { ...schedule, timer: [...schedule.timer] };
        this.accessory.displayName = displayName;
        const info = this.accessory.getService(this.platform.Service.AccessoryInformation) ||
            this.accessory.addService(this.platform.Service.AccessoryInformation);
        info.setCharacteristic(this.platform.Characteristic.Name, displayName);
        // Persist the accessory identity/name for restored PlatformAccessories.
        this.platform.api.updatePlatformAccessories([this.accessory]);
        const switchService = this.accessory.getServiceById(this.platform.Service.Switch, `${SERVICE_PREFIX}${encodeURIComponent(this.scheduleId)}`);
        if (switchService) {
            switchService.setCharacteristic(this.platform.Characteristic.Name, displayName);
            switchService.addOptionalCharacteristic(this.platform.Characteristic.ConfiguredName);
            switchService.setCharacteristic(this.platform.Characteristic.ConfiguredName, displayName);
            switchService.updateCharacteristic(this.platform.Characteristic.On, schedule.enabled);
        }
    }
    dispose() {
        this.writes.clear();
        this.suppression.clear();
    }
    async setSchedule(enabled) {
        const previous = this.schedule.enabled;
        const now = Date.now();
        const last = this.suppression.get(this.scheduleId);
        if (last &&
            last.enabled === enabled &&
            now - last.timestamp < WRITE_SUPPRESSION_MS) {
            return;
        }
        const failed = this.failedCommands.get(this.scheduleId);
        if (failed &&
            failed.enabled === enabled &&
            now - failed.timestamp <
                RoborockHapScheduleSwitchAccessory.FAILED_COMMAND_COOLDOWN_MS) {
            this.updateService(previous);
            return;
        }
        if (this.writes.has(this.scheduleId)) {
            this.updateService(previous);
            return;
        }
        this.writes.add(this.scheduleId);
        try {
            const api = this.platform.roborockAPI;
            this.platform.log.info(`Schedule command: ${enabled ? "enabling" : "disabling"} ${this.duid}/${this.scheduleId}; params=[[${JSON.stringify(this.scheduleId)}, ${JSON.stringify(enabled ? "on" : "off")}]].`);
            await (0, hap_schedule_api_1.updateServerTimer)(api, this.duid, this.scheduleId, enabled, {
                requestTimeoutMs: 10000,
            });
            if (!(await this.verify(api, enabled))) {
                this.platform.log.warn(`Roborock schedule ${this.scheduleId} did not reflect upd_server_timer; trying upd_timer fallback.`);
                await (0, hap_schedule_api_1.updateTimer)(api, this.duid, this.scheduleId, enabled, {
                    requestTimeoutMs: 10000,
                });
                if (!(await this.verify(api, enabled))) {
                    throw new Error(`Roborock did not confirm schedule ${this.scheduleId} as ${enabled ? "enabled" : "disabled"}`);
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
        }
        catch (error) {
            this.updateService(previous);
            this.failedCommands.set(this.scheduleId, {
                enabled,
                timestamp: Date.now(),
            });
            const message = error instanceof Error ? error.message : String(error);
            this.platform.log.warn(`Unable to ${enabled ? "enable" : "disable"} Roborock schedule ${this.scheduleId}: ${message}. ` +
                `Further attempts for this same state are suppressed for ` +
                `${RoborockHapScheduleSwitchAccessory.FAILED_COMMAND_COOLDOWN_MS / 1000}s.`);
        }
        finally {
            this.writes.delete(this.scheduleId);
        }
    }
    async verify(api, enabled) {
        await new Promise((resolve) => setTimeout(resolve, VERIFY_DELAY_MS));
        const raw = await (0, hap_schedule_api_1.getServerTimers)(api, this.duid, {
            requestTimeoutMs: 10000,
        });
        if (!Array.isArray(raw)) {
            return false;
        }
        const schedules = parseServerTimers(raw);
        const current = schedules.find((schedule) => schedule.id === this.scheduleId);
        if (!current) {
            return false;
        }
        this.schedule = { ...current, timer: [...current.timer] };
        this.updateService(current.enabled);
        return current.enabled === enabled;
    }
    updateService(enabled) {
        const service = this.accessory.getServiceById(this.platform.Service.Switch, `${SERVICE_PREFIX}${encodeURIComponent(this.scheduleId)}`);
        service === null || service === void 0 ? void 0 : service.updateCharacteristic(this.platform.Characteristic.On, enabled);
    }
}
RoborockHapScheduleSwitchAccessory.FAILED_COMMAND_COOLDOWN_MS = 30000;
//# sourceMappingURL=hap_schedule_accessory.js.map