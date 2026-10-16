"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { inspectCloudJobs, scheduleShape } = require("../roborockLib/lib/inspectCloudJobs");

function job(id = 47) {
  return { id, cron: "15 9 ? * 1,2,4", timeZoneId: "America/Los_Angeles",
    enabled: true, repeated: true, param: { method: "do_timer",
      params: JSON.stringify({ timer: ["123456789", "off", { segments: Array.from({ length: 80 }, (_, sid) => ({ sid, fan_power: 102 })) }],
        password: "nested-password", name: "private-room", localKey: "private-key" }) } };
}

test("complete nested settings survive string and array limits; secrets do not", () => {
  const input = job();
  const before = JSON.stringify(input);
  assert.ok(input.param.params.length > 500);
  const shape = scheduleShape(input);
  assert.equal(shape.param.method, "do_timer");
  assert.equal(shape.param.params.jsonString.timer[1], "off");
  assert.equal(shape.param.params.jsonString.timer[2].segments.length, 80);
  assert.equal(shape.timeZoneId, "America/Los_Angeles");
  for (const secret of ["nested-password", "private-room", "private-key"]) {
    assert.ok(!JSON.stringify(shape).includes(secret));
  }
  assert.equal(JSON.stringify(input), before);
});

test("nine jobs survive and only three bounded OPTIONS requests run", async () => {
  const calls = [];
  const api = { options: async (p, config) => {
    calls.push({ p, config });
    if (p.endsWith("no-such-subresource-control")) {
      throw { response: { status: 404, headers: { "set-cookie": "private-cookie" } } };
    }
    return { status: 200, headers: { allow: "PUT, OPTIONS", authorization: "private-auth" } };
  } };
  const jobs = Array.from({ length: 9 }, (_, i) => job(i + 1));
  const before = JSON.stringify(jobs);
  const report = await inspectCloudJobs(api, "robot", jobs);
  assert.equal(report.jobs.length, 9);
  assert.deepEqual(calls.map((c) => c.p), ["user/devices/robot/jobs", "user/devices/robot/jobs/1", "user/devices/robot/jobs/1/no-such-subresource-control"]);
  assert.ok(calls.every((c) => c.config.timeout === 10000));
  assert.deepEqual(report.methodChecks[1].allow, ["PUT", "OPTIONS"]);
  assert.equal(report.methodChecks[2].status, 404);
  assert.equal(report.methodChecks[2].ok, false);
  assert.match(report.jobs[0].paramFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(jobs), before);
  for (const secret of ["private-cookie", "private-auth", "private-key"]) assert.ok(!JSON.stringify(report).includes(secret));
});

test("unsupported shapes and empty results never cause extra requests", async () => {
  const api = { options: () => { throw new Error("unexpected request"); } };
  assert.equal(await inspectCloudJobs(api, "robot", {}), null);
  assert.deepEqual((await inspectCloudJobs(api, "robot", [])).jobs, []);
  assert.deepEqual((await inspectCloudJobs(api, "robot", [{ id: "../other", cron: "0 9 * * *", param: {} }])).methodChecks, []);
});

test("OPTIONS failures stay data and do not leak response bodies", async () => {
  const report = await inspectCloudJobs({ options: async () => {
    throw { response: { status: 401, data: { token: "private-token" }, headers: { get: () => "GET,OPTIONS" } } };
  } }, "robot", [job()]);
  assert.equal(report.methodChecks.length, 3);
  assert.ok(report.methodChecks.every((c) => !c.ok && c.status === 401));
  assert.ok(!JSON.stringify(report).includes("private-token"));
});

test("fingerprint changes with task settings but not with time", async () => {
  const api = { options: async () => ({ status: 200, headers: {} }) };
  const original = job();
  const changedTime = { ...original, cron: "15 10 ? * 1,2,4" };
  const changedTask = { ...original, param: { ...original.param, params: "[99]" } };
  const reports = await Promise.all([original, changedTime, changedTask].map((j) => inspectCloudJobs(api, "robot", [j])));
  assert.equal(reports[0].jobs[0].paramFingerprint, reports[1].jobs[0].paramFingerprint);
  assert.notEqual(reports[0].jobs[0].paramFingerprint, reports[2].jobs[0].paramFingerprint);
});

// Load the real API class without opening any connection. Unused dependencies
// are stubs; the diagnostic helper is the actual implementation under test.
function adapter(debug, api) {
  const filename = path.resolve(__dirname, "../roborockLib/roborockAPI.js");
  const source = fs.readFileSync(filename, "utf8");
  const module = { exports: {} };
  vm.runInNewContext(source, { module, exports: module.exports, require: (id) => {
    if (id === "./lib/inspectCloudJobs") return { inspectCloudJobs };
    if (id === "./lib/parseCloudSceneSchedules") return { parseCloudSceneSchedules: () => [], summariseCloudSceneSchedules: () => [] };
    return {};
  } }, { filename });
  const result = Object.create(module.exports.Roborock.prototype);
  result.config = { debug };
  result.api = api;
  result.log = { debug: (message) => result.lines.push(message) };
  result.lines = [];
  result.describeDevice = () => "Test robot";
  result.updateRoborockDiagnostics = async () => {};
  return result;
}

test("real integration is debug-only, once per robot, and never writes", async () => {
  const calls = [];
  const client = {
    get: async (p) => { calls.push(["GET", p]); return { data: { result: p.endsWith("/jobs") ? [job()] : [] }, headers: {} }; },
    options: async (p) => { calls.push(["OPTIONS", p]); return { status: 200, headers: { allow: "PUT,OPTIONS" } }; },
  };
  const disabled = adapter(false, client);
  await disabled.probeCloudScheduleRoutes("robot");
  assert.equal(calls.length, 0);
  const enabled = adapter(true, client);
  await enabled.probeCloudScheduleRoutes("robot");
  await enabled.probeCloudScheduleRoutes("robot");
  assert.equal(calls.length, 5);
  assert.equal(enabled.lines.filter((l) => l.startsWith("Schedule time inspection for robot:")).length, 1);
  const record = JSON.parse(enabled.lines.find((l) => l.startsWith("Schedule time inspection for robot:")).split("value=")[1]);
  assert.equal(record.jobs[0].definition.param.method, "do_timer");
});
