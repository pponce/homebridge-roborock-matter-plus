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

interface RoborockRequestOptions {
  preferCloud?: boolean;
  preferLocal?: boolean;
  allowOfflineCloudSend?: boolean;
  requestTimeoutMs?: number;
}

interface RoborockScheduleApi {
  getServerTimers: (
    duid: string,
    options?: RoborockRequestOptions
  ) => Promise<unknown>;
  updateServerTimer: (
    duid: string,
    timerId: string | number,
    enabled: boolean,
    options?: RoborockRequestOptions
  ) => Promise<unknown>;
}

export async function getServerTimers(
  api: RoborockScheduleApi,
  duid: string,
  options: RoborockRequestOptions = {}
): Promise<unknown> {
  return api.getServerTimers(duid, options);
}

export async function updateServerTimer(
  api: RoborockScheduleApi,
  duid: string,
  timer: string | number | unknown[],
  enabled: boolean,
  options: RoborockRequestOptions = {}
): Promise<unknown> {
  const timerId = Array.isArray(timer) ? timer[0] : timer;

  if (typeof timerId !== "string" && typeof timerId !== "number") {
    throw new Error(`Invalid Roborock schedule ID: ${String(timerId)}`);
  }

  return api.updateServerTimer(duid, timerId, enabled, options);
}
