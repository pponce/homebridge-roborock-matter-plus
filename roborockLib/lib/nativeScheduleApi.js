"use strict";

const READ = { preferCloud: true, operationClass: "read", requestTimeoutMs: 10000, cloudGateTimeoutMs: 8000 };
const WRITE = { ...READ, operationClass: "write", waitForResult: true, throwOnError: true };

function parseTimers(value) {
  if (!Array.isArray(value)) throw new Error("Robot did not return a timer list");
  const ids = new Set();
  return value.map((entry) => {
    if (!Array.isArray(entry) || !["string", "number"].includes(typeof entry[0]) || !["on", "off"].includes(entry[1]) || ids.has(String(entry[0]))) {
      throw new Error("Robot returned an unrecognized schedule timer");
    }
    const id = String(entry[0]); ids.add(id);
    return { id, enabled: entry[1] === "on" };
  });
}
function cleaningFromStatus(value) {
  if (Array.isArray(value) && value.length === 1) value = value[0];
  if (!value || !Number.isInteger(value.state)) throw new Error("Robot did not return a fresh cleaning state");
  if ([5, 11, 17, 18].includes(value.state)) return true;
  // Mop washing during a task does not mean the task has finished.
  if ([23, 26].includes(value.state) && [1, 2, 3].includes(value.in_cleaning)) return true;
  if ([2, 3, 6, 8, 10, 12, 14, 15, 16, 22, 23, 26, 28, 29, 100].includes(value.state)) return false;
  throw new Error("Robot state is not recognized for schedule delay eligibility");
}

function createNativeScheduleApi(roborock, coordinator) {
  let lastWriteAt = 0;
  async function guarded(operation) {
    try { return await operation(); }
    catch (error) {
      if (Number(error?.response?.status ?? error?.status) === 429) coordinator.recordThrottle(error);
      throw error;
    }
  }
  async function spaceWrite(kind = "primaryWrite") {
    const wait = Math.max(0, lastWriteAt + (coordinator.policy?.writeSpacingMs ?? 750) - Date.now());
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    const throttle = coordinator.currentThrottleError();
    if (throttle) throw throttle;
    lastWriteAt = Date.now(); coordinator.recordRequest(kind);
  }
  async function command(duid, method, params) {
    const vacuum = roborock.vacuums?.[duid];
    if (typeof vacuum?.command !== "function") throw new Error("Robot command connection is unavailable");
    return guarded(() => vacuum.command(duid, method, params, WRITE));
  }
  const api = {
    enqueue: (operation) => coordinator.enqueue(operation, (error) => { throw error; }),
    getJobs: async (duid) => guarded(async () => {
      coordinator.recordRequest("read");
      const response = await roborock.api.get(`user/devices/${encodeURIComponent(duid)}/jobs`, { timeout: 15000 });
      if (response.data?.success !== true || !Array.isArray(response.data.result)) throw new Error("Cloud schedules could not be read");
      return response.data.result;
    }),
    getTimers: async (duid) => guarded(async () => {
      coordinator.recordRequest("read");
      return parseTimers(await roborock.getServerTimers(duid, READ));
    }),
    putJob: async (duid, id, job) => guarded(async () => {
      await spaceWrite();
      // Reuse the existing Hawk-signed axios connection and exact JSON body.
      const response = await roborock.api.put(`user/devices/${encodeURIComponent(duid)}/jobs/${encodeURIComponent(id)}`,
        JSON.stringify(job), { timeout: 15000, headers: { "Content-Type": "application/json" } });
      if (response.data?.success !== true) throw new Error("Cloud rejected the schedule time update");
    }),
    putTimer: async (duid, id, enabled) => {
      await spaceWrite();
      let failure;
      try { await command(duid, "upd_server_timer", [[id, enabled ? "on" : "off"]]); }
      catch (error) { failure = error; }
      const actual = (await api.getTimers(duid)).find((timer) => timer.id === id);
      if (actual?.enabled === enabled) return;
      if (!actual) throw new Error("Schedule timer disappeared during update");
      // Some V1 robots expose server timers but require the standard update.
      // Do not retry a refused/throttled/unknown write blindly. A fresh timer
      // reading above must establish that the primary did not take effect.
      if (Number(failure?.response?.status ?? failure?.status) === 429) throw failure;
      await spaceWrite("fallbackWrite");
      await command(duid, "upd_timer", [id, enabled ? "on" : "off"]);
    },
    isCleaning: async (duid) => guarded(async () => {
      return cleaningFromStatus(await roborock.messageQueueHandler.sendRequest(duid, "get_status", [], false, false, READ));
    }),
    dock: async (duid) => {
      // One explicit, acknowledged command. No deferred docking retry can
      // interrupt a later manual clean started by the owner.
      await spaceWrite();
      await command(duid, "app_charge", []);
    },
  };
  return api;
}
module.exports = { createNativeScheduleApi, parseTimers, cleaningFromStatus };
