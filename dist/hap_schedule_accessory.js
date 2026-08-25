"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HAP_SCHEDULE_EXTENSION = exports.HAP_EXTENSION_KIND = void 0;
exports.parseServerTimers = parseServerTimers;
exports.isHapScheduleAccessory = isHapScheduleAccessory;
const hap_schedule_api_1 = require("./hap_schedule_api");
const timers_1 = require("./timers");
const VERIFY_DELAY_MS = 3000;
const WRITE_SUPPRESSION_MS = 5000;
const SCHEDULE_CACHE_TTL_MS = 60 * 1000;
const SCHEDULE_FAILURE_BACKOFF_MS = 30 * 1000;
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
 * The platform owns one schedule coordinator per vacuum.
 * Each vacuum has one cached HAP PlatformAccessory, and each Roborock timer
 * is exposed as a Switch service within that shared accessory.
 *
 * Schedule services are intentionally named from the vacuum name so the
 * Home app presents the schedules together under the vacuum's schedule
 * grouping:
 *
 *   <vacuum> Schedule 1
 *   <vacuum> Schedule 2
 *   ...
 *
 * The manager UUID/context is derived from the vacuum duid. Each Switch
 * service subtype is derived from the schedule ID. Display names are not
 * identity and must never overwrite the shared manager accessory identity.
 */
class RoborockHapScheduleAccessory {
    constructor(platform, accessory, duid) {
        this.platform = platform;
        this.duid = duid;
        this.scheduleAccessories = new Map();
        this.vacuumName = "";
        this.managerRemoved = false;
        this.disposed = false;
        this.lastScheduleRefreshAt = 0;
        this.lastFailedRefreshAt = 0;
        this.refreshInProgressStartedAt = 0;
        this.refreshGeneration = 0;
        this.managerAccessory = accessory;
        accessory.context = {
            kind: exports.HAP_EXTENSION_KIND,
            extension: exports.HAP_SCHEDULE_EXTENSION,
            duid,
        };
    }
    async initialize(vacuumName) {
        this.vacuumName = vacuumName;
        const displayName = `${vacuumName} Schedules`;
        this.managerAccessory.displayName = displayName;
        this.managerAccessory.context = {
            kind: exports.HAP_EXTENSION_KIND,
            extension: exports.HAP_SCHEDULE_EXTENSION,
            duid: this.duid,
        };
        const info = this.managerAccessory.getService(this.platform.Service.AccessoryInformation) ||
            this.managerAccessory.addService(this.platform.Service.AccessoryInformation);
        info.setCharacteristic(this.platform.Characteristic.Manufacturer, "Roborock");
        info.setCharacteristic(this.platform.Characteristic.Model, "Schedules");
        info.setCharacteristic(this.platform.Characteristic.SerialNumber, `${this.duid}:schedules`);
        info.setCharacteristic(this.platform.Characteristic.Name, displayName);
        // Initial discovery always performs one cloud schedule request.
        // Subsequent HomeKit reads use the cached snapshot until it expires.
        return this.refreshDetailed();
    }
    /**
     * Rebuild schedule child objects and attach their normal HAP handlers from
     * Switch services that Homebridge restored from its cached accessory state.
     *
     * This is local recovery state only. It is intentionally not written into
     * cachedSchedules or lastScheduleRefreshAt because the cloud snapshot is
     * still unknown. A later successful cloud refresh remains authoritative.
     */
    restoreScheduleHandlersFromAccessory() {
        const restored = [];
        const seen = new Set();
        let switchServiceCount = 0;
        let scheduleSwitchServiceCount = 0;
        for (const service of this.managerAccessory.services) {
            if (service.UUID !== this.platform.Service.Switch.UUID) {
                continue;
            }
            switchServiceCount++;
            const subtype = service.subtype;
            if (typeof subtype !== "string" || !subtype.startsWith(SERVICE_PREFIX)) {
                continue;
            }
            scheduleSwitchServiceCount++;
            let scheduleId;
            try {
                scheduleId = decodeURIComponent(subtype.slice(SERVICE_PREFIX.length));
            }
            catch (_a) {
                continue;
            }
            if (!scheduleId || seen.has(scheduleId)) {
                continue;
            }
            seen.add(scheduleId);
            const enabled = Boolean(service.getCharacteristic(this.platform.Characteristic.On).value);
            restored.push({
                id: scheduleId,
                enabled,
                timer: [scheduleId, enabled ? "on" : "off"],
            });
        }
        if (restored.length === 0) {
            this.platform.log.debug(`Schedule restoration for ${this.vacuumName}: ` +
                `managerUUID=${this.managerAccessory.UUID}; ` +
                `services=${this.managerAccessory.services.length}; ` +
                `switchServices=${switchServiceCount}; ` +
                `scheduleSwitchServices=${scheduleSwitchServiceCount}; ` +
                `restored=0; handlersReattached=false`);
            return false;
        }
        restored.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
        this.sync(restored);
        this.platform.log.debug(`Schedule restoration for ${this.vacuumName}: ` +
            `managerUUID=${this.managerAccessory.UUID}; ` +
            `services=${this.managerAccessory.services.length}; ` +
            `switchServices=${switchServiceCount}; ` +
            `scheduleSwitchServices=${scheduleSwitchServiceCount}; ` +
            `restored=${restored.length}; ` +
            `scheduleIds=${restored.map((schedule) => schedule.id).join(",")}; ` +
            `handlersReattached=true`);
        return true;
    }
    async refreshIfNeeded() {
        var _a, _b, _c, _d, _e, _f;
        const now = Date.now();
        this.platform.log.debug(`Schedule refreshIfNeeded: entered; ` +
            `cached=${(_b = (_a = this.cachedSchedules) === null || _a === void 0 ? void 0 : _a.length) !== null && _b !== void 0 ? _b : "undefined"}; ` +
            `lastRefreshAgeMs=${this.lastScheduleRefreshAt > 0 ? now - this.lastScheduleRefreshAt : "never"}; ` +
            `lastFailureAgeMs=${this.lastFailedRefreshAt > 0 ? now - this.lastFailedRefreshAt : "never"}`);
        if (this.cachedSchedules !== undefined &&
            now - this.lastScheduleRefreshAt < SCHEDULE_CACHE_TTL_MS) {
            this.platform.log.debug(`Schedule refreshIfNeeded: CACHE HIT; ` +
                `ageMs=${now - this.lastScheduleRefreshAt}; ` +
                `returning=${this.cachedSchedules.length > 0}`);
            return this.cachedSchedules.length > 0;
        }
        if (this.lastFailedRefreshAt > 0 &&
            now - this.lastFailedRefreshAt < SCHEDULE_FAILURE_BACKOFF_MS) {
            this.platform.log.debug(`Schedule refreshIfNeeded: FAILURE BACKOFF; ` +
                `ageMs=${now - this.lastFailedRefreshAt}; ` +
                `returning=${((_d = (_c = this.cachedSchedules) === null || _c === void 0 ? void 0 : _c.length) !== null && _d !== void 0 ? _d : 0) > 0}`);
            return ((_f = (_e = this.cachedSchedules) === null || _e === void 0 ? void 0 : _e.length) !== null && _f !== void 0 ? _f : 0) > 0;
        }
        this.platform.log.debug(`Schedule refreshIfNeeded: CALLING refresh()`);
        return this.refresh();
    }
    async refresh() {
        const result = await this.refreshDetailed();
        return result.hasSchedules;
    }
    async refreshAndGetSchedule(scheduleId, minimumRefreshStartedAt = 0) {
        var _a;
        await this.refreshDetailed(minimumRefreshStartedAt);
        const schedule = (_a = this.cachedSchedules) === null || _a === void 0 ? void 0 : _a.find((candidate) => candidate.id === scheduleId);
        return schedule
            ? {
                ...schedule,
                timer: [...schedule.timer],
            }
            : undefined;
    }
    async refreshDetailed(minimumRefreshStartedAt = 0) {
        if (this.disposed) {
            return {
                success: false,
                hasSchedules: false,
            };
        }
        if (this.refreshInProgress &&
            this.refreshInProgressStartedAt >= minimumRefreshStartedAt) {
            return this.refreshInProgress;
        }
        const startedAt = Date.now();
        const generation = ++this.refreshGeneration;
        const refresh = this.performRefresh(generation);
        this.refreshInProgress = refresh;
        this.refreshInProgressStartedAt = startedAt;
        try {
            return await refresh;
        }
        finally {
            // Only the current refresh is allowed to clear these fields. An older
            // refresh can finish after a newer verification refresh has started.
            if (this.refreshInProgress === refresh) {
                this.refreshInProgress = undefined;
                this.refreshInProgressStartedAt = 0;
            }
        }
    }
    async performRefresh(generation) {
        try {
            const api = this.platform.roborockAPI;
            const raw = await (0, hap_schedule_api_1.getServerTimers)(api, this.duid, {
                requestTimeoutMs: 10000,
            });
            this.platform.log.debug(`Schedule discovery for ${this.duid}: ` +
                `type=${Array.isArray(raw) ? "array" : typeof raw}, ` +
                `value=${JSON.stringify(raw)}`);
            if (!Array.isArray(raw)) {
                if (generation !== this.refreshGeneration || this.disposed) {
                    return {
                        success: false,
                        hasSchedules: this.scheduleAccessories.size > 0,
                    };
                }
                this.lastFailedRefreshAt = Date.now();
                this.platform.log.warn(`Unable to reliably read Roborock schedules for ${this.duid}: ` +
                    `get_server_timer returned ${typeof raw}; preserving existing schedules.`);
                return {
                    success: false,
                    hasSchedules: this.scheduleAccessories.size > 0,
                };
            }
            const schedules = parseServerTimers(raw);
            if (this.disposed) {
                return {
                    success: false,
                    hasSchedules: false,
                };
            }
            // Keep display numbering stable even if Roborock returns schedules
            // in a different order between refreshes.
            schedules.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
            // A non-empty response that parses to zero schedules is not a
            // trustworthy empty snapshot. Preserve the previous state instead
            // of deleting every HomeKit schedule switch.
            if (raw.length > 0 && schedules.length === 0) {
                if (generation !== this.refreshGeneration || this.disposed) {
                    return {
                        success: false,
                        hasSchedules: this.scheduleAccessories.size > 0,
                    };
                }
                this.lastFailedRefreshAt = Date.now();
                this.platform.log.warn(`Unable to reliably read Roborock schedules for ${this.duid}: ` +
                    `get_server_timer returned a non-empty response that parsed to zero schedules; preserving existing schedules.`);
                return {
                    success: false,
                    hasSchedules: this.scheduleAccessories.size > 0,
                };
            }
            // A newer refresh may have started while this request was in flight.
            // The older request may finish, but it must never overwrite the newer
            // snapshot or its refresh timestamps.
            if (generation !== this.refreshGeneration || this.disposed) {
                return {
                    success: false,
                    hasSchedules: this.scheduleAccessories.size > 0,
                };
            }
            this.cachedSchedules = schedules.map((schedule) => ({
                ...schedule,
                timer: [...schedule.timer],
            }));
            this.lastScheduleRefreshAt = Date.now();
            this.lastFailedRefreshAt = 0;
            this.platform.log.info(`Schedule parser: parsed ${this.duid}; result count=${schedules.length}.`);
            this.sync(schedules);
            // A successful empty snapshot is authoritative information. It is
            // different from a failed/untrusted cloud response.
            return {
                success: true,
                hasSchedules: schedules.length > 0,
            };
        }
        catch (error) {
            if (generation !== this.refreshGeneration || this.disposed) {
                return {
                    success: false,
                    hasSchedules: this.scheduleAccessories.size > 0,
                };
            }
            this.lastFailedRefreshAt = Date.now();
            const message = error instanceof Error ? error.message : String(error);
            this.platform.log.warn(`Unable to refresh Roborock schedules for ${this.duid}: ${message}. Preserving existing schedules.`);
            return {
                success: false,
                hasSchedules: this.scheduleAccessories.size > 0,
            };
        }
    }
    recordScheduleUpdate(schedule) {
        const updated = {
            ...schedule,
            timer: [...schedule.timer],
        };
        const schedules = this.cachedSchedules
            ? this.cachedSchedules.map((candidate) => candidate.id === updated.id
                ? { ...updated }
                : { ...candidate, timer: [...candidate.timer] })
            : [updated];
        if (!schedules.some((candidate) => candidate.id === updated.id)) {
            schedules.push(updated);
        }
        this.cachedSchedules = schedules;
        this.lastScheduleRefreshAt = Date.now();
    }
    dispose() {
        this.disposed = true;
        this.refreshGeneration++;
        this.refreshInProgress = undefined;
        this.refreshInProgressStartedAt = 0;
        this.cachedSchedules = undefined;
        this.lastScheduleRefreshAt = 0;
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
    sync(schedules) {
        this.platform.log.debug(`Schedule sync: ${this.duid} received ${schedules.length} parsed schedule(s).`);
        const ids = new Set(schedules.map((schedule) => schedule.id));
        for (let i = 0; i < schedules.length; i++) {
            const schedule = schedules[i];
            const displayName = `${this.vacuumName} Schedule ${i + 1}`;
            const existing = this.scheduleAccessories.get(schedule.id);
            if (existing) {
                existing.updateIdentity(displayName, schedule);
                continue;
            }
            const child = new RoborockHapScheduleSwitchAccessory(this.platform, this, this.managerAccessory, this.duid, schedule.id);
            child.initialize(displayName, schedule);
            this.scheduleAccessories.set(schedule.id, child);
            this.platform.log.debug(`Schedule sync: added HAP switch '${displayName}' for ${schedule.id}.`);
        }
        for (const [id, child] of this.scheduleAccessories) {
            if (ids.has(id))
                continue;
            this.platform.log.debug(`Schedule sync: removing stale HAP switch for ${id}.`);
            child.dispose();
            const service = this.managerAccessory.getServiceById(this.platform.Service.Switch, `${SERVICE_PREFIX}${encodeURIComponent(id)}`);
            if (service) {
                this.managerAccessory.removeService(service);
            }
            this.scheduleAccessories.delete(id);
            this.platform.api.updatePlatformAccessories([this.managerAccessory]);
        }
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
    constructor(platform, coordinator, accessory, duid, scheduleId) {
        this.platform = platform;
        this.coordinator = coordinator;
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
    }
    initialize(displayName, schedule) {
        this.updateIdentity(displayName, schedule);
        const subtype = `${SERVICE_PREFIX}${encodeURIComponent(this.scheduleId)}`;
        let service = this.accessory.getServiceById(this.platform.Service.Switch, subtype);
        if (!service) {
            service = this.accessory.addService(this.platform.Service.Switch, displayName, subtype);
        }
        service.displayName = displayName;
        service.setCharacteristic(this.platform.Characteristic.Name, displayName);
        service.addOptionalCharacteristic(this.platform.Characteristic.ConfiguredName);
        const configuredName = service.getCharacteristic(this.platform.Characteristic.ConfiguredName);
        const currentConfiguredName = configuredName.value;
        if (currentConfiguredName == null ||
            String(currentConfiguredName) === displayName) {
            configuredName.setValue(displayName);
        }
        service
            .getCharacteristic(this.platform.Characteristic.On)
            .onSet((value) => this.setSchedule(Boolean(value)))
            .onGet(() => {
            void this.coordinator.refreshIfNeeded();
            return this.schedule.enabled;
        });
        service.updateCharacteristic(this.platform.Characteristic.On, schedule.enabled);
    }
    updateIdentity(displayName, schedule) {
        this.schedule = { ...schedule, timer: [...schedule.timer] };
        const switchService = this.accessory.getServiceById(this.platform.Service.Switch, `${SERVICE_PREFIX}${encodeURIComponent(this.scheduleId)}`);
        if (switchService) {
            const previousServiceName = switchService.getCharacteristic(this.platform.Characteristic.Name).value;
            switchService.displayName = displayName;
            switchService.setCharacteristic(this.platform.Characteristic.Name, displayName);
            switchService.addOptionalCharacteristic(this.platform.Characteristic.ConfiguredName);
            const configuredName = switchService.getCharacteristic(this.platform.Characteristic.ConfiguredName);
            const currentConfiguredName = configuredName.value;
            if (currentConfiguredName == null ||
                String(currentConfiguredName) === String(previousServiceName)) {
                configuredName.setValue(displayName);
            }
            switchService.updateCharacteristic(this.platform.Characteristic.On, schedule.enabled);
        }
    }
    dispose() {
        this.writes.clear();
        this.suppression.clear();
        this.failedCommands.clear();
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
            const writeStartedAt = Date.now();
            await (0, hap_schedule_api_1.updateServerTimer)(api, this.duid, this.scheduleId, enabled, {
                requestTimeoutMs: 10000,
            });
            if (!(await this.verify(enabled, writeStartedAt))) {
                this.platform.log.warn(`Roborock schedule ${this.scheduleId} did not reflect upd_server_timer; trying upd_timer fallback.`);
                const fallbackWriteStartedAt = Date.now();
                await (0, hap_schedule_api_1.updateTimer)(api, this.duid, this.scheduleId, enabled, {
                    requestTimeoutMs: 10000,
                });
                if (!(await this.verify(enabled, fallbackWriteStartedAt))) {
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
    async verify(enabled, minimumRefreshStartedAt) {
        await new Promise((resolve) => {
            const timer = (0, timers_1.scheduleTimer)(resolve, VERIFY_DELAY_MS);
            (0, timers_1.unrefTimer)(timer);
        });
        const current = await this.coordinator.refreshAndGetSchedule(this.scheduleId, minimumRefreshStartedAt);
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