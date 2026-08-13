/**
 * Small HAP-only adapter around the shared Roborock API.
 *
 * These calls intentionally live outside roborockAPI.js. Mathias's Matter
 * implementation owns that file; keeping the HAP schedule integration here
 * makes upstream updates much easier to consume.
 *
 * Schedule timers are server-side Roborock timers. They must use the cloud
 * path, and `upd_server_timer` must receive the full timer tuple with the
 * status field changed. The original vacuum2 schedule implementation proved
 * this contract; do not reduce it to [timerId, status].
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

  const updatedTimer = Array.isArray(timer)
    ? [...timer]
    : [timerId, enabled ? "on" : "off"];
  updatedTimer[1] = enabled ? "on" : "off";

  return api.startCommand(
    duid,
    "upd_server_timer",
    updatedTimer,
    scheduleRequestOptions({
      ...options,
      waitForResult: true,
    })
  );
}
