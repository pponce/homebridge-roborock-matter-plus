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

interface RoborockRequestOptions {
  preferCloud?: boolean;
  preferLocal?: boolean;
  allowOfflineCloudSend?: boolean;
  requestTimeoutMs?: number;
  waitForResult?: boolean;
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
  startCommand: (
    duid: string,
    command: string,
    parameters: unknown,
    options?: RoborockRequestOptions
  ) => Promise<unknown>;
}

function scheduleRequestOptions(
  options: RoborockRequestOptions = {}
): RoborockRequestOptions {
  return {
    ...options,
    preferCloud: true,
  };
}

export async function getServerTimers(
  api: RoborockScheduleApi,
  duid: string,
  options: RoborockRequestOptions = {}
): Promise<unknown> {
  return api.getServerTimers(duid, scheduleRequestOptions(options));
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

  return api.updateServerTimer(
    duid,
    timerId,
    enabled,
    scheduleRequestOptions(options)
  );
}

/**
 * Fallback for robots that expose the standard timer endpoint rather than
 * applying upd_server_timer. This mirrors the proven vacuum2 schedule retry.
 */
export async function updateTimer(
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

  return api.startCommand(
    duid,
    "upd_timer",
    [timerId, enabled ? "on" : "off"],
    scheduleRequestOptions({ ...options, waitForResult: true })
  );
}
