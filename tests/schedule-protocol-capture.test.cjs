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
    use(ok, fail) { handlers.set(++id, { ok, fail }); return id; },
    eject(key) { handlers.delete(key); },
  };
}

function fixture(t, options = {}) {
  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), "schedule-capture-"));
  const calls = [];
  const api = {
    interceptors: { request: interceptors(), response: interceptors() },
    async get(url) { calls.push({ verb: "GET", url }); return { data: { result: [] } }; },
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
      async exchangeOverCloud() { return [["private-timer", "off", ["0 9 * * 1", "start_clean", {}]]]; },
      async exchangeOverLocal() { return []; },
    },
  };
  const original = adapter.messageQueueHandler.sendRequest;
  const capture = new ScheduleProtocolCapture(adapter, { snapshots: false, ...options });
  t.after(() => { capture.stop(); fs.rmSync(storagePath, { recursive: true, force: true }); });
  const records = () => fs.readFileSync(capture.file, "utf8").trim().split("\n").map(JSON.parse);
  return { adapter, capture, calls, records, original, storagePath };
}

test("disabled by default: no file, observer or extra request", () => {
  assert.equal(startScheduleProtocolCapture({ config: {} }), null);
  assert.equal(startScheduleProtocolCapture({ config: { enableScheduleProtocolCapture: "true" } }), null);
});

test("sanitizes nested JSON, preserves job/timer linkage and complete lists", () => {
  const s = createSanitizer();
  const value = {
    enabled: true,
    timeZoneId: "America/Los_Angeles",
    cron: "15 9 * * 1,2,4",
    localKey: "TOP-SECRET-KEY",
    password: 123456,
    param: JSON.stringify({ method: "server_scheduled_start", params: [{ name: "secret-timer", fan: 102, token: "TOP-SECRET-TOKEN" }] }),
    timers: [["secret-timer", "off"]],
    jobs: Array.from({ length: 15 }, (_, id) => ({ id, cron: "15 9 * * 1,2,4" })),
  };
  const sanitized = s.clean(value);
  assert.equal(sanitized.enabled, true);
  assert.equal(sanitized.cron, value.cron);
  assert.equal(sanitized.timeZoneId, value.timeZoneId);
  assert.equal(sanitized.jobs.length, 15);
  assert.equal(sanitized.param.jsonString.method, "server_scheduled_start");
  assert.deepEqual(sanitized.param.jsonString.params[0].name, sanitized.timers[0][0]);
  assert.equal(sanitized.jobs[0].id.type, "number");
  assert.equal(sanitized.param.jsonString.params[0].fan, 102);
  assert(!JSON.stringify(sanitized).includes("TOP-SECRET"));
  assert(!JSON.stringify(sanitized).includes("secret-timer"));
  assert.equal(sanitized.password, "<redacted>");
  assert.notEqual(s.ref("secret-timer"), createSanitizer().ref("secret-timer"));
});

test("unexpected diagnostic values fail closed", () => {
  const s = createSanitizer();
  const cycle = {}; cycle.child = cycle;
  assert(JSON.stringify(s.clean(cycle)).includes("<depth limit>"));
  const getters = Object.defineProperty({}, "secret", { enumerable: true, get() { throw new Error("SECRET"); } });
  assert.equal(s.clean(getters), "<unavailable>");
  assert(!JSON.stringify(s.clean({ note: "SECRET", val: '{"password":"SECRET"}' })).includes("SECRET"));
});

test("only schedule HTTP routes qualify, with no host, headers or query", () => {
  const { ref } = createSanitizer();
  assert.equal(describeRoute({ url: "/login?token=SECRET" }, ref), null);
  assert.equal(describeRoute({ url: "/user/homes/123" }, ref), null);
  const result = describeRoute({ url: "https://private.example/user/devices/private-robot/jobs/private-job?token=SECRET" }, ref);
  assert.equal(result.route, "/user/devices/{robot}/jobs/{job}");
  assert(!JSON.stringify(result).includes("private"));
  assert(!JSON.stringify(result).includes("SECRET"));
  assert.equal(describeRoute({ url: "/user/scene/123/param" }, ref).route, "/user/scene/{scene}/param");
});

test("RPC observes payload and selected transport; preserves original result and receiver", async (t) => {
  const h = fixture(t);
  const result = await h.adapter.messageQueueHandler.sendRequest("private-robot", "upd_timer", ["private-timer", "off"]);
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
  await h.adapter.messageQueueHandler.sendRequest("private-robot", "get_network_info", []);
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
    h.adapter.messageQueueHandler.sendRequest("private-robot", "get_server_timer", []),
  ]);
  assert.equal(results[0].reason, failure);
  assert.deepEqual(results[1].value, ["ok"]);
  const error = h.records().find((r) => r.event === "rpc-error");
  assert.equal(error.robotCode, "-10007");
  assert(!JSON.stringify(h.records()).includes("PRIVATE"));
  assert.equal(new Set(h.records().filter((r) => r.event === "rpc-request").map((r) => r.callId)).size, 2);
});

test("HTTP interceptors preserve signed body, headers, response and error", async (t) => {
  const h = fixture(t);
  const requestHook = [...h.adapter.api.interceptors.request.handlers.values()][0];
  const responseHook = [...h.adapter.api.interceptors.response.handlers.values()][0];
  const config = { url: "user/devices/private-robot/jobs/123", method: "put", data: JSON.stringify({ cron: "0 9 * * *", token: "SECRET" }), headers: { Authorization: "SECRET" } };
  const before = JSON.stringify(config);
  assert.equal(requestHook.ok(config), config);
  assert.equal(JSON.stringify(config), before);
  const response = { config, status: 200, data: { success: true } };
  assert.equal(responseHook.ok(response), response);
  const error = Object.assign(new Error("SECRET"), { config, response: { config, status: 400, data: { error: "SECRET" } } });
  await assert.rejects(responseHook.fail(error), (received) => received === error);
  const records = h.records();
  assert(records.some((r) => r.event === "http-request" && r.verb === "PUT"));
  assert(records.some((r) => r.event === "http-error" && r.status === 400));
  assert(!JSON.stringify(records).includes("SECRET"));
  assert(!JSON.stringify(records).includes("Authorization"));
});

test("snapshot adds only reads and records HTTP and RPC failures separately", async (t) => {
  const h = fixture(t);
  await h.capture.snapshot();
  assert.deepEqual(h.calls.filter((r) => r.verb).map((r) => r.verb), ["GET", "GET"]);
  assert.deepEqual(h.calls.filter((r) => r.method).map((r) => r.method), ["get_server_timer", "get_timer", "get_timezone", "get_status"]);
  assert(h.records().some((r) => r.event === "snapshot-end" && r.atomic === false));
  h.adapter.config.isScheduleOperationPending = () => true;
  const count = h.calls.length;
  await h.capture.snapshot();
  assert.equal(h.calls.length, count);
  h.adapter.config.isScheduleOperationPending = () => false;
  h.adapter.api.get = async () => { throw Object.assign(new Error("SECRET"), { response: { status: 503 } }); };
  await h.capture.snapshot();
  assert(h.records().some((r) => r.event === "snapshot-read-error" && r.read === "jobs" && r.status === 503));
});

test("snapshots do not send classic RPC to B01 robots and stop on rate limiting", async (t) => {
  const h = fixture(t);
  h.adapter.isB01Device = () => true;
  await h.capture.snapshot();
  assert.equal(h.calls.filter((r) => r.method).length, 0);
  let count = 0;
  h.adapter.api.get = async () => { count++; throw { response: { status: 429 } }; };
  await h.capture.snapshot();
  assert.equal(count, 1);
  assert.equal(h.capture.active, false);
  assert.equal(h.records().at(-1).reason, "http-rate-limit");
});

test("failed diagnostic reads are bounded and snapshots cannot overlap", async (t) => {
  const h = fixture(t);
  let count = 0;
  h.adapter.api.get = async () => { count++; throw new Error("unavailable"); };
  for (let i = 0; i < 5; i++) await h.capture.snapshot();
  assert.equal(count, 6);
  h.capture.snapshotRunning = true;
  await h.capture.snapshot();
  assert.equal(count, 6);
});

test("size limit detaches observers without interrupting a command", async (t) => {
  const h = fixture(t, { maxBytes: 2500 });
  const result = await h.adapter.messageQueueHandler.sendRequest("private-robot", "set_timer", [{ settings: Array(500).fill(999999) }]);
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
  const adapter = { config: {}, log: { info() {}, warn() {} }, messageQueueHandler: { sendRequest: original } };
  const capture = new ScheduleProtocolCapture(adapter);
  assert.equal(capture.active, false);
  assert.equal(adapter.messageQueueHandler.sendRequest, original);
});
