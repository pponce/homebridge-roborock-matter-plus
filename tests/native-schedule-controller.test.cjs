"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { NativeScheduleController } = require("../roborockLib/lib/nativeScheduleController");
const { atLocal, shiftedCron, nextReset } = require("../roborockLib/lib/scheduleCalendar");
const { cleaningFromStatus, parseTimers } = require("../roborockLib/lib/nativeScheduleApi");
const clone = (v) => JSON.parse(JSON.stringify(v));
process.env.TZ = "America/Los_Angeles";
const time = (clock, date = "2026-10-09") => Date.parse(`${date}T${clock}:00-07:00`);
function job(id, cron, enabled = true) {
  return { id, cron, timeZoneId: "America/Los_Angeles", enabled, repeated: true, nextFireTime: 123,
    param: { id: 1, method: "server_scheduled_start", params: [{ name: `timer-${id}`, segments: "1,2", fan_power: 104 }] } };
}
function harness(t, { now = time("09:05"), jobs = [job(1, "0 9 ? * 1,2,3,4,5"), job(2, "30 9 ? * 1,2,3,4,5")], minutes = 60 } = {}) {
  const h = { now, jobs: clone(jobs), timers: jobs.map((j) => ({ id: `timer-${j.id}`, enabled: true })), cleaning: true, calls: [], saved: { version: 1, robots: {} }, controllers: [] };
  const store = { load: () => clone(h.saved), save: (data) => { if (h.storageFails) throw new Error("disk unavailable"); h.saved = clone(data); } };
  const api = {
    getJobs: async () => { if (h.readFails) throw new Error("cloud unavailable"); return clone(h.jobs); },
    getTimers: async () => clone(h.timers),
    putJob: async (_d, id, body) => {
      h.calls.push(["job", id, clone(body)]);
      if (h.rejectJob === id) throw new Error("write refused");
      const index = h.jobs.findIndex((j) => String(j.id) === id);
      h.jobs[index] = { id: h.jobs[index].id, ...clone(body) };
      if (h.loseAck) { h.readFails = true; throw new Error("lost reply"); }
    },
    putTimer: async (_d, id, enabled) => {
      h.calls.push(["timer", id, enabled]); h.timers.find((timer) => timer.id === id).enabled = enabled;
      if (h.mirrorCloudFlag) h.jobs.find((job) => `timer-${job.id}` === id).enabled = enabled;
    },
    isCleaning: async () => h.cleaning,
    dock: async () => { h.calls.push(["dock"]); h.cleaning = false; },
  };
  h.newController = (config = {}) => {
    const controller = new NativeScheduleController({ api, store, clock: () => h.now,
      config: { enableScheduleDelay: true, enableSchedulePauseUntilTomorrow: true, scheduleDelayMinutes: minutes, ...config } });
    h.controllers.push(controller); return controller;
  };
  h.controller = h.newController();
  t.after(() => h.controllers.forEach((c) => c.dispose()));
  return h;
}

test("stacks by current times, re-evaluates after completion, and restores exact originals", async (t) => {
  const h = harness(t), originals = clone(h.jobs);
  await h.controller.execute("robot", "delay");
  assert.deepEqual(h.jobs.map((j) => j.cron), ["0 10 ? * 1,2,3,4,5", "30 10 ? * 1,2,3,4,5"]);
  assert.deepEqual(h.timers.map((v) => v.enabled), [true, true]);
  assert.equal(h.controller.status("robot").delayed, true);
  h.now = time("09:20"); await h.controller.execute("robot", "delay");
  assert.deepEqual(h.jobs.map((j) => j.cron), ["0 11 ? * 1,2,3,4,5", "30 11 ? * 1,2,3,4,5"]);
  h.now = time("11:20"); await h.controller.execute("robot", "delay");
  assert.deepEqual(h.jobs.map((j) => j.cron), ["0 11 ? * 1,2,3,4,5", "30 12 ? * 1,2,3,4,5"]);
  assert.equal(h.calls.filter((c) => c[0] === "dock").length, 1);
  await h.controller.execute("robot", "cancelDelay");
  assert.deepEqual(h.jobs.map((j) => j.cron), originals.map((j) => j.cron));
  assert.deepEqual(h.jobs.map((j) => j.param), originals.map((j) => j.param));
  assert.equal(h.controller.status("robot").delayed, false);
});

test("a paused vacuum receives no time edit; a new manual clean is docked only on an explicit press", async (t) => {
  const h = harness(t);
  h.timers[1].enabled = false;
  await h.controller.execute("robot", "pause");
  assert.equal(h.controller.status("robot").paused, true);
  assert.deepEqual(h.timers.map((t) => t.enabled), [false, false]);
  h.cleaning = true;
  await h.controller.recoverDue();
  assert.equal(h.cleaning, true);
  await h.controller.execute("robot", "delay");
  assert.equal(h.cleaning, false);
  assert.equal(h.calls.filter((c) => c[0] === "job").length, 0);
  await h.controller.execute("robot", "resume");
  assert.deepEqual(h.timers.map((t) => t.enabled), [true, false]);
});

test("pausing a delayed vacuum restores times while timers remain off, then unpause restores its mask", async (t) => {
  const h = harness(t);
  await h.controller.execute("robot", "delay");
  await h.controller.execute("robot", "pause");
  assert.equal(h.controller.status("robot").delayed, false);
  assert.equal(h.controller.status("robot").paused, true);
  assert.deepEqual(h.jobs.map((j) => j.cron), ["0 9 ? * 1,2,3,4,5", "30 9 ? * 1,2,3,4,5"]);
  assert.equal(h.timers.some((t) => t.enabled), false);
  await h.controller.execute("robot", "cancelDelay");
  assert.equal(h.controller.status("robot").paused, true);
});

test("disabled and off-day schedules are not shifted", async (t) => {
  const h = harness(t, { jobs: [job(1, "30 9 ? * 5"), job(2, "0 10 ? * 5"), job(3, "0 10 ? * 6")] });
  h.timers[1].enabled = false;
  await h.controller.execute("robot", "delay");
  assert.deepEqual(h.jobs.map((j) => j.cron), ["30 10 ? * 5", "0 10 ? * 5", "0 10 ? * 6"]);
  assert.equal(h.timers[1].enabled, false);
});

test("crossing midnight rotates weekdays but reaching the reset converts to a pause", async (t) => {
  const h = harness(t, { now: time("22:59"), jobs: [job(1, "0 23 ? * 5")] });
  h.cleaning = false;
  await h.controller.execute("robot", "delay");
  assert.equal(h.jobs[0].cron, "0 0 ? * 6");
  h.now = time("00:02", "2026-10-10"); h.cleaning = true;
  await h.controller.execute("robot", "delay");
  assert.equal(h.jobs[0].cron, "0 23 ? * 5");
  assert.equal(h.controller.status("robot").paused, true);
  assert.equal(h.controller.status("robot").delayed, true);
  h.now = time("00:05", "2026-10-10");
  await h.controller.recoverDue();
  assert.equal(h.timers[0].enabled, true);
  assert.equal(h.controller.status("robot").paused, false);
});

test("saved originals recover after a restart and a lost write acknowledgement", async (t) => {
  const h = harness(t); h.loseAck = true;
  await assert.rejects(h.controller.execute("robot", "delay"));
  assert.equal(h.saved.robots.robot.jobs["1"].original.cron, "0 9 ? * 1,2,3,4,5");
  assert.equal(h.controller.status("robot").delayed, true);
  h.controller.dispose(); h.loseAck = false; h.readFails = false; h.now += 61000;
  const restarted = h.newController();
  await restarted.initialize();
  assert.deepEqual(h.jobs.map((j) => j.cron), ["0 9 ? * 1,2,3,4,5", "30 9 ? * 1,2,3,4,5"]);
  assert.deepEqual(h.timers.map((v) => v.enabled), [true, true]);
  assert.equal(restarted.status("robot").delayed, false);
});

test("an outage during cancellation retains active state until restoration succeeds", async (t) => {
  const h = harness(t); await h.controller.execute("robot", "delay");
  h.readFails = true;
  await assert.rejects(h.controller.execute("robot", "cancelDelay"));
  assert.equal(h.controller.status("robot").delayed, true);
  h.readFails = false; h.now += 61000;
  await h.controller.recoverDue();
  assert.equal(h.controller.status("robot").delayed, false);
});

test("restoration preserves manual enable changes and abandons conflicting cron edits", async (t) => {
  const h = harness(t); await h.controller.execute("robot", "delay");
  h.jobs[0].enabled = false; h.timers[0].enabled = false;
  h.jobs[1].cron = "42 14 ? * 5";
  await h.controller.execute("robot", "cancelDelay");
  assert.equal(h.jobs[0].cron, "0 9 ? * 1,2,3,4,5");
  assert.equal(h.jobs[0].enabled, false); assert.equal(h.timers[0].enabled, false);
  assert.equal(h.jobs[1].cron, "42 14 ? * 5");
  assert.equal(h.saved.robots.robot.conflicts[0].saved.original.cron, "30 9 ? * 1,2,3,4,5");
});

test("no schedule mutation starts if saving originals fails", async (t) => {
  const h = harness(t); h.storageFails = true;
  await assert.rejects(h.controller.execute("robot", "delay"));
  assert.equal(h.calls.filter((c) => ["timer", "job"].includes(c[0])).length, 0);
});

test("turning a feature off restores saved changes at startup", async (t) => {
  const h = harness(t); await h.controller.execute("robot", "delay"); h.controller.dispose();
  const disabled = h.newController({ enableScheduleDelay: false, enableSchedulePauseUntilTomorrow: false });
  await disabled.initialize();
  assert.equal(disabled.status("robot").delayed, false);
  assert.equal(h.jobs[0].cron, "0 9 ? * 1,2,3,4,5");
});

test("stateful ON is idempotent; momentary delay presses still add time", async (t) => {
  const h = harness(t); await h.controller.execute("robot", "startDelay");
  const calls = h.calls.length;
  await h.controller.execute("robot", "startDelay");
  assert.equal(h.calls.length, calls);
  await h.controller.execute("robot", "delay");
  assert.equal(h.jobs[0].cron, "0 11 ? * 1,2,3,4,5");
});

test("calendar rejects ambiguous or nonexistent DST times and respects configurable reset", () => {
  assert.throws(() => atLocal("2026-11-01", 1, 30, "America/Los_Angeles"), /daylight/);
  assert.throws(() => atLocal("2026-03-08", 2, 30, "America/Los_Angeles"), /daylight/);
  assert.equal(nextReset(time("09:05"), "10:30"), time("10:30"));
  assert.equal(shiftedCron(job(1, "50 23 ? * 5"), time("23:50"), time("00:20", "2026-10-10")), "20 0 ? * 6");
});

test("fresh status and timer parsers never infer missing state as inactive", () => {
  assert.equal(cleaningFromStatus([{ state: 5 }]), true);
  assert.equal(cleaningFromStatus({ state: 23, in_cleaning: 1 }), true);
  assert.equal(cleaningFromStatus({ state: 8 }), false);
  assert.throws(() => cleaningFromStatus({}));
  assert.throws(() => parseTimers([[1, "unknown"]]));
});

test("Delay Active OFF can cancel its own cutoff pause without canceling an ordinary pause", async (t) => {
  const h = harness(t, { now: time("23:45"), jobs: [job(1, "50 23 ? * 5")] });
  h.cleaning = false;
  await h.controller.execute("robot", "delay");
  assert.equal(h.controller.status("robot").delayed, true);
  await h.controller.execute("robot", "cancelDelay");
  assert.equal(h.timers[0].enabled, true);
  await h.controller.execute("robot", "pause");
  await h.controller.execute("robot", "cancelDelay");
  assert.equal(h.timers[0].enabled, false);
  assert.equal(h.controller.status("robot").paused, true);
});

test("models that mirror timer enable into cloud.enabled preserve the fresh flag during edits", async (t) => {
  const h = harness(t); h.mirrorCloudFlag = true;
  await h.controller.execute("robot", "delay");
  assert.equal(h.jobs.every((j) => j.enabled), true);
  assert.equal(h.calls.filter((c) => c[0] === "job").every((c) => c[2].enabled === false), true);
  assert.equal(h.jobs[0].cron, "0 10 ? * 1,2,3,4,5");
  await h.controller.execute("robot", "cancelDelay");
  assert.equal(h.jobs[0].cron, "0 9 ? * 1,2,3,4,5");
  assert.equal(h.jobs.every((j) => j.enabled), true);
});

test("turning an inactive Pause switch OFF does not cancel a separate active delay", async (t) => {
  const h = harness(t); await h.controller.execute("robot", "delay");
  await h.controller.execute("robot", "resume");
  assert.equal(h.controller.status("robot").delayed, true);
  assert.equal(h.jobs[0].cron, "0 10 ? * 1,2,3,4,5");
});

test("hiding the ordinary pause feature restores its mask even if Delay remains enabled", async (t) => {
  const h = harness(t); await h.controller.execute("robot", "pause"); h.controller.dispose();
  const changed = h.newController({ enableSchedulePauseUntilTomorrow: false });
  await changed.initialize();
  assert.equal(changed.status("robot").paused, false);
  assert.equal(h.timers.every((timer) => timer.enabled), true);
});

test("the three evening schedules shift using the wire timeZoneId and restore their exact payloads", async (t) => {
  const h = harness(t, { now: time("16:17"), jobs: [
    job(1, "10 18 ? * 1,2,3,4,5"), job(2, "28 18 ? * 1,2,3,4,5"), job(3, "49 18 ? * 1,2,3,4,5"),
  ] });
  h.cleaning = false;
  const original = clone(h.jobs);
  await h.controller.execute("robot", "delay");
  assert.deepEqual(h.jobs.map((j) => j.cron), ["10 19 ? * 1,2,3,4,5", "28 19 ? * 1,2,3,4,5", "49 19 ? * 1,2,3,4,5"]);
  assert.equal(h.controller.status("robot").delayed, true);
  for (const [, , body] of h.calls.filter((c) => c[0] === "job")) {
    assert.equal(body.timeZoneId, "America/Los_Angeles");
    assert.equal(Object.hasOwn(body, "timezone"), false);
    assert.deepEqual(Object.keys(body).sort(), ["cron", "enabled", "param", "repeated", "timeZoneId"]);
  }
  await h.controller.execute("robot", "cancelDelay");
  const definition = (j) => { const result = clone(j); delete result.nextFireTime; return result; };
  assert.deepEqual(h.jobs.map(definition), original.map(definition));
  assert.equal(h.controller.status("robot").delayed, false);
});

test("invalid recurrence or timeZoneId is rejected before any schedule writes", async (t) => {
  for (const override of [{ repeated: false }, { timeZoneId: undefined }, { timeZoneId: "" }, { timeZoneId: "invalid-zone" }]) {
    const h = harness(t, { jobs: [{ ...job(1, "30 9 ? * 5"), ...override }] });
    h.cleaning = false;
    await assert.rejects(h.controller.execute("robot", "delay"), /repeated|timeZoneId|time zone/i);
    assert.equal(h.calls.length, 0);
  }
});

test("calendar uses the cloud timezone even when the host timezone differs", () => {
  const { occurrenceToday } = require("../roborockLib/lib/scheduleCalendar");
  const originalZone = process.env.TZ;
  process.env.TZ = "UTC";
  try {
    const schedule = job(1, "50 23 ? * 5");
    const occurrence = occurrenceToday(schedule, time("23:20"));
    assert.equal(occurrence.timestamp, time("23:50"));
    assert.equal(shiftedCron(schedule, occurrence.timestamp, time("00:50", "2026-10-10")), "50 0 ? * 6");
  } finally { process.env.TZ = originalZone; }
});
