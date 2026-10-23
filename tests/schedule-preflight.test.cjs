"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  inspect,
  lastLoggedTimers,
} = require("../scripts/inspect-schedule-preflight.cjs");
const { makeRequester } = require("../scripts/test-schedule-time.cjs");

const job = {
  id: 123,
  cron: "15 9 ? * 1,2,4",
  timeZoneId: "America/Los_Angeles",
  repeated: true,
  enabled: true,
  param: {
    method: "server_scheduled_start",
    params: [
      { name: "123456789", fan_power: 104, localKey: "private-task-key" },
    ],
  },
};

test("one fresh GET distinguishes cloud state from historical timer state and masks secrets", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "schedule-preflight-"));
  try {
    fs.writeFileSync(
      path.join(root, "homebridge.log.1"),
      'Schedule discovery for private-robot: type=array, value=[["123456789","on",0]]\n'
    );
    fs.writeFileSync(
      path.join(root, "homebridge.log"),
      'private password=private-password\n\x1b[32mSchedule discovery for private-robot: type=array, value=[["123456789","off",0]]\x1b[0m\n'
    );
    const calls = [];
    const report = await inspect({
      storage: root,
      duid: "private-robot",
      jobId: "123",
      collectionPath: "/jobs",
      request: async (method, requestPath) => {
        calls.push([method, requestPath]);
        return {
          status: 200,
          data: { success: true, result: [job, { ...job, id: 124 }] },
        };
      },
    });
    assert.deepEqual(calls, [["GET", "/jobs"]]);
    assert.equal(report.writeAttempts, 0);
    assert.equal(report.robotPauseStateChecked, false);
    assert.equal(report.robotTimerObservation.historicalOnly, true);
    assert.equal(report.robotTimerObservation.observedAt, null);
    assert.equal(report.jobs[0].selected, true);
    assert.equal(report.jobs[1].selected, false);
    assert.equal(report.jobs[0].cloudEnabled, true);
    assert.equal(report.jobs[0].cloudEnabledType, "boolean");
    assert.equal(report.jobs[0].timerStateFromLog, "off");
    assert.equal(report.jobs[0].matchingLoggedTimers, 1);
    assert.ok(
      Date.parse(report.cloudReceivedAt) >= Date.parse(report.cloudRequestedAt)
    );
    for (const secret of [
      "private-task-key",
      "private-password",
      "private-robot",
    ])
      assert.ok(!JSON.stringify(report).includes(secret));
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

test("missing logs remain unknown and string flags are not silently converted", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "schedule-preflight-missing-")
  );
  try {
    const report = await inspect({
      storage: root,
      duid: "robot",
      jobId: "999",
      collectionPath: "/jobs",
      request: async () => ({
        status: 200,
        data: { success: true, result: [{ ...job, enabled: "false" }] },
      }),
    });
    assert.equal(report.selectedJobFound, false);
    assert.equal(report.jobs[0].cloudEnabled, "false");
    assert.equal(report.jobs[0].cloudEnabledType, "string");
    assert.equal(report.jobs[0].timerStateFromLog, "unknown");
    assert.equal(report.robotTimerObservation.entryCount, null);
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

test("unrelated robots and malformed log entries cannot supply a timer observation", () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "schedule-preflight-log-")
  );
  try {
    fs.writeFileSync(
      path.join(root, "homebridge.log"),
      'Schedule discovery for another-robot: type=array, value=[["123456789","on"]]\nSchedule discovery for robot: type=array, value=[["123456789","off"\n'
    );
    assert.equal(lastLoggedTimers(root, "robot").timers, null);
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

test("read-only transport blocks PUT and OPTIONS before any fetch", async () => {
  let calls = 0;
  const request = makeRequester(
    {
      u: "test-user",
      s: "test-session",
      h: "test-secret",
      r: { a: "https://api-us.roborock.com" },
    },
    "/jobs",
    "123",
    async () => {
      calls++;
      return {
        status: 200,
        headers: new Headers(),
        text: async () => '{"success":true,"result":[]}',
      };
    },
    { readOnly: true }
  );
  await assert.rejects(request("PUT", "/jobs/123", { enabled: false }), {
    code: "READ_ONLY_REQUEST_REQUIRED",
  });
  await assert.rejects(request("OPTIONS", "/jobs/123"), {
    code: "READ_ONLY_REQUEST_REQUIRED",
  });
  assert.equal(calls, 0);
  await request("GET", "/jobs");
  assert.equal(calls, 1);
});

test("explicit method inspection reads once and probes only the selected job", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "schedule-methods-"));
  const collectionPath = "/user/devices/robot/jobs";
  const calls = [];
  try {
    const report = await inspect({
      storage: root,
      duid: "robot",
      jobId: "124",
      collectionPath,
      probeMethods: true,
      request: async (method, requestPath) => {
        calls.push([method, requestPath]);
        if (method === "GET")
          return {
            status: 200,
            data: { success: true, result: [job, { ...job, id: 124 }] },
          };
        return {
          status: requestPath.endsWith("no-such-subresource-control")
            ? 404
            : 200,
          allow: "GET, PUT, OPTIONS",
        };
      },
    });
    assert.deepEqual(calls, [
      ["GET", collectionPath],
      ["OPTIONS", collectionPath],
      ["OPTIONS", `${collectionPath}/124`],
      ["OPTIONS", `${collectionPath}/124/no-such-subresource-control`],
    ]);
    assert.equal(report.writeAttempts, 0);
    assert.deepEqual(
      report.methodChecks.map((check) => check.ok),
      [true, true, false]
    );
    assert.equal(report.methodChecks[2].status, 404);
    assert.ok(!JSON.stringify(report).includes("private-task-key"));
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

test("explicit probes cannot enable writes, request bodies or other job routes", async () => {
  const calls = [];
  const request = makeRequester(
    {
      u: "user",
      s: "session",
      h: "secret",
      r: { a: "https://api-us.roborock.com" },
    },
    "/jobs",
    "123",
    async (url, options) => {
      calls.push([url.pathname, options.method, options.body]);
      return { status: 200, headers: new Headers({ allow: "GET,OPTIONS" }) };
    },
    { readOnly: true, allowMethodProbes: true }
  );
  for (const method of ["PUT", "POST", "PATCH", "DELETE"])
    await assert.rejects(request(method, "/jobs/123", {}), {
      code: "READ_ONLY_REQUEST_REQUIRED",
    });
  await assert.rejects(request("OPTIONS", "/jobs/124"), {
    code: "READ_ONLY_REQUEST_REQUIRED",
  });
  await assert.rejects(request("OPTIONS", "/jobs/123", {}), {
    code: "READ_ONLY_REQUEST_REQUIRED",
  });
  assert.equal(calls.length, 0);
  for (const route of [
    "/jobs",
    "/jobs/123",
    "/jobs/123/no-such-subresource-control",
  ])
    await request("OPTIONS", route);
  assert.deepEqual(calls, [
    ["/jobs", "OPTIONS", undefined],
    ["/jobs/123", "OPTIONS", undefined],
    ["/jobs/123/no-such-subresource-control", "OPTIONS", undefined],
  ]);
});

test("an absent selected job never causes method probes", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "schedule-methods-absent-")
  );
  const calls = [];
  try {
    const report = await inspect({
      storage: root,
      duid: "robot",
      jobId: "999",
      collectionPath: "/jobs",
      probeMethods: true,
      request: async (method) => {
        calls.push(method);
        return { status: 200, data: { success: true, result: [job] } };
      },
    });
    assert.deepEqual(calls, ["GET"]);
    assert.equal(report.selectedJobFound, false);
    assert.deepEqual(report.methodChecks, []);
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});
