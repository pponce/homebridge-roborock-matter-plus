"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ScheduleControlStore } = require("../roborockLib/lib/scheduleControlStore");
const { createNativeScheduleApi } = require("../roborockLib/lib/nativeScheduleApi");

test("journal is private, survives replacement and refuses corrupt saved originals", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "roborock-schedule-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, "state.json"), store = new ScheduleControlStore(filename);
  assert.deepEqual(store.load(), { version: 1, robots: {} });
  const state = { version: 1, robots: { a: { expiresAt: 100, paused: true, jobs: {}, timers: { t: { original: true, expected: false } }, conflicts: [] } } };
  store.save(state); assert.deepEqual(new ScheduleControlStore(filename).load(), state);
  assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
  state.robots.a.expiresAt = 200; store.save(state);
  assert.equal(store.load().robots.a.expiresAt, 200);
  fs.writeFileSync(filename, "invalid"); assert.throws(() => store.load());
  assert.equal(fs.readFileSync(filename, "utf8"), "invalid");
});

test("adapter uses existing authentication, correct timer envelopes and acknowledged docking", async () => {
  const calls = [], timers = [["123", "on"]];
  const coordinator = { policy: { writeSpacingMs: 0 }, enqueue: (f) => f(), currentThrottleError: () => undefined,
    recordRequest() {}, recordThrottle() {} };
  const roborock = {
    api: {
      get: async (route) => { calls.push(["get", route]); return { data: { success: true, result: [] } }; },
      put: async (...args) => { calls.push(["put", ...args]); return { data: { success: true } }; },
    },
    getServerTimers: async () => timers,
    messageQueueHandler: { sendRequest: async (...args) => { calls.push(["read", ...args]); return [{ state: 5 }]; } },
    vacuums: { robot: { command: async (...args) => {
      calls.push(["command", ...args]);
      if (args[1] === "upd_server_timer") timers[0][1] = args[2][0][1];
    } } },
  };
  const api = createNativeScheduleApi(roborock, coordinator);
  assert.equal(await api.isCleaning("robot"), true);
  await api.putTimer("robot", "123", false);
  await api.putJob("robot", "7", { cron: "0 10 ? * 5", enabled: true });
  await api.dock("robot");
  const commands = calls.filter((c) => c[0] === "command");
  assert.deepEqual(commands.map((c) => c[2]), ["upd_server_timer", "app_charge"]);
  assert.deepEqual(commands[0][3], [["123", "off"]]);
  assert.equal(commands[1][4].throwOnError, true);
  assert.equal(commands[1][4].waitForResult, true);
  const put = calls.find((c) => c[0] === "put");
  assert.equal(put[1], "user/devices/robot/jobs/7");
  assert.equal(put[2], '{"cron":"0 10 ? * 5","enabled":true}');
  assert.equal(put[3].headers["Content-Type"], "application/json");
});
