"use strict";
/**
 * Small HAP-only adapter around the shared Roborock API.
 *
 * These calls intentionally live outside roborockAPI.js. Mathias's Matter
 * implementation owns that file; keeping the HAP schedule integration here
 * makes upstream updates much easier to consume.
 *
 * Server timers use the cloud-preferred Roborock contract. The underlying
 * vacuum API expects the timer id plus the desired status; the full timer
 * tuple is retained by the HAP accessory for verification/state tracking.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getServerTimers = getServerTimers;
exports.updateServerTimer = updateServerTimer;
exports.updateTimer = updateTimer;
function scheduleRequestOptions(options = {}) {
    return {
        ...options,
        preferCloud: true,
    };
}
async function getServerTimers(api, duid, options = {}) {
    return api.getServerTimers(duid, scheduleRequestOptions(options));
}
async function updateServerTimer(api, duid, timer, enabled, options = {}) {
    var _a;
    const timerId = Array.isArray(timer) ? timer[0] : timer;
    if (typeof timerId !== "string" && typeof timerId !== "number") {
        throw new Error(`Invalid Roborock schedule ID: ${String(timerId)}`);
    }
    const requestOptions = scheduleRequestOptions({
        ...options,
        waitForResult: true,
        throwOnError: true,
    });
    // Roborock's `upd_server_timer` contract expects the timer tuple as the
    // first (and only) command parameter: [[timerId, "on"|"off"]]. The shared
    // vacuum API's historical updateServerTimer helper flattened that tuple to
    // [timerId, status], which is accepted by some paths but does not update the
    // schedule in the Roborock app. Keep the HAP schedule integration isolated
    // from that upstream helper and send the exact cloud command shape here.
    const vacuum = (_a = api.vacuums) === null || _a === void 0 ? void 0 : _a[duid];
    if (typeof (vacuum === null || vacuum === void 0 ? void 0 : vacuum.command) === "function") {
        return vacuum.command(duid, "upd_server_timer", [[timerId, enabled ? "on" : "off"]], requestOptions);
    }
    if (typeof api.startCommand === "function") {
        return api.startCommand(duid, "upd_server_timer", [[timerId, enabled ? "on" : "off"]], requestOptions);
    }
    if (typeof api.updateServerTimer === "function") {
        return api.updateServerTimer(duid, timerId, enabled, requestOptions);
    }
    throw new Error("Roborock schedule command API is unavailable");
}
/**
 * Fallback for robots that expose the standard timer endpoint rather than
 * applying upd_server_timer. This deliberately calls the underlying vacuum's
 * command method rather than a broad platform command wrapper: vacuum.command
 * supports throwOnError, so a failed fallback cannot be mistaken for success.
 */
async function updateTimer(api, duid, timer, enabled, options = {}) {
    var _a;
    const timerId = Array.isArray(timer) ? timer[0] : timer;
    if (typeof timerId !== "string" && typeof timerId !== "number") {
        throw new Error(`Invalid Roborock schedule ID: ${String(timerId)}`);
    }
    const requestOptions = scheduleRequestOptions({
        ...options,
        waitForResult: true,
        throwOnError: true,
    });
    if (typeof api.startCommand === "function") {
        return api.startCommand(duid, "upd_timer", [timerId, enabled ? "on" : "off"], requestOptions);
    }
    const vacuum = (_a = api.vacuums) === null || _a === void 0 ? void 0 : _a[duid];
    if (typeof (vacuum === null || vacuum === void 0 ? void 0 : vacuum.command) === "function") {
        return vacuum.command(duid, "upd_timer", [timerId, enabled ? "on" : "off"], requestOptions);
    }
    throw new Error("Roborock timer command API is unavailable");
}
//# sourceMappingURL=hap_schedule_api.js.map