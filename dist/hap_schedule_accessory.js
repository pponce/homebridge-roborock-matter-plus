"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HAP_SCHEDULE_EXTENSION = exports.HAP_EXTENSION_KIND = void 0;
exports.parseServerTimers = parseServerTimers;
exports.isHapScheduleAccessory = isHapScheduleAccessory;
const hap_schedule_api_1 = require("./hap_schedule_api");
const VERIFY_DELAY_MS = 1500;
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
            (rawStatus !== "on" && rawStatus !== "off"))
            continue;
        const id = String(rawId);
        if (!id || result.has(id))
            continue;
        result.set(id, { id, enabled: rawStatus === "on", timer: [...timer] });
    }
    return [...result.values()];
}
function isHapScheduleAccessory(accessory) {
    var _a;
    const context = ((_a = accessory.context) !== null && _a !== void 0 ? _a : {});
    return context.kind === exports.HAP_EXTENSION_KIND &&
        context.extension === exports.HAP_SCHEDULE_EXTENSION &&
        typeof context.duid === "string" && context.duid.length > 0;
}
class RoborockHapScheduleAccessory {
    constructor(platform, accessory, duid) {
        this.platform = platform;
        this.accessory = accessory;
        this.duid = duid;
        this.services = new Map();
        this.writes = new Set();
        this.suppression = new Map();
        this.schedules = new Map();
        accessory.context = {
            kind: exports.HAP_EXTENSION_KIND,
            extension: exports.HAP_SCHEDULE_EXTENSION,
            duid,
        };
    }
    async initialize(vacuumName) {
        this.accessory.displayName = `${vacuumName} Schedules`;
        const info = this.accessory.getService(this.platform.Service.AccessoryInformation) ||
            this.accessory.addService(this.platform.Service.AccessoryInformation);
        info.setCharacteristic(this.platform.Characteristic.Manufacturer, "Roborock");
        info.setCharacteristic(this.platform.Characteristic.Model, "Roborock Schedules");
        info.setCharacteristic(this.platform.Characteristic.SerialNumber, this.duid);
        await this.refresh();
    }
    async refresh() {
        const api = this.platform.roborockAPI;
        const raw = await (0, hap_schedule_api_1.getServerTimers)(api, this.duid);
        // An empty/non-array response is not enough evidence that the robot
        // genuinely has no schedules. Roborock cloud failures can produce empty
        // or unexpected responses. Preserve the existing HAP services instead of
        // deleting every schedule switch.
        if (!Array.isArray(raw)) {
            this.platform.log.warn(`Unable to reliably read Roborock schedules for ${this.duid}: ` +
                `get_server_timer returned ${typeof raw}; preserving existing schedules.`);
            return;
        }
        const schedules = parseServerTimers(raw);
        // A valid empty array means the robot currently reports no schedules.
        // This is safe to synchronize because we know the transport returned an
        // actual timer list rather than an error-shaped/unknown response.
        this.sync(schedules);
    }
    dispose() {
        this.writes.clear();
        this.suppression.clear();
    }
    sync(schedules) {
        const ids = new Set(schedules.map((s) => s.id));
        for (let i = 0; i < schedules.length; i++) {
            const schedule = schedules[i];
            const subtype = `${SERVICE_PREFIX}${encodeURIComponent(schedule.id)}`;
            let service = this.services.get(schedule.id) ||
                this.accessory.getServiceById(this.platform.Service.Switch, subtype);
            if (!service)
                service = this.accessory.addService(this.platform.Service.Switch, `Roborock Schedule ${i + 1}`, subtype);
            service.setCharacteristic(this.platform.Characteristic.Name, `Roborock Schedule ${i + 1} (${schedule.id})`);
            service.getCharacteristic(this.platform.Characteristic.On)
                .onSet((value) => this.setSchedule(schedule.id, Boolean(value)))
                .onGet(() => { var _a, _b; return (_b = (_a = this.schedules.get(schedule.id)) === null || _a === void 0 ? void 0 : _a.enabled) !== null && _b !== void 0 ? _b : schedule.enabled; });
            service.updateCharacteristic(this.platform.Characteristic.On, schedule.enabled);
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
    async setSchedule(id, enabled) {
        var _a, _b, _c, _d;
        const previous = (_b = (_a = this.schedules.get(id)) === null || _a === void 0 ? void 0 : _a.enabled) !== null && _b !== void 0 ? _b : !enabled;
        const now = Date.now();
        const last = this.suppression.get(id);
        if (last && last.enabled === enabled && now - last.timestamp < WRITE_SUPPRESSION_MS)
            return;
        if (this.writes.has(id)) {
            this.updateService(id, previous);
            return;
        }
        this.writes.add(id);
        try {
            const api = this.platform.roborockAPI;
            await (0, hap_schedule_api_1.updateServerTimer)(api, this.duid, id, enabled);
            const verified = await this.verify(api, id, enabled);
            if (!verified) {
                throw new Error(`Roborock did not confirm schedule ${id} as ${enabled ? "enabled" : "disabled"}`);
            }
            const timer = (_d = (_c = this.schedules.get(id)) === null || _c === void 0 ? void 0 : _c.timer) !== null && _d !== void 0 ? _d : [id, enabled ? "on" : "off"];
            this.schedules.set(id, { id, enabled, timer });
            this.suppression.set(id, { enabled, timestamp: Date.now() });
            this.updateService(id, enabled);
        }
        catch (error) {
            this.updateService(id, previous);
            const message = error instanceof Error ? error.message : String(error);
            this.platform.log.error(`Unable to ${enabled ? "enable" : "disable"} Roborock schedule ${id}: ${message}`);
        }
        finally {
            this.writes.delete(id);
        }
    }
    async verify(api, id, enabled) {
        var _a;
        await new Promise((resolve) => setTimeout(resolve, VERIFY_DELAY_MS));
        const schedules = parseServerTimers(await (0, hap_schedule_api_1.getServerTimers)(api, this.duid));
        this.sync(schedules);
        return ((_a = this.schedules.get(id)) === null || _a === void 0 ? void 0 : _a.enabled) === enabled;
    }
    updateService(id, enabled) {
        var _a;
        (_a = this.services.get(id)) === null || _a === void 0 ? void 0 : _a.updateCharacteristic(this.platform.Characteristic.On, enabled);
    }
}
exports.default = RoborockHapScheduleAccessory;
//# sourceMappingURL=hap_schedule_accessory.js.map