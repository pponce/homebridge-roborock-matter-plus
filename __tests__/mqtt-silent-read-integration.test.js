"use strict";

const mockClients = [];
jest.mock("mqtt", () => ({
  connect: jest.fn(() => {
    const { EventEmitter } = require("events");
    const client = new EventEmitter();
    client.subscribe = jest.fn();
    client.publish = jest.fn();
    client.end = jest.fn();
    client.endAsync = jest.fn().mockResolvedValue(undefined);
    mockClients.push(client);
    return client;
  }),
}));

const {
  roborock_mqtt_connector,
} = require("../roborockLib/lib/roborock_mqtt_connector");
const {
  MqttSessionReplacedError,
} = require("../roborockLib/lib/mqttSessionErrors");
const {
  messageQueueHandler,
} = require("../roborockLib/lib/messageQueueHandler");

const USER = {
  rriot: {
    u: "user",
    k: "key",
    s: "secret",
    r: { m: "mqtts://broker.example" },
  },
};

function makeAdapter() {
  let requestId = 100;
  return {
    config: {enableMqttSessionRecovery: true},
    devices: [{ duid: "robot-1" }, { duid: "robot-2" }],
    pendingRequests: new Map(),
    pendingB01MapRequests: new Map(),
    isRemoteDevice: jest.fn().mockResolvedValue(true),
    getRobotVersion: jest.fn().mockResolvedValue("1.0"),
    onlineChecker: jest.fn().mockResolvedValue(true),
    getRequestId: jest.fn(() => ++requestId),
    setTimeout: jest.fn((callback, timeout) => setTimeout(callback, timeout)),
    clearTimeout: jest.fn(clearTimeout),
    localConnector: {
      isConnected: jest.fn().mockReturnValue(false),
      clearChunkBuffer: jest.fn(),
      sendMessage: jest.fn(),
    },
    message: {
      buildPayload: jest.fn().mockResolvedValue("payload"),
      buildRoborockMessage: jest.fn().mockResolvedValue(Buffer.from("wire")),
      _decodeMsg: jest.fn(),
    },
    log: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
    updateTransportDiagnostics: jest.fn().mockResolvedValue(undefined),
    catchError: jest.fn(),
  };
}

async function flushPromises() {
  for (let index = 0; index < 8; index++) await Promise.resolve();
}

async function connect(client) {
  client.emit("connect", { sessionPresent: false });
  await flushPromises();
}

async function acknowledgeSubscription(client) {
  const [topic, callback] = client.subscribe.mock.calls.at(-1);
  callback(null, [{ topic, qos: 1 }]);
  await flushPromises();
}

async function acknowledge(client) {
  await connect(client);
  await acknowledgeSubscription(client);
}

describe("silent cloud-read timeout integration", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    mockClients.length = 0;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test("real request timeouts collect evidence and replace a silent ready session", async () => {
    const adapter = makeAdapter();
    const connector = new roborock_mqtt_connector(adapter);
    adapter.rr_mqtt_connector = connector;
    await connector.initUser(USER);
    const handler = new messageQueueHandler(adapter);
    await acknowledge(mockClients[0]);
    async function sendAndTimeout(duid, method = "get_status", beforeTimeout) {
      const result = handler.sendRequest(duid, method, [], false, false,
        {preferCloud: true, requestTimeoutMs: 100}).catch(error => error);
      await flushPromises();
      if (beforeTimeout) beforeTimeout();
      await jest.advanceTimersByTimeAsync(100);
      const error = await result;
      expect(error.unansweredRequest).toBe(true);
      return error;
    }
    await sendAndTimeout("robot-1");
    expect(connector.sessionDiagnostics.snapshot().silentReadRobotCount).toBe(1);
    await sendAndTimeout("robot-1", "app_start");
    expect(connector.sessionDiagnostics.snapshot().silentReadRobotCount).toBe(1);
    await sendAndTimeout("robot-2", "get_consumable", () => mockClients[0].emit("message", "rr/m/o/unmatched", Buffer.from("raw")));
    expect(connector.sessionDiagnostics.snapshot().silentReadRobotCount).toBe(0);
    expect(mockClients).toHaveLength(1);
    await sendAndTimeout("robot-1");
    const lingering = handler.sendRequest("robot-1", "get_clean_summary", [], false, false,
      {preferCloud: true, requestTimeoutMs: 60000}).catch(error => error);
    await flushPromises();
    const localReject = jest.fn(), localTimer = setTimeout(() => {}, 60000);
    adapter.pendingRequests.set(999, {transport: "local", timeout: localTimer, reject: localReject});
    await sendAndTimeout("robot-2");
    const recovery = connector.recovery.inFlight;
    expect(recovery).toBeTruthy();
    await jest.advanceTimersByTimeAsync(500);
    expect(await lingering).toMatchObject({code: "MQTT_SESSION_REPLACED"});
    expect(localReject).not.toHaveBeenCalled();
    expect(adapter.pendingRequests.has(999)).toBe(true);
    expect(mockClients).toHaveLength(2);
    await connect(mockClients[1]);
    expect(connector.isReady()).toBe(false);
    await acknowledgeSubscription(mockClients[1]);
    await jest.advanceTimersByTimeAsync(50);
    expect(await recovery).toBe(true);
    const rawSequence = connector.sessionDiagnostics.captureRequest().rawSequence;
    mockClients[0].emit("message", "rr/m/o/robot-1", Buffer.from("late"));
    expect(connector.sessionDiagnostics.captureRequest().rawSequence).toBe(rawSequence);
    clearTimeout(localTimer);
    adapter.pendingRequests.delete(999);
    connector.disconnect();
  });
});

