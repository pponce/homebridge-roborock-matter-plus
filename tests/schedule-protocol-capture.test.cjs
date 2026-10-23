"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  ScheduleProtocolCapture,
  startScheduleProtocolCapture,
  readLatestScheduleCapture,
  createSanitizer,
  describeRoute,
} = require("../roborockLib/lib/scheduleProtocolCapture");

function interceptors() {
  const handlers = new Map();
  let id = 0;
  return {
    handlers,
    use(ok, fail) {
      handlers.set(++id, { ok, fail });
      return id;
    },
    eject(key) {
      handlers.delete(key);
    },
  };
}

function fixture(t, options = {}) {
  const storagePath = fs.mkdtempSync(
    path.join(os.tmpdir(), "schedule-capture-")
  );
  const calls = [];
  const api = {
    interceptors: { request: interceptors(), response: interceptors() },
    async get(url) {
      calls.push({ verb: "GET", url });
      return { data: { result: [] } };
    },
  };
  const adapter = {
    config: { storagePath, enableScheduleProtocolCapture: true },
    log: { info() {}, warn() {} },
    devices: [{ duid: "private-robot" }],
    getProductAttribute: () => "roborock.vacuum.a27",
    isB01Device: () => false,
    api,
    messageQueueHandler: {
      async sendRequest(duid, method, params) {
        calls.push({ duid, method, params });
        return this.exchangeOverCloud({ duid, method, params, messageID: 123 });
      },
      async exchangeOverCloud() {
        return [["private-timer", "off", ["0 9 * * 1", "start_clean", {}]]];
      },
      async exchangeOverLocal() {
        return [];
      },
    },
  };
  const original = adapter.messageQueueHandler.sendRequest;
  const capture = new ScheduleProtocolCapture(adapter, {
    snapshots: false,
    ...options,
  });
  t.after(() => {
    capture.stop();
    fs.rmSync(storagePath, { recursive: true, force: true });
  });
  const records = () =>
    fs.readFileSync(capture.file, "utf8").trim().split("\n").map(JSON.parse);
  return { adapter, capture, calls, records, original, storagePath };
}

test("disabled by default: no file, observer or extra request", () => {
  assert.equal(startScheduleProtocolCapture({ config: {} }), null);
  assert.equal(
    startScheduleProtocolCapture({
      config: { enableScheduleProtocolCapture: "true" },
    }),
    null
  );
});

test("sanitizes nested JSON, preserves job/timer linkage and complete lists", () => {
  const s = createSanitizer();
  const value = {
    enabled: true,
    timeZoneId: "America/Los_Angeles",
    cron: "15 9 * * 1,2,4",
    localKey: "TOP-SECRET-KEY",
    password: 123456,
    param: JSON.stringify({
      method: "server_scheduled_start",
      params: [{ name: "secret-timer", fan: 102, token: "TOP-SECRET-TOKEN" }],
    }),
    timers: [["secret-timer", "off"]],
    jobs: Array.from({ length: 15 }, (_, id) => ({
      id,
      cron: "15 9 * * 1,2,4",
    })),
  };
  const sanitized = s.clean(value);
  assert.equal(sanitized.enabled, true);
  assert.equal(sanitized.cron, value.cron);
  assert.equal(sanitized.timeZoneId, value.timeZoneId);
  assert.equal(sanitized.jobs.length, 15);
  assert.equal(sanitized.param.jsonString.method, "server_scheduled_start");
  assert.deepEqual(
    sanitized.param.jsonString.params[0].name,
    sanitized.timers[0][0]
  );
  assert.equal(sanitized.jobs[0].id.type, "number");
  assert.equal(sanitized.param.jsonString.params[0].fan, 102);
  assert(!JSON.stringify(sanitized).includes("TOP-SECRET"));
  assert(!JSON.stringify(sanitized).includes("secret-timer"));
  assert.equal(sanitized.password, "<redacted>");
  assert.notEqual(s.ref("secret-timer"), createSanitizer().ref("secret-timer"));
});

test("keeps next-fire timestamps without exposing the same text in identity fields", () => {
  const s = createSanitizer();
  for (const nextFireTime of [
    "2026-10-24T15:45:00Z",
    "2026-10-24T15:45:00.123456789Z",
    "2026-10-24T08:45:00-07:00",
    "2026-10-24T08:45:00.000-0700",
    "2026-10-24 08:45:00",
    "2026-10-24 08:45:00.000",
    "1792856700",
    "1792856700000",
    1792856700000,
    null,
  ]) {
    const value = { nextFireTime };
    assert.deepEqual(s.clean(value), value);
    assert.deepEqual(s.clean(JSON.stringify(value)), { jsonString: value });
  }

  const timestamp = "2026-10-24T15:45:00Z";
  const cleaned = s.clean({
    nextFireTime: timestamp,
    name: timestamp,
    jobId: timestamp,
    note: timestamp,
    token: timestamp,
  });
  assert.equal(cleaned.nextFireTime, timestamp);
  assert.equal(cleaned.name.type, "string");
  assert.equal(cleaned.jobId.type, "string");
  assert.equal(cleaned.note.type, "string");
  assert.equal(cleaned.token, "<redacted>");
  for (const nextFireTime of [
    "tomorrow",
    "2026-10-24T15:45:00Z SECRET",
    "https://example.invalid/?token=SECRET",
    "1792856700000-SECRET",
  ]) {
    assert.equal(s.clean({ nextFireTime }).nextFireTime.type, "string");
    assert(!JSON.stringify(s.clean({ nextFireTime })).includes("SECRET"));
  }
});

test("keeps numeric room-list strings and nested JSON while masking labels", () => {
  const s = createSanitizer();
  for (const segments of ["", "18", "18,19", " 18, 19,20 ", [18, 19]]) {
    const value = { segments };
    assert.deepEqual(s.clean(value), value);
    assert.deepEqual(s.clean(JSON.stringify(value)), { jsonString: value });
  }
  const rooms = Array.from({ length: 500 }, (_, i) => i + 1).join(",");
  assert.equal(s.clean({ segments: rooms }).segments, rooms);
  for (const segments of [
    rooms + ",501",
    "18,Kitchen",
    "18,19;token=SECRET",
    "18,19\nSECRET",
  ]) {
    assert.equal(s.clean({ segments }).segments.type, "string");
    assert(!JSON.stringify(s.clean({ segments })).includes("SECRET"));
  }
  const cleaned = s.clean({
    segments: "18,19",
    name: "18,19",
    timerId: "18,19",
    note: "18,19",
    localKey: "18,19",
  });
  assert.equal(cleaned.segments, "18,19");
  assert.equal(cleaned.name.type, "string");
  assert.equal(cleaned.timerId.type, "string");
  assert.equal(cleaned.note.type, "string");
  assert.equal(cleaned.localKey, "<redacted>");
});

test("unexpected diagnostic values fail closed", () => {
  const s = createSanitizer();
  const cycle = {};
  cycle.child = cycle;
  assert(JSON.stringify(s.clean(cycle)).includes("<depth limit>"));
  const getters = Object.defineProperty({}, "secret", {
    enumerable: true,
    get() {
      throw new Error("SECRET");
    },
  });
  assert.equal(s.clean(getters), "<unavailable>");
  assert(
    !JSON.stringify(
      s.clean({ note: "SECRET", val: '{"password":"SECRET"}' })
    ).includes("SECRET")
  );
});

test("only schedule HTTP routes qualify, with no host, headers or query", () => {
  const { ref } = createSanitizer();
  assert.equal(describeRoute({ url: "/login?token=SECRET" }, ref), null);
  assert.equal(describeRoute({ url: "/user/homes/123" }, ref), null);
  const result = describeRoute(
    {
      url: "https://private.example/user/devices/private-robot/jobs/private-job?token=SECRET",
    },
    ref
  );
  assert.equal(result.route, "/user/devices/{robot}/jobs/{job}");
  assert(!JSON.stringify(result).includes("private"));
  assert(!JSON.stringify(result).includes("SECRET"));
  assert.equal(
    describeRoute({ url: "/user/scene/123/param" }, ref).route,
    "/user/scene/{scene}/param"
  );
});

test("RPC observes payload and selected transport; preserves original result and receiver", async (t) => {
  const h = fixture(t);
  const result = await h.adapter.messageQueueHandler.sendRequest(
    "private-robot",
    "upd_timer",
    ["private-timer", "off"]
  );
  assert.equal(result[0][0], "private-timer");
  const records = h.records();
  const request = records.find((r) => r.event === "rpc-request");
  const response = records.find((r) => r.event === "rpc-response");
  const attempt = records.find((r) => r.event === "rpc-transport-attempt");
  assert.equal(attempt.transport, "mqtt");
  assert.equal(attempt.callId, request.callId);
  assert.equal(response.callId, request.callId);
  assert.deepEqual(response.result[0][0], request.params[0]);
  assert(!JSON.stringify(records).includes("private-robot"));
  assert(!JSON.stringify(records).includes("private-timer"));
  const count = records.length;
  await h.adapter.messageQueueHandler.sendRequest(
    "private-robot",
    "get_network_info",
    []
  );
  assert.equal(h.records().length, count);
});

test("RPC errors and concurrent calls retain their identities", async (t) => {
  const h = fixture(t);
  const failure = new Error("Robot PRIVATE rejected -10007");
  h.adapter.messageQueueHandler.exchangeOverCloud = async (context) => {
    if (context.method === "get_timer") throw failure;
    return ["ok"];
  };
  const results = await Promise.allSettled([
    h.adapter.messageQueueHandler.sendRequest("private-robot", "get_timer", []),
    h.adapter.messageQueueHandler.sendRequest(
      "private-robot",
      "get_server_timer",
      []
    ),
  ]);
  assert.equal(results[0].reason, failure);
  assert.deepEqual(results[1].value, ["ok"]);
  const error = h.records().find((r) => r.event === "rpc-error");
  assert.equal(error.robotCode, "-10007");
  assert(!JSON.stringify(h.records()).includes("PRIVATE"));
  assert.equal(
    new Set(
      h
        .records()
        .filter((r) => r.event === "rpc-request")
        .map((r) => r.callId)
    ).size,
    2
  );
});

test("HTTP interceptors preserve signed body, headers, response and error", async (t) => {
  const h = fixture(t);
  const requestHook = [
    ...h.adapter.api.interceptors.request.handlers.values(),
  ][0];
  const responseHook = [
    ...h.adapter.api.interceptors.response.handlers.values(),
  ][0];
  const config = {
    url: "user/devices/private-robot/jobs/123",
    method: "put",
    data: JSON.stringify({ cron: "0 9 * * *", token: "SECRET" }),
    headers: { Authorization: "SECRET" },
  };
  const before = JSON.stringify(config);
  assert.equal(requestHook.ok(config), config);
  assert.equal(JSON.stringify(config), before);
  const response = { config, status: 200, data: { success: true } };
  assert.equal(responseHook.ok(response), response);
  const error = Object.assign(new Error("SECRET"), {
    config,
    response: { config, status: 400, data: { error: "SECRET" } },
  });
  await assert.rejects(
    responseHook.fail(error),
    (received) => received === error
  );
  const records = h.records();
  assert(records.some((r) => r.event === "http-request" && r.verb === "PUT"));
  assert(records.some((r) => r.event === "http-error" && r.status === 400));
  assert(!JSON.stringify(records).includes("SECRET"));
  assert(!JSON.stringify(records).includes("Authorization"));
});

test("snapshot adds only reads and records HTTP and RPC failures separately", async (t) => {
  const h = fixture(t);
  await h.capture.snapshot();
  assert.deepEqual(
    h.calls.filter((r) => r.verb).map((r) => r.verb),
    ["GET", "GET"]
  );
  assert.deepEqual(
    h.calls.filter((r) => r.method).map((r) => r.method),
    ["get_server_timer", "get_timer", "get_timezone", "get_status"]
  );
  assert(
    h.records().some((r) => r.event === "snapshot-end" && r.atomic === false)
  );
  h.adapter.config.isScheduleOperationPending = () => true;
  const count = h.calls.length;
  await h.capture.snapshot();
  assert.equal(h.calls.length, count);
  h.adapter.config.isScheduleOperationPending = () => false;
  h.adapter.api.get = async () => {
    throw Object.assign(new Error("SECRET"), { response: { status: 503 } });
  };
  await h.capture.snapshot();
  assert(
    h
      .records()
      .some(
        (r) =>
          r.event === "snapshot-read-error" &&
          r.read === "jobs" &&
          r.status === 503
      )
  );
});

test("captures form fields and final JSON serialization without exposing headers", (t) => {
  const h = fixture(t);
  const request = [...h.adapter.api.interceptors.request.handlers.values()][0]
    .ok;
  const response = [...h.adapter.api.interceptors.response.handlers.values()][0]
    .ok;
  const form = {
    url: "user/scene/12/enable",
    method: "put",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "SECRET",
    },
    data: "enabled=true&enabled=false&token=SECRET",
  };
  assert.equal(request(form), form);
  response({ config: form, status: 200, data: { success: true } });
  const fields = h.records().find((r) => r.event === "http-request").body.form;
  assert.deepEqual(fields, [
    { enabled: "true" },
    { enabled: "false" },
    { token: "<redacted>" },
  ]);
  const json = {
    url: "user/devices/robot/jobs/12",
    method: "put",
    headers: { "Content-Type": "application/json" },
    data: { cron: "0 9 * * *" },
  };
  request(json);
  json.data = JSON.stringify(json.data);
  response({ config: json, status: 200, data: { success: true } });
  const final = h.records().at(-1);
  assert.equal(final.requestBody.contentType, "application/json");
  assert.equal(final.requestBody.value.jsonString.cron, "0 9 * * *");
  assert(!JSON.stringify(h.records()).includes("SECRET"));
  assert(!JSON.stringify(h.records()).includes("Authorization"));
});

test("records room lists and next-fire read-back across JSON and form requests", (t) => {
  const h = fixture(t);
  const request = [...h.adapter.api.interceptors.request.handlers.values()][0]
    .ok;
  const response = [...h.adapter.api.interceptors.response.handlers.values()][0]
    .ok;
  const param = JSON.stringify({
    method: "server_scheduled_start",
    params: [{ name: "private-timer", segments: "18, 19", fan_power: 104 }],
  });
  const payload = { cron: "45 9 ? * 0,6", param, token: "SECRET" };
  const job = {
    ...payload,
    id: 123456,
    nextFireTime: "2026-10-24T16:45:00Z",
  };
  const before = JSON.stringify({ payload, job });
  for (const contentType of [
    "application/json",
    "application/x-www-form-urlencoded",
  ]) {
    const config = {
      url: "user/devices/private-robot/jobs/123456",
      method: "put",
      headers: { "Content-Type": contentType, Authorization: "SECRET" },
      data:
        contentType === "application/json"
          ? payload
          : new URLSearchParams(payload).toString(),
    };
    const originalData = config.data;
    assert.equal(request(config), config);
    assert.equal(config.data, originalData);
    if (contentType === "application/json") {
      config.data = JSON.stringify(payload);
    }
    const reply = { config, status: 200, data: { result: [job] } };
    const serializedData = config.data;
    assert.equal(response(reply), reply);
    assert.equal(config.data, serializedData);

    const recorded = h.records().at(-1);
    const savedJob = recorded.body.result[0];
    assert.equal(savedJob.nextFireTime, job.nextFireTime);
    assert.equal(savedJob.param.jsonString.params[0].segments, "18, 19");
    assert.equal(savedJob.param.jsonString.params[0].name.type, "string");
    assert.equal(savedJob.token, "<redacted>");
    const sent =
      contentType === "application/json"
        ? recorded.requestBody.value.jsonString
        : Object.assign({}, ...recorded.requestBody.form);
    assert.equal(sent.param.jsonString.params[0].segments, "18, 19");
    assert.equal(sent.token, "<redacted>");
  }
  assert.equal(JSON.stringify({ payload, job }), before);
  const records = h.records();
  assert.equal(records[0].formatVersion, 2);
  assert(!JSON.stringify(records).includes("SECRET"));
  assert(!JSON.stringify(records).includes("private-timer"));
  assert(!JSON.stringify(records).includes("private-robot"));
});

test("snapshots do not send classic RPC to B01 robots and stop on rate limiting", async (t) => {
  const h = fixture(t);
  h.adapter.isB01Device = () => true;
  await h.capture.snapshot();
  assert.equal(h.calls.filter((r) => r.method).length, 0);
  let count = 0;
  h.adapter.api.get = async () => {
    count++;
    throw { response: { status: 429 } };
  };
  await h.capture.snapshot();
  assert.equal(count, 1);
  assert.equal(h.capture.active, false);
  assert.equal(h.records().at(-1).reason, "http-rate-limit");
});

test("failed diagnostic reads are bounded and snapshots cannot overlap", async (t) => {
  const h = fixture(t);
  let count = 0;
  h.adapter.api.get = async () => {
    count++;
    throw new Error("unavailable");
  };
  for (let i = 0; i < 5; i++) await h.capture.snapshot();
  assert.equal(count, 6);
  h.capture.snapshotRunning = true;
  await h.capture.snapshot();
  assert.equal(count, 6);
});

test("status reads recover after an outage without restarting capture", async (t) => {
  const h = fixture(t);
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  let offline = true;
  let statusCalls = 0;
  h.adapter.messageQueueHandler.exchangeOverCloud = async ({ method }) => {
    if (method !== "get_status") return [];
    statusCalls++;
    if (offline) throw new Error("Robot PRIVATE timed out");
    return [{ state: 8, clean_time: 0 }];
  };
  for (let i = 0; i < 3; i++) await h.capture.snapshot();
  offline = false;
  await h.capture.snapshot();
  assert.equal(statusCalls, 3);
  assert(h.records().some((r) => r.event === "snapshot-read-skipped"));
  now += 120000;
  await h.capture.snapshot();
  assert.equal(statusCalls, 4);
  const recovered = h
    .records()
    .find((r) => r.event === "snapshot-read-recovered");
  assert.equal(recovered.read, "get_status");
  assert.equal(recovered.consecutiveFailures, 3);
  assert(
    h
      .records()
      .some(
        (r) =>
          r.event === "rpc-response" &&
          r.method === "get_status" &&
          r.result[0].state === 8
      )
  );
  assert.equal(h.capture.active, true);
  assert(!JSON.stringify(h.records()).includes("PRIVATE"));
  // One later failure must not inherit the old outage's cooldown or count.
  offline = true;
  await h.capture.snapshot();
  offline = false;
  await h.capture.snapshot();
  assert.equal(statusCalls, 6);
  assert.equal(
    h
      .records()
      .filter((r) => r.event === "snapshot-read-recovered")
      .at(-1).consecutiveFailures,
    1
  );
});

test("continued failure probes are spaced out and stop at the capture deadline", async (t) => {
  const h = fixture(t);
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  let calls = 0;
  h.adapter.api.get = async () => {
    calls++;
    throw new Error("unavailable");
  };
  for (let i = 0; i < 3; i++) await h.capture.snapshot();
  assert.equal(calls, 6);
  now += 120000;
  await h.capture.snapshot();
  assert.equal(calls, 8);
  now += 60000;
  await h.capture.snapshot();
  assert.equal(calls, 8);
  now += 60000;
  await h.capture.snapshot();
  assert.equal(calls, 10);
  h.capture.stop();
  now += 120000;
  await h.capture.snapshot();
  assert.equal(calls, 10);
  const expiring = fixture(t);
  expiring.adapter.api.get = h.adapter.api.get;
  now = expiring.capture.deadline;
  await expiring.capture.snapshot();
  assert.equal(calls, 10);
  assert.equal(expiring.capture.active, false);
});

test("HTTP recovery is independent of RPC failures and 429 still stops capture", async (t) => {
  const h = fixture(t);
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  let status = 503;
  h.adapter.api.get = async () => {
    if (status) throw { response: { status } };
    return { data: { result: [] } };
  };
  for (let i = 0; i < 3; i++) await h.capture.snapshot();
  status = 0;
  now += 120000;
  await h.capture.snapshot();
  assert.deepEqual(
    h
      .records()
      .filter((r) => r.event === "snapshot-read-recovered")
      .map((r) => r.read),
    ["jobs", "scenes"]
  );
  status = 429;
  await h.capture.snapshot();
  assert.equal(h.capture.active, false);
  assert.equal(h.records().at(-1).reason, "http-rate-limit");
});

test("size limit detaches observers without interrupting a command", async (t) => {
  const h = fixture(t, { maxBytes: 2500 });
  const result = await h.adapter.messageQueueHandler.sendRequest(
    "private-robot",
    "set_timer",
    [{ settings: Array(500).fill(999999) }]
  );
  assert.equal(result[0][0], "private-timer");
  assert.equal(h.capture.active, false);
  assert.equal(h.adapter.messageQueueHandler.sendRequest, h.original);
  assert.equal(h.adapter.api.interceptors.request.handlers.size, 0);
  assert(fs.statSync(h.capture.file).size <= 2500);
  assert.equal(h.records().at(-1).reason, "size-limit");
});

test("deadline and shutdown close files and leave no capture timers", async (t) => {
  const h = fixture(t);
  h.capture.deadline = Date.now() - 1;
  await h.capture.snapshot();
  assert.equal(h.capture.active, false);
  assert.equal(h.capture.fd, undefined);
  assert.equal(h.records().at(-1).reason, "time-limit");
  h.capture.stop();
  assert.equal(h.records().filter((r) => r.event === "capture-end").length, 1);
});

test("download uses only bounded regular capture files, including an active capture", (t) => {
  const h = fixture(t);
  const report = readLatestScheduleCapture(h.storagePath);
  assert.equal(report.ok, true);
  assert.equal(report.content, fs.readFileSync(h.capture.file, "utf8"));
  assert.equal(fs.statSync(h.capture.file).mode & 0o777, 0o600);
  const dir = path.dirname(h.capture.file);
  const name = "schedule-9999999999999-aaaaaaaaaaaaaaaa.jsonl";
  fs.symlinkSync(h.capture.file, path.join(dir, name));
  assert.equal(readLatestScheduleCapture(h.storagePath).ok, false);
  fs.unlinkSync(path.join(dir, name));
  fs.writeFileSync(path.join(dir, name), "x".repeat(2 * 1024 * 1024 + 1));
  assert.equal(readLatestScheduleCapture(h.storagePath).ok, false);
});

test("unavailable storage leaves robot control usable", () => {
  const original = () => Promise.resolve("ok");
  const adapter = {
    config: {},
    log: { info() {}, warn() {} },
    messageQueueHandler: { sendRequest: original },
  };
  const capture = new ScheduleProtocolCapture(adapter);
  assert.equal(capture.active, false);
  assert.equal(adapter.messageQueueHandler.sendRequest, original);
});

test("a disk write failure does not fail or replay a robot command", async (t) => {
  const h = fixture(t);
  const write = fs.writeSync;
  fs.writeSync = () => {
    throw new Error("disk full");
  };
  try {
    const result = await h.adapter.messageQueueHandler.sendRequest(
      "private-robot",
      "upd_timer",
      ["private-timer", "off"]
    );
    assert.equal(result[0][0], "private-timer");
    assert.equal(h.calls.length, 1);
    assert.equal(h.capture.active, false);
    assert.equal(h.adapter.messageQueueHandler.sendRequest, h.original);
  } finally {
    fs.writeSync = write;
  }
});
