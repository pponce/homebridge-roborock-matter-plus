"use strict";

// Timeouts are emitted by the real request queue, not fabricated.
const mockClients = [];
jest.mock("mqtt", () => ({
  connect: jest.fn(() => {
    const handlers = new Map(),
      subscriptions = [];
    const client = {
      handlers,
      subscriptions,
      on: jest.fn((event, handler) => handlers.set(event, handler)),
      subscribe: jest.fn((topic, callback) => {
        if (client.knownTopic) callback(null, []);
        else subscriptions.push(callback);
      }),
      publish: jest.fn(),
      end: jest.fn(),
      endAsync: jest.fn(async () => {}),
      reconnect: jest.fn(),
      removeAllListeners: jest.fn(() => handlers.clear()),
    };
    mockClients.push(client);
    return client;
  }),
}));
const {
  roborock_mqtt_connector,
} = require("../roborockLib/lib/roborock_mqtt_connector");
const {
  messageQueueHandler,
} = require("../roborockLib/lib/messageQueueHandler");
const { Roborock } = require("../roborockLib/roborockAPI");
let adapter, connector, queue, states, requestId;
const topic = (duid = "robot-a") =>
  `rr/m/o/private-user/private-client/${duid}`;
const snapshot = () =>
  JSON.parse(states.get("MqttSessionDiagnostics")?.val || "{}");
const receive = (decoded, duid = "robot-a") => {
  adapter.message._decodeMsg.mockReturnValue(decoded);
  mockClients.at(-1).handlers.get("message")(
    topic(duid),
    Buffer.from("encrypted-frame")
  );
};
const reply = (id, result = ["ok"]) => ({
  protocol: 102,
  payload: JSON.stringify({ dps: { 102: JSON.stringify({ id, result }) } }),
});
async function startRequest(
  duid = "robot-a",
  method = "get_status",
  options = {}
) {
  const result = queue
    .sendRequest(duid, method, [], false, false, options)
    .catch((error) => error);
  // Drive the async pre-send lookups; the response timer is the real one.
  await jest.advanceTimersByTimeAsync(0);
  return { result, id: requestId };
}
async function timeout(duid = "robot-a", method = "get_status") {
  const request = await startRequest(duid, method);
  await jest.advanceTimersByTimeAsync(10_000);
  return request.result;
}
function acknowledge(granted = [{ qos: 1 }]) {
  const client = mockClients.at(-1);
  client.handlers.get("packetreceive")?.({
    cmd: "suback",
    granted: granted.map((x) => x.qos),
  });
  if (!client.knownTopic) client.subscriptions.at(-1)(null, granted);
  client.knownTopic = granted.every((x) => x.qos < 128);
}

beforeEach(async () => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  jest.clearAllMocks();
  mockClients.length = 0;
  states = new Map();
  requestId = 0;
  adapter = {
    config: { enableMqttSessionRecovery: true },
    log: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
    localKeys: new Map([
      ["robot-a", "private-key-a"],
      ["robot-b", "private-key-b"],
    ]),
    devices: [{ duid: "robot-a" }, { duid: "robot-b" }],
    pendingRequests: new Map(),
    pendingB01MapRequests: new Map(),
    describeDevice: (duid) => duid,
    settleB01MapRequest: Roborock.prototype.settleB01MapRequest,
    catchError: jest.fn(),
    isRemoteDevice: jest.fn(async () => false),
    getRobotVersion: jest.fn(async () => "1.0"),
    onlineChecker: jest.fn(async () => true),
    getRequestId: () => ++requestId,
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout,
    setStateAsync: jest.fn(async (key, value) => states.set(key, value)),
    updateTransportDiagnostics: jest.fn(async () => {}),
    noteRequestAnswered: jest.fn(),
    noteRequestUnanswered: jest.fn(),
    localConnector: {
      isConnected: jest.fn(() => false),
      sendMessage: jest.fn(),
      clearChunkBuffer: jest.fn(),
    },
    message: {
      _decodeMsg: jest.fn(() => null),
      buildPayload: jest.fn(async () => "payload"),
      buildRoborockMessage: jest.fn(async () => Buffer.from("request")),
    },
  };
  connector = new roborock_mqtt_connector(adapter);
  adapter.rr_mqtt_connector = connector;
  queue = new messageQueueHandler(adapter);
  await connector.initUser({
    rriot: {
      u: "private-user",
      k: "private-key",
      s: "private-secret",
      r: { m: "mqtts://broker.example" },
    },
  });
  await connector.initMQTT_Subscribe();
  await connector.initMQTT_Message();
  mockClients.at(-1).handlers.get("connect")({ sessionPresent: false });
  acknowledge();
});
afterEach(() => {
  connector.disconnect();
  jest.clearAllTimers();
  jest.useRealTimers();
});

async function restartWith(config) {
  connector.disconnect();
  mockClients.length = 0;
  adapter.config = config;
  connector = new roborock_mqtt_connector(adapter);
  adapter.rr_mqtt_connector = connector;
  await connector.initUser({
    rriot: {
      u: "user",
      k: "key",
      s: "secret",
      r: { m: "mqtts://broker.example" },
    },
  });
  await connector.initMQTT_Subscribe();
  await connector.initMQTT_Message();
  connectLatest();
}

async function silence() {
  await timeout("robot-a");
  await timeout("robot-b");
  await jest.advanceTimersByTimeAsync(0);
}
function connectLatest(granted = [{ qos: 1 }]) {
  mockClients.at(-1).handlers.get("connect")({ sessionPresent: false });
  acknowledge(granted);
}
async function replacementReady() {
  connectLatest();
  await jest.advanceTimersByTimeAsync(50);
}

function enableBaselineRule() {
  adapter.cloudSessionHealth = { consecutiveSilences: 0, lastRestartAt: 0 };
  adapter.restartCloudSession = Roborock.prototype.restartCloudSession.bind(adapter);
  adapter.noteCloudSilence = Roborock.prototype.noteCloudSilence.bind(adapter);
  adapter.noteCloudReply = Roborock.prototype.noteCloudReply.bind(adapter);
}
async function openReplacement() {
  await jest.advanceTimersByTimeAsync(10000);
  await replacementReady();
}

test("correlated recovery uses upstream's ten-second fresh-client path without replay", async () => {
  const old = mockClients[0];
  await silence();
  expect(old.end).toHaveBeenCalledWith(true);
  expect(old.endAsync).not.toHaveBeenCalled();
  expect(old.reconnect).not.toHaveBeenCalled();
  expect(mockClients).toHaveLength(1);
  await jest.advanceTimersByTimeAsync(9999);
  expect(mockClients).toHaveLength(1);
  await jest.advanceTimersByTimeAsync(1);
  expect(mockClients).toHaveLength(2);
  expect(mockClients[1].publish).not.toHaveBeenCalled();
  await replacementReady();
  expect(snapshot()).toMatchObject({ generation: 2, subscriptionAcknowledged: true, recovery: { lastResult: "succeeded" } });
});

test("a pending write is retired as unknown while local requests survive", async () => {
  const write = await startRequest("robot-a", "app_start");
  const local = { transport: "local", reject: jest.fn(), timeout: setTimeout(() => {}, 50000) };
  adapter.pendingRequests.set(999, local);
  const refresh = connector.recovery.recreate("manual");
  await jest.advanceTimersByTimeAsync(500);
  expect(await write.result).toMatchObject({ code: "MQTT_SESSION_REPLACED", ambiguousWrite: true, generation: 1, method: "app_start", unansweredRequest: false });
  expect(adapter.pendingRequests.get(999)).toBe(local);
  expect(local.reject).not.toHaveBeenCalled();
  expect(adapter.noteRequestAnswered).not.toHaveBeenCalled();
  await openReplacement();
  expect(await refresh).toBe(true);
  expect(mockClients[1].publish).not.toHaveBeenCalled();
});

test("pending B01 maps are retired without replay", async () => {
  const map = Roborock.prototype.sendB01MapRequest.call(adapter, "robot-a", 0).catch(e => e);
  await jest.advanceTimersByTimeAsync(0);
  const refresh = connector.recovery.recreate("manual");
  await jest.advanceTimersByTimeAsync(500);
  expect(await map).toMatchObject({ code: "MQTT_SESSION_REPLACED", operationClass: "secure-map" });
  expect(adapter.pendingB01MapRequests.size).toBe(0);
  await openReplacement();
  expect(await refresh).toBe(true);
});

test("a retired client cannot restore readiness during the reconnect backoff", async () => {
  const old = mockClients[0];
  await connector.reconnectClient(true);
  old.handlers.get("connect")({});
  old.subscriptions[0](null, [{ qos: 1 }]);
  old.handlers.get("message")(topic(), Buffer.from("stale"));
  expect(connector.isReady()).toBe(false);
  expect(adapter.message._decodeMsg).not.toHaveBeenCalled();
  await openReplacement();
  expect(connector.isReady()).toBe(true);
});

test("concurrent manual and health requests schedule only one replacement", async () => {
  const first = connector.recovery.recreate("manual");
  const second = connector.recovery.recreate("manual");
  expect(first).toBe(second);
  await jest.advanceTimersByTimeAsync(0);
  expect(await connector.reconnectClient(true)).toBe(false);
  expect(mockClients[0].end).toHaveBeenCalledTimes(1);
  await openReplacement();
  expect(await first).toBe(true);
  expect(mockClients).toHaveLength(2);
});

test("a stalled endAsync cannot block the upstream forced teardown", async () => {
  mockClients[0].endAsync.mockImplementation(() => new Promise(() => {}));
  const refresh = connector.recovery.recreate("manual");
  await jest.advanceTimersByTimeAsync(10000);
  expect(mockClients).toHaveLength(2);
  expect(mockClients[0].endAsync).not.toHaveBeenCalled();
  await replacementReady();
  expect(await refresh).toBe(true);
});

test("missing SUBACK fails the bounded observation without adding a private retry loop", async () => {
  const refresh = connector.recovery.recreate("manual");
  await jest.advanceTimersByTimeAsync(10000);
  mockClients[1].handlers.get("connect")({});
  await jest.advanceTimersByTimeAsync(20001);
  expect(await refresh).toBe(false);
  expect(snapshot().recovery.lastResult).toBe("failed");
  expect(connector.unsubscribedExpiries).toBe(0);
  await jest.advanceTimersByTimeAsync(5 * 60000);
  expect(mockClients).toHaveLength(2);
  acknowledge();
  expect(connector.isReady()).toBe(true);
  expect(snapshot().recovery.lastResult).toBe("recovered");
});

test("shutdown during drain and backoff prevents replacement and cancels waiters", async () => {
  const write = await startRequest("robot-a", "app_start");
  const refresh = connector.recovery.recreate("manual");
  await jest.advanceTimersByTimeAsync(100);
  connector.disconnect();
  await jest.advanceTimersByTimeAsync(40000);
  expect(await refresh).toBe(false);
  expect(await write.result).toBeInstanceOf(Error);
  expect(mockClients).toHaveLength(1);
  expect(jest.getTimerCount()).toBe(0);
});

test.each([{}, { enableMqttSessionRecovery: true }, { enableMqttPreventiveRefresh: true }])("preventive refresh requires both options: %j", async config => {
  await restartWith(config);
  await jest.advanceTimersByTimeAsync(5 * 60 * 60000);
  expect(mockClients).toHaveLength(1);
});

test.each([undefined, 0, -1, 1.5, "60"])("invalid interval %s keeps the four-hour default", async value => {
  await restartWith({ enableMqttSessionRecovery: true, enableMqttPreventiveRefresh: true, mqttPreventiveRefreshMinutes: value });
  expect(connector.recovery.preventiveRefreshMinutes).toBe(240);
  await jest.advanceTimersByTimeAsync(240 * 60000 - 1);
  expect(mockClients[0].end).not.toHaveBeenCalled();
  await jest.advanceTimersByTimeAsync(1);
  expect(mockClients[0].end).toHaveBeenCalledWith(true);
  await openReplacement();
});

test("the configured minute interval uses the upstream backoff then resets after SUBACK", async () => {
  await restartWith({ enableMqttSessionRecovery: true, enableMqttPreventiveRefresh: true, mqttPreventiveRefreshMinutes: 1 });
  await jest.advanceTimersByTimeAsync(60000);
  expect(mockClients).toHaveLength(1);
  await openReplacement();
  expect(mockClients).toHaveLength(2);
  expect(snapshot().recovery).toMatchObject({ preventiveRefreshMinutes: 1, lastResult: "succeeded" });
  expect(snapshot().recovery.preventiveRemainingMs).toBeGreaterThan(59000);
  await jest.advanceTimersByTimeAsync(50000);
  expect(mockClients).toHaveLength(2);
});

test("a normal upstream reconnect resets preventive age", async () => {
  await restartWith({ enableMqttSessionRecovery: true, enableMqttPreventiveRefresh: true, mqttPreventiveRefreshMinutes: 1 });
  await jest.advanceTimersByTimeAsync(30000);
  mockClients[0].handlers.get("close")();
  await openReplacement();
  await jest.advanceTimersByTimeAsync(20000);
  expect(mockClients).toHaveLength(2);
  expect(mockClients[1].end).not.toHaveBeenCalled();
});

test("preventive refresh defers for cloud writes without closing the send gate", async () => {
  await restartWith({ enableMqttSessionRecovery: true, enableMqttPreventiveRefresh: true, mqttPreventiveRefreshMinutes: 1 });
  await jest.advanceTimersByTimeAsync(59000);
  const write = await startRequest("robot-a", "app_start");
  await jest.advanceTimersByTimeAsync(1000);
  expect(mockClients[0].end).not.toHaveBeenCalled();
  expect(connector.recovery.sendPaused).toBe(false);
  expect(snapshot().recovery.lastResult).toBe("deferred");
  receive(reply(write.id));
  expect(await write.result).toEqual(["ok"]);
});

test("queued schedule batches defer preventive refresh even between their cloud requests", async () => {
  const { ScheduleAccountCoordinator, ScheduleWriteBatcher } = require("../src/hap_schedule_accessory.ts");
  const account = new ScheduleAccountCoordinator();
  let finish;
  const batcher = new ScheduleWriteBatcher(() => account.enqueue(() => new Promise(resolve => { finish = () => resolve(new Map()); }), () => new Map()), x => x.id, 1000);
  await restartWith({ enableMqttSessionRecovery: true, enableMqttPreventiveRefresh: true, mqttPreventiveRefreshMinutes: 1, isScheduleOperationPending: () => account.busy || batcher.busy });
  await jest.advanceTimersByTimeAsync(59500);
  const write = batcher.enqueue({ id: "timer" });
  await jest.advanceTimersByTimeAsync(500);
  expect(account.busy).toBe(false);
  expect(batcher.busy).toBe(true);
  expect(mockClients[0].end).not.toHaveBeenCalled();
  await jest.advanceTimersByTimeAsync(60000);
  expect(account.busy).toBe(true);
  expect(adapter.pendingRequests.size).toBe(0);
  expect(mockClients[0].end).not.toHaveBeenCalled();
  finish();
  expect(await write).toBe(true);
  await jest.advanceTimersByTimeAsync(60000);
  expect(mockClients[0].end).toHaveBeenCalledWith(true);
  await openReplacement();
});

test("baseline and correlated failure recovery share the thirty-minute cooldown", async () => {
  enableBaselineRule();
  await timeout("robot-a");
  await timeout("robot-a");
  await timeout("robot-b");
  await openReplacement();
  expect(mockClients).toHaveLength(2);
  expect(mockClients[0].end).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(60000);
  await silence();
  expect(adapter.noteCloudSilence()).toBe(false);
  expect(mockClients).toHaveLength(2);
});

test("preventive refresh does not consume the failure-recovery cooldown", async () => {
  enableBaselineRule();
  const refresh = connector.recovery.recreate("preventive");
  await openReplacement();
  expect(await refresh).toBe(true);
  expect(adapter.cloudSessionHealth.lastRestartAt).toBe(0);
  for (let i=0;i<3;i++) await timeout("robot-a");
  await openReplacement();
  expect(mockClients).toHaveLength(3);
});

test("the correlated option alone does not treat a single robot or a write as account silence", async () => {
  for (let i=0;i<3;i++) await timeout("robot-a");
  await timeout("robot-b", "app_start");
  expect(mockClients).toHaveLength(1);
});

test("historical read evidence keeps its generation across replacement", async () => {
  await silence();
  expect(snapshot().lastEligibleRead).toMatchObject({ generation: 1, rawSilenceDuringRequest: true });
  await openReplacement();
  expect(snapshot()).toMatchObject({ generation: 2, rawSilenceDuringRequest: null, lastEligibleRead: { generation: 1 } });
});
