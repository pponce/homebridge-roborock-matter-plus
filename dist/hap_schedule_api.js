"use strict";
/**
 * Small HAP-only adapter around the shared Roborock API.
 *
 * These calls intentionally live outside roborockAPI.js. Mathias's Matter
 * implementation owns that file; keeping the HAP schedule integration here
 * makes upstream updates much easier to consume.
 *
 * The adapter deliberately uses the public Roborock API methods rather than
 * reaching directly into messageQueueHandler. This preserves the existing
 * vacuum-level error handling and transport behavior.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getServerTimers = getServerTimers;
exports.updateServerTimer = updateServerTimer;
async function getServerTimers(api, duid) {
    return api.getServerTimers(duid);
}
async function updateServerTimer(api, duid, timer, enabled) {
    const timerId = Array.isArray(timer) ? timer[0] : timer;
    if (typeof timerId !== "string" && typeof timerId !== "number") {
        throw new Error(`Invalid Roborock schedule ID: ${String(timerId)}`);
    }
    return api.updateServerTimer(duid, timerId, enabled);
}
//# sourceMappingURL=hap_schedule_api.js.map