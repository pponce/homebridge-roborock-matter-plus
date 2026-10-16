"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { runTimeTrial } = require("../roborockLib/lib/cloudJobTimeTrial");
const { makeRequester, writePrivate, argumentsFrom, loadSavedSession } = require("../scripts/test-schedule-time.cjs");
const { encryptSession } = require("../dist/crypto");
const { buildHawkAuthorization } = require("../roborockLib/lib/hawkSignature");

const clone = (v) => JSON.parse(JSON.stringify(v));
const original = { id: 123, cron: "10 8 ? * 1,2,3,4,5", timeZoneId: "America/Los_Angeles", repeated: true, enabled: false,
  param: { id: 1, method: "server_scheduled_start", params: [{ name: "123456789", segments: "18,19", fan_power: 106, clean_order_mode: 0 }] },
  nextFireTime: "2026-10-12T15:10:00Z" };

function fixture({ selected = original, mutatePut, mutateGet, saveFailure = false } = {}) {
  const jobs = [clone(selected), { ...clone(original), id: 124 }];
  const calls = [], saved = [];
  let reads = 0, writes = 0;
  return { jobs, calls, saved, options: {
    collectionPath: "/user/devices/test-robot/jobs", jobId: "123", expectedCron: original.cron,
    timeZone: original.timeZoneId, now: new Date("2026-10-09T20:00:00Z"), wait: async () => {},
    saveOriginal: async (value) => { if (saveFailure) throw Error("disk full"); saved.push(clone(value)); },
    request: async (method, p, payload) => {
      calls.push({ method, p, payload: payload && clone(payload) });
      if (method === "GET") {
        reads++;
        if (mutateGet) mutateGet(jobs, reads);
        return { status: 200, data: { success: true, result: clone(jobs) } };
      }
      if (method === "OPTIONS") return { status: 200, allow: "PUT,DELETE,OPTIONS" };
      assert.equal(method, "PUT");
      assert.equal(p, "/user/devices/test-robot/jobs/123");
      assert.equal(saved.length, 1, "original must be saved before every write");
      assert.equal(payload.enabled, selected.enabled, "time edits must preserve the original cloud enabled flag");
      writes++;
      if (mutatePut) return mutatePut(jobs, payload, writes);
      jobs[0] = { ...clone(payload), id: 123, nextFireTime: "recalculated" };
      return { status: 200, data: { success: true } };
    },
  } };
}

test("changes one existing disabled job and restores every original field", async () => {
  const f = fixture();
  const report = await runTimeTrial(f.options);
  assert.equal(report.success, true);
  assert.equal(report.originalDefinitionRestored, true);
  assert.equal(report.otherJobsUnchanged, true);
  const writes = f.calls.filter((c) => c.method === "PUT");
  assert.equal(writes.length, 2);
  assert.equal(writes[0].payload.cron, "11 8 ? * 1,2,3,4,5");
  assert.equal(writes[1].payload.cron, original.cron);
  assert.deepEqual(writes[0].payload.param, original.param);
  assert.deepEqual(writes[1].payload.param, original.param);
  assert.equal(writes[0].payload.timeZoneId, original.timeZoneId);
  assert.equal("id" in writes[0].payload, false);
  assert.equal("nextFireTime" in writes[0].payload, false);
  assert.deepEqual(f.saved[0].original, original);
});

test("enabled jobs without explicit expectation, unexpected times and near-term runs are refused", async () => {
  for (const setup of [
    { selected: { ...original, enabled: true } },
    { selected: { ...original, cron: "11 8 ? * 1,2,3,4,5" } },
    { selected: { ...original, unexpected: 1 } },
  ]) {
    const f = fixture(setup);
    const r = await runTimeTrial(f.options);
    assert.equal(r.writeAttempts, 0);
    assert.equal(f.saved.length, 0);
    assert.equal(r.before.cloudEnabled, setup.selected.enabled);
    assert.equal(r.before.cron, setup.selected.cron);
  }
  const f = fixture();
  const r = await runTimeTrial({ ...f.options, now: new Date("2026-10-12T14:59:00Z") });
  assert.equal(r.error, "SCHEDULE_OCCURS_WITHIN_SIX_HOURS");
  assert.equal(r.writeAttempts, 0);
});

test("explicitly expected enabled job is edited and restored without changing its flag or task", async () => {
  const selected = { ...clone(original), enabled: true, cron: "15 9 ? * 1,2,4" };
  const f = fixture({ selected });
  const r = await runTimeTrial({ ...f.options, expectedCron: selected.cron, expectedEnabled: true });
  assert.equal(r.success, true);
  assert.equal(r.expectedCloudEnabled, true);
  assert.equal(r.otherJobsUnchanged, true);
  const writes = f.calls.filter((c) => c.method === "PUT");
  assert.equal(writes.length, 2);
  assert.deepEqual(writes.map((c) => c.payload.cron), ["16 9 ? * 1,2,4", selected.cron]);
  for (const write of writes) {
    assert.equal(write.payload.enabled, true);
    assert.deepEqual(write.payload.param, selected.param);
    assert.equal(write.payload.timeZoneId, selected.timeZoneId);
    assert.equal(write.payload.repeated, selected.repeated);
  }
  for (const reading of [r.before, r.proposed, r.afterChange, r.final]) {
    assert.equal(reading.cloudEnabled, true);
    assert.equal(reading.paramFingerprint, r.before.paramFingerprint);
  }
  assert.deepEqual(f.saved[0].original, selected);
  assert.deepEqual(f.jobs[0], { ...selected, nextFireTime: "recalculated" });
});

test("explicit enabled expectation rejects false, string, missing and invalid expected values", async () => {
  for (const enabled of [false, "true", undefined]) {
    const f = fixture({ selected: { ...original, enabled } });
    const r = await runTimeTrial({ ...f.options, expectedEnabled: true });
    assert.equal(r.error, "CLOUD_ENABLED_STATE_DOES_NOT_MATCH");
    assert.equal(r.writeAttempts, 0);
    assert.equal(f.saved.length, 0);
  }
  const f = fixture({ selected: { ...original, enabled: true } });
  const r = await runTimeTrial({ ...f.options, expectedEnabled: "true" });
  assert.equal(r.error, "INVALID_EXPECTED_CLOUD_STATE");
  assert.equal(r.writeAttempts, 0);
});

test("enabled trials retain the six-hour guard for both original and proposed times", async () => {
  for (const now of ["2026-10-12T09:10:00Z", "2026-10-12T15:11:00Z"]) {
    const f = fixture({ selected: { ...original, enabled: true } });
    const r = await runTimeTrial({ ...f.options, expectedEnabled: true, now: new Date(now) });
    assert.equal(r.error, "SCHEDULE_OCCURS_WITHIN_SIX_HOURS");
    assert.equal(r.writeAttempts, 0);
    assert.equal(f.saved.length, 0);
  }
});

test("cloud flag changes before or during an enabled trial are never overwritten", async () => {
  const before = fixture({ selected: { ...original, enabled: true },
    mutateGet: (jobs, count) => { if (count === 2) jobs[0].enabled = false; } });
  const beforeReport = await runTimeTrial({ ...before.options, expectedEnabled: true });
  assert.equal(beforeReport.error, "SCHEDULE_CHANGED_BEFORE_WRITE");
  assert.equal(beforeReport.writeAttempts, 0);
  const during = fixture({ selected: { ...original, enabled: true },
    mutatePut: (jobs, payload) => {
      jobs[0] = { ...clone(payload), id: 123, enabled: false };
      return { status: 200, data: { success: true } };
    } });
  const duringReport = await runTimeTrial({ ...during.options, expectedEnabled: true });
  assert.equal(duringReport.success, false);
  assert.equal(duringReport.writeAttempts, 1);
  assert.equal(duringReport.restorationError, "UNEXPECTED_CURRENT_DEFINITION_MANUAL_RESTORE_REQUIRED");
  assert.equal(during.jobs[0].enabled, false);
});

test("snapshot failure and concurrent change before write never mutate schedules", async () => {
  for (const setup of [
    { saveFailure: true },
    { mutateGet: (jobs, count) => { if (count === 2) jobs[0].param.params[0].fan_power = 104; } },
  ]) {
    const f = fixture(setup);
    const r = await runTimeTrial(f.options);
    assert.equal(r.writeAttempts, 0);
    assert.ok(!f.calls.some((c) => c.method === "PUT"));
  }
});

test("a lost change acknowledgement is resolved by reads then restoration", async () => {
  for (const enabled of [false, true]) {
    const f = fixture({ selected: { ...original, enabled }, mutatePut: (jobs, payload, count) => {
      jobs[0] = { ...clone(payload), id: 123 };
      if (count === 1) throw Error("timeout");
      return { status: 200, data: { success: true } };
    } });
    const r = await runTimeTrial({ ...f.options, expectedEnabled: enabled });
    assert.equal(r.success, true);
    assert.equal(r.writeAttempts, 2);
    assert.equal(r.afterChange.cron, "11 8 ? * 1,2,3,4,5");
    assert.equal(r.final.cloudEnabled, enabled);
  }
});

test("a lost restoration acknowledgement is checked rather than retried blindly", async () => {
  const f = fixture({ mutatePut: (jobs, payload, count) => {
    jobs[0] = { ...clone(payload), id: 123 };
    if (count === 2) throw Error("timeout");
    return { status: 200, data: { success: true } };
  } });
  const r = await runTimeTrial(f.options);
  assert.equal(r.success, true);
  assert.equal(r.writeAttempts, 2);
});

test("a rejected write does not claim time-edit support or send an unnecessary restore", async () => {
  const f = fixture({ mutatePut: () => ({ status: 400, data: { success: false, msg: "private-error" } }) });
  const r = await runTimeTrial(f.options);
  assert.equal(r.success, false);
  assert.equal(r.timeEditVerified, false);
  assert.equal(r.originalDefinitionRestored, true);
  assert.equal(r.writeAttempts, 1);
  assert.ok(!JSON.stringify(r).includes("private-error"));
});

test("unexpected task changes are not overwritten by automatic restoration", async () => {
  const f = fixture({ mutatePut: (jobs, payload) => {
    jobs[0] = { ...clone(payload), id: 123 };
    jobs[0].param.params[0].fan_power = 104;
    return { status: 200, data: { success: true } };
  } });
  const r = await runTimeTrial(f.options);
  assert.equal(r.success, false);
  assert.equal(r.originalDefinitionRestored, false);
  assert.equal(r.writeAttempts, 1);
  assert.equal(r.restorationError, "UNEXPECTED_CURRENT_DEFINITION_MANUAL_RESTORE_REQUIRED");
});

test("failed restoration cannot be reported as success", async () => {
  const f = fixture({ mutatePut: (jobs, payload, count) => {
    if (count === 2) throw Error("offline");
    jobs[0] = { ...clone(payload), id: 123 };
    return { status: 200, data: { success: true } };
  } });
  const r = await runTimeTrial(f.options);
  assert.equal(r.success, false);
  assert.equal(r.originalDefinitionRestored, false);
  assert.equal(r.final.cron, "11 8 ? * 1,2,3,4,5");
});

test("cancellation before write is respected", async () => {
  const f = fixture();
  const r = await runTimeTrial({ ...f.options, cancelled: () => true });
  assert.equal(r.writeAttempts, 0);
  assert.equal(r.error, "CANCELLED_BEFORE_WRITE");
});

test("transport signs exact sent bytes, blocks redirects and cannot write another job", async () => {
  const rriot = { u: "test-user", s: "test-session", h: "test-secret", r: { a: "https://api-us.roborock.com" } };
  const calls = [];
  const request = makeRequester(rriot, "/user/devices/test/jobs", "123", async (url, options) => {
    calls.push({ url, options });
    return { status: 200, headers: new Headers(), text: async () => '{"success":true}' };
  });
  const payload = { cron: "11 8 ? * 1,2,3,4,5", enabled: false, param: { name: "test-é" } };
  await request("PUT", "/user/devices/test/jobs/123", payload);
  assert.equal(calls[0].options.body, JSON.stringify(payload));
  assert.equal(calls[0].options.redirect, "error");
  const auth = calls[0].options.headers.Authorization;
  const nonce = /nonce="([^"]+)"/.exec(auth)[1], timestamp = Number(/ts="(\d+)"/.exec(auth)[1]);
  assert.equal(auth, buildHawkAuthorization(rriot, calls[0].url.pathname, calls[0].options.body, { nonce, timestamp }));
  await assert.rejects(request("PUT", "/user/devices/test/jobs/124", payload));
  await assert.rejects(request("DELETE", "/user/devices/test/jobs/123"));
  assert.equal(calls.length, 1);
  for (const address of ["http://api-us.roborock.com", "https://roborock.com.example.org", "https://example.org", "https://api-us.roborock.com:1234"]) {
    assert.throws(() => makeRequester({ ...rriot, r: { a: address } }, "/jobs", "123"));
  }
});

test("private originals cannot be overwritten and the execute flag is required", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "schedule-time-trial-"));
  const file = path.join(root, "original.json");
  try {
    writePrivate(file, original);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.throws(() => writePrivate(file, { wrong: true }));
    assert.deepEqual(JSON.parse(fs.readFileSync(file)), original);
  } finally { fs.rmSync(root, { recursive: true }); }
  assert.throws(() => argumentsFrom([]));
  assert.throws(() => argumentsFrom(["--execute", "--unknown", "yes"]));
});

test("CLI defaults to disabled and accepts only explicit boolean enabled expectations", () => {
  const args = ["--execute", "--storage", "/example", "--robot", "Test Robot", "--model", "test.model",
    "--job-id", "123", "--expect-cron", original.cron, "--timezone", original.timeZoneId, "--output", "/example/report"];
  assert.equal(argumentsFrom(args)["expect-enabled"], undefined);
  for (const value of ["true", "false"]) {
    assert.equal(argumentsFrom([...args, "--expect-enabled", value])["expect-enabled"], value);
  }
  for (const value of ["yes", "1", "TRUE", "--execute"]) {
    assert.throws(() => argumentsFrom([...args, "--expect-enabled", value]));
  }
  assert.throws(() => argumentsFrom([...args, "--expect-enabled", "true", "--expect-enabled", "false"]));
});

test("UI encrypted login works without UserData and takes precedence over a stale cache", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "schedule-session-"));
  const current = { token: "test-current-token", rriot: { u: "current-user", s: "current-session", h: "current-secret", r: { a: "https://api-us.roborock.com" } } };
  try {
    const encryptedToken = encryptSession(current, root);
    const configFile = path.join(root, "config.json"), keyFile = path.join(root, "roborock.token.key");
    const config = { platforms: [{ platform: "UnrelatedPlugin", password: "unrelated" }, { platform: "RoborockVacuumPlatform", encryptedToken }] };
    fs.writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
    const before = [fs.readFileSync(configFile), fs.readFileSync(keyFile)];
    const timestamps = [fs.statSync(configFile).mtimeMs, fs.statSync(keyFile).mtimeMs];
    assert.deepEqual(loadSavedSession(root), { rriot: current.rriot, source: "encryptedConfig" });
    assert.equal(fs.existsSync(path.join(root, "roborock.UserData")), false);
    fs.writeFileSync(path.join(root, "roborock.UserData"), JSON.stringify({ val: JSON.stringify({ token: "old", rriot: { u: "old-user" } }) }));
    assert.deepEqual(loadSavedSession(root), { rriot: current.rriot, source: "encryptedConfig" });
    assert.deepEqual([fs.readFileSync(configFile), fs.readFileSync(keyFile)], before);
    assert.deepEqual([fs.statSync(configFile).mtimeMs, fs.statSync(keyFile).mtimeMs], timestamps);
  } finally { fs.rmSync(root, { recursive: true }); }
});

test("missing, invalid and incorrect keys are never created or replaced", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "schedule-session-key-"));
  try {
    const encryptedToken = encryptSession({ token: "test-token", rriot: {} }, root);
    const keyFile = path.join(root, "roborock.token.key");
    const configFile = path.join(root, "config.json");
    fs.writeFileSync(configFile, JSON.stringify({ platforms: [{ platform: "RoborockVacuumPlatform", encryptedToken }] }));
    const configBefore = fs.readFileSync(configFile);
    fs.unlinkSync(keyFile);
    assert.throws(() => loadSavedSession(root), { code: "EXISTING_SESSION_KEY_UNAVAILABLE" });
    assert.equal(fs.existsSync(keyFile), false);
    for (const key of [Buffer.from("short"), Buffer.alloc(32)]) {
      fs.writeFileSync(keyFile, key);
      const before = fs.statSync(keyFile).mtimeMs;
      assert.throws(() => loadSavedSession(root));
      assert.deepEqual(fs.readFileSync(keyFile), key);
      assert.equal(fs.statSync(keyFile).mtimeMs, before);
    }
    assert.deepEqual(fs.readFileSync(configFile), configBefore);
  } finally { fs.rmSync(root, { recursive: true }); }
});

test("legacy cache remains supported and multiple platform accounts are refused", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "schedule-session-cache-"));
  try {
    const session = { token: "test-token", rriot: { u: "test-user" } };
    fs.writeFileSync(path.join(root, "roborock.UserData"), JSON.stringify({ val: JSON.stringify(session) }));
    assert.deepEqual(loadSavedSession(root), { rriot: session.rriot, source: "cachedUserData" });
    assert.equal(fs.existsSync(path.join(root, "roborock.token.key")), false);
    assert.equal(fs.existsSync(path.join(root, "config.json")), false);
    fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ platforms: [
      { platform: "RoborockVacuumPlatform", encryptedToken: "one" },
      { platform: "RoborockVacuumPlatform", encryptedToken: "two" },
    ] }));
    assert.throws(() => loadSavedSession(root), { code: "MULTIPLE_ROBOROCK_CONFIGS_REQUIRE_SELECTION" });
  } finally { fs.rmSync(root, { recursive: true }); }
});
