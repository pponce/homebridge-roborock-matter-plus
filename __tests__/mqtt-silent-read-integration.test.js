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
    config: {},
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
    const evidence = jest.spyOn(connector, "noteSilentCloudReadTimeout");

    const firstRead = handler.sendRequest(
      "robot-1",
      "get_status",
      [],
      false,
      false,
      {
        preferCloud: true,
        operationClass: "read",
        requestTimeoutMs: 100,
      }
    );
    const firstRejection =
      expect(firstRead).rejects.toThrow(/get_status timed out/);
    await flushPromises();

    expect(mockClients[0].publish).not.toHaveBeenCalled();
    expect(adapter.setTimeout).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(25);
    await connect(mockClients[0]);
    expect(connector.getSessionGeneration()).toBe(1);
    expect(connector.isReady()).toBe(false);
    expect(mockClients[0].publish).not.toHaveBeenCalled();
    expect(adapter.setTimeout).not.toHaveBeenCalled();

    await acknowledgeSubscription(mockClients[0]);
    expect(connector.getSessionGeneration()).toBe(1);
    expect(connector.isReady()).toBe(true);
    expect(mockClients[0].publish).toHaveBeenCalledTimes(1);
    expect(adapter.setTimeout).toHaveBeenCalledTimes(1);
    const firstPending = adapter.pendingRequests.get(101);
    expect(firstPending).toEqual(
      expect.objectContaining({
        duid: "robot-1",
        method: "get_status",
        operationClass: "read",
        sessionGeneration: 1,
        publishedAt: expect.any(Number),
      })
    );
    expect(firstPending.publishedAt).toBeGreaterThan(firstPending.createdAt);

    await jest.advanceTimersByTimeAsync(100);
    await firstRejection;
    expect(evidence).toHaveBeenLastCalledWith({
      duid: "robot-1",
      method: "get_status",
      operationClass: "read",
      sessionGeneration: 1,
      publishedAt: firstPending.publishedAt,
    });
    expect(mockClients).toHaveLength(1);

    const write = handler.sendRequest(
      "robot-1",
      "app_start",
      [],
      false,
      false,
      {
        preferCloud: true,
        operationClass: "write",
        requestTimeoutMs: 100,
      }
    );
    const writeRejection = expect(write).rejects.toThrow(/app_start timed out/);
    await flushPromises();
    await jest.advanceTimersByTimeAsync(100);
    await writeRejection;
    expect(connector.silentCloudReadTimeouts).toHaveLength(1);

    const activeRead = handler.sendRequest(
      "robot-2",
      "get_consumable",
      [],
      false,
      false,
      {
        preferCloud: true,
        operationClass: "read",
        requestTimeoutMs: 100,
      }
    );
    const activeReadRejection = expect(activeRead).rejects.toThrow(
      /get_consumable timed out/
    );
    await flushPromises();
    await jest.advanceTimersByTimeAsync(1);
    mockClients[0].emit("message", "rr/m/o/unmatched", Buffer.from("raw"));
    await jest.advanceTimersByTimeAsync(99);
    await activeReadRejection;
    expect(connector.silentCloudReadTimeouts).toHaveLength(0);
    expect(mockClients).toHaveLength(1);

    const thresholdRead = handler.sendRequest(
      "robot-1",
      "get_status",
      [],
      false,
      false,
      {
        preferCloud: true,
        operationClass: "read",
        requestTimeoutMs: 100,
      }
    );
    const thresholdRejection =
      expect(thresholdRead).rejects.toThrow(/get_status timed out/);
    await flushPromises();
    await jest.advanceTimersByTimeAsync(100);
    await thresholdRejection;
    expect(mockClients).toHaveLength(1);

    const lingeringRead = handler.sendRequest(
      "robot-1",
      "get_clean_summary",
      [],
      false,
      false,
      {
        preferCloud: true,
        operationClass: "read",
        requestTimeoutMs: 60000,
      }
    );
    const lingeringRejection = expect(lingeringRead).rejects.toBeInstanceOf(
      MqttSessionReplacedError
    );
    await flushPromises();
    const lingeringTimer = adapter.pendingRequests.get(105).timeout;
    const localReject = jest.fn();
    const localTimer = setTimeout(() => {}, 60000);
    adapter.pendingRequests.set(999, {
      transport: "local",
      operationClass: "read",
      method: "get_status",
      timeout: localTimer,
      reject: localReject,
    });

    const secondRobotRead = handler.sendRequest(
      "robot-2",
      "get_status",
      [],
      false,
      false,
      {
        preferCloud: true,
        operationClass: "read",
        requestTimeoutMs: 100,
      }
    );
    const secondRobotRejection =
      expect(secondRobotRead).rejects.toThrow(/get_status timed out/);
    await flushPromises();
    const secondRobotPending = adapter.pendingRequests.get(106);
    await jest.advanceTimersByTimeAsync(100);
    await secondRobotRejection;

    expect(evidence).toHaveBeenLastCalledWith({
      duid: "robot-2",
      method: "get_status",
      operationClass: "read",
      sessionGeneration: 1,
      publishedAt: secondRobotPending.publishedAt,
    });
    const recovery = connector.reconnectInProgress;
    expect(recovery).toBeTruthy();

    await jest.advanceTimersByTimeAsync(2000);
    await flushPromises();
    await lingeringRejection;
    expect(adapter.pendingRequests.has(105)).toBe(false);
    expect(adapter.clearTimeout).toHaveBeenCalledWith(lingeringTimer);
    expect(adapter.pendingRequests.has(999)).toBe(true);
    expect(localReject).not.toHaveBeenCalled();
    expect(mockClients[0].endAsync).toHaveBeenCalledWith(true);
    expect(mockClients).toHaveLength(2);

    let recoverySettled = false;
    void recovery.finally(() => {
      recoverySettled = true;
    });
    await connect(mockClients[1]);
    expect(connector.getSessionGeneration()).toBe(2);
    expect(connector.isReady()).toBe(false);
    expect(recoverySettled).toBe(false);

    await acknowledgeSubscription(mockClients[1]);
    await expect(recovery).resolves.toEqual(
      expect.objectContaining({
        generation: 2,
        connected: true,
        subscriptionAcknowledged: true,
      })
    );
    expect(connector.getSessionGeneration()).toBe(2);
    expect(connector.isReady()).toBe(true);

    const evidenceCallsAfterRecovery = evidence.mock.calls.length;
    const rawInboundAtGeneration2 = connector.lastRawMqttMessageAt;
    mockClients[0].emit("message", "rr/m/o/robot-1", Buffer.from("late"));
    await jest.advanceTimersByTimeAsync(60000);
    expect(connector.lastRawMqttMessageAt).toBe(rawInboundAtGeneration2);
    expect(evidence).toHaveBeenCalledTimes(evidenceCallsAfterRecovery);

    expect(
      connector.noteSilentCloudReadTimeout({
        duid: "robot-1",
        method: "get_status",
        operationClass: "read",
        sessionGeneration: 1,
        publishedAt: Date.now() - 1,
      })
    ).toBe(false);
    expect(mockClients).toHaveLength(2);

    clearTimeout(localTimer);
    adapter.pendingRequests.delete(999);
    connector.disconnect();
  });
});
