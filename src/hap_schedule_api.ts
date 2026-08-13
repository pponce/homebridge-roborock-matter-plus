/**
 * Small HAP-only adapter around the shared Roborock transport.
 *
 * These calls intentionally live outside roborockAPI.js. Mathias's Matter
 * implementation owns that file; keeping the two legacy schedule RPCs here
 * makes upstream updates much easier to consume.
 */

interface RoborockTimerTransport {
  messageQueueHandler: {
    sendRequest: (
      duid: string,
      method: string,
      params: unknown,
      ...args: unknown[]
    ) => Promise<any>;
  };
  log?: {
    debug?: (message: string) => void;
  };
}

export async function getServerTimers(
  api: RoborockTimerTransport,
  duid: string
): Promise<unknown> {
  const result = await api.messageQueueHandler.sendRequest(
    duid,
    "get_server_timer",
    [],
    false,
    false,
    { preferCloud: true }
  );

  api.log?.debug?.(
    `get_server_timer response for ${duid}: ${JSON.stringify(result)}`
  );

  return result;
}

export async function updateServerTimer(
  api: RoborockTimerTransport,
  duid: string,
  timer: string | number | unknown[],
  enabled: boolean
): Promise<unknown> {
  const timerId = Array.isArray(timer) ? timer[0] : timer;
  const updatedTimer = [timerId, enabled ? "on" : "off"];

  api.log?.debug?.(
    `Sending upd_server_timer for ${duid}: ${JSON.stringify([updatedTimer])}`
  );

  return api.messageQueueHandler.sendRequest(
    duid,
    "upd_server_timer",
    [updatedTimer],
    false,
    false,
    { preferCloud: true }
  );
}

export async function updateTimer(
  api: RoborockTimerTransport,
  duid: string,
  timer: string | number | unknown[],
  enabled: boolean
): Promise<unknown> {
  const timerId = Array.isArray(timer) ? timer[0] : timer;

  return api.messageQueueHandler.sendRequest(
    duid,
    "upd_timer",
    [timerId, enabled ? "on" : "off"],
    false,
    false,
    { preferCloud: true }
  );
}
