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
  return {
    pendingRequests: new Map(),
    pendingB01MapRequests: new Map(),
    clearTimeout: jest.fn(clearTimeout),
    log: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
    catchError: jest.fn(),
  };
}

async function makeConnector() {
  const connector = new roborock_mqtt_connector(makeAdapter());
  await connector.initUser(USER);
  return connector;
}

async function acknowledge(client) {
  client.emit("connect", { sessionPresent: false });
  const [topic, callback] = client.subscribe.mock.calls.at(-1);
  callback(null, [{ topic, qos: 1 }]);
  await Promise.resolve();
  await Promise.resolve();
}

async function tick() {
  await new Promise((resolve) => setImmediate(resolve));
}

describe("account MQTT session recovery", () => {
  beforeEach(() => {
    mockClients.length = 0;
  });

  test("readiness waiters release together after SUBACK", async () => {
    const connector = await makeConnector();
    const first = connector.waitUntilReady({ timeoutMs: 1000 });
    const second = connector.waitUntilReady({ timeoutMs: 1000 });

    await acknowledge(mockClients[0]);

    await expect(first).resolves.toBe(1);
    await expect(second).resolves.toBe(1);
    expect(connector.readinessWaiters.size).toBe(0);
  });

  test("concurrent callers share one physical reconnect and result", async () => {
    const connector = await makeConnector();
    await acknowledge(mockClients[0]);

    const first = connector.reconnectAndWaitReady({
      reason: "test",
      drainTimeoutMs: 0,
    });
    const second = connector.reconnectAndWaitReady({ reason: "also-test" });
    expect(second).toBe(first);

    await tick();
    expect(mockClients).toHaveLength(2);
    await acknowledge(mockClients[1]);

    await expect(first).resolves.toEqual(
      expect.objectContaining({
        generation: 2,
        connected: true,
        subscriptionAcknowledged: true,
      })
    );
    expect(mockClients[0].endAsync).toHaveBeenCalledWith(true);
  });

  test("recovery rejects old cloud requests but preserves local requests", async () => {
    const connector = await makeConnector();
    await acknowledge(mockClients[0]);
    const cloudReject = jest.fn();
    const localReject = jest.fn();
    const cloudTimer = setTimeout(() => {}, 60000);
    const localTimer = setTimeout(() => {}, 60000);
    connector.adapter.pendingRequests.set(1, {
      transport: "cloud",
      sessionGeneration: 1,
      operationClass: "write",
      method: "set_something",
      timeout: cloudTimer,
      reject: cloudReject,
    });
    connector.adapter.pendingRequests.set(2, {
      transport: "local",
      operationClass: "read",
      timeout: localTimer,
      reject: localReject,
    });

    const recovery = connector.reconnectAndWaitReady({
      reason: "silent-replies",
      drainTimeoutMs: 0,
    });
    await tick();
    await acknowledge(mockClients[1]);
    const result = await recovery;

    expect(result.oldCloudRequestsRejected).toBe(1);
    expect(cloudReject).toHaveBeenCalledWith(
      expect.any(MqttSessionReplacedError)
    );
    expect(cloudReject.mock.calls[0][0].ambiguousWrite).toBe(true);
    expect(connector.adapter.pendingRequests.has(1)).toBe(false);
    expect(connector.adapter.pendingRequests.has(2)).toBe(true);
    expect(localReject).not.toHaveBeenCalled();
    clearTimeout(localTimer);
  });

  test("preventive recovery skips rather than interrupting a pending write", async () => {
    const connector = await makeConnector();
    await acknowledge(mockClients[0]);
    const timer = setTimeout(() => {}, 60000);
    connector.adapter.pendingRequests.set(1, {
      transport: "cloud",
      sessionGeneration: 1,
      operationClass: "write",
      timeout: timer,
      reject: jest.fn(),
    });

    await expect(
      connector.reconnectAndWaitReady({
        reason: "preventive-test",
        mode: "preventive",
        drainTimeoutMs: 0,
      })
    ).resolves.toEqual(expect.objectContaining({ skipped: true }));

    expect(mockClients).toHaveLength(1);
    expect(connector.adapter.pendingRequests.has(1)).toBe(true);
    expect(connector.isReady()).toBe(true);
    clearTimeout(timer);
  });

  test("shutdown rejects gate waiters and prevents replacement clients", async () => {
    const connector = await makeConnector();
    const waiter = connector.waitUntilReady({ timeoutMs: 1000 });
    connector.disconnect();

    await expect(waiter).rejects.toMatchObject({ code: "MQTT_SHUTTING_DOWN" });
    await expect(
      connector.reconnectAndWaitReady({ reason: "too-late" })
    ).rejects.toMatchObject({ code: "MQTT_SHUTTING_DOWN" });
    expect(mockClients).toHaveLength(1);
    expect(connector.readinessWaiters.size).toBe(0);
  });

  test("failed reconnect cooldown prevents an immediate reconnect loop", async () => {
    const connector = await makeConnector();
    await acknowledge(mockClients[0]);
    connector.nextReconnectAllowedAt = Date.now() + 30000;

    await expect(
      connector.reconnectAndWaitReady({ reason: "too-soon" })
    ).rejects.toMatchObject({ code: "MQTT_RECONNECT_COOLDOWN" });
    expect(mockClients).toHaveLength(1);
  });
});

describe("cloud publication readiness gate", () => {
  test("does not publish or start the response timeout before readiness", async () => {
    let releaseGate;
    const waitUntilReady = jest.fn(
      () =>
        new Promise((resolve) => {
          releaseGate = resolve;
        })
    );
    const sendMessage = jest.fn();
    const adapter = {
      config: {},
      isRemoteDevice: jest.fn().mockResolvedValue(true),
      getRobotVersion: jest.fn().mockResolvedValue("1.0"),
      onlineChecker: jest.fn().mockResolvedValue(true),
      rr_mqtt_connector: {
        isConnected: jest.fn().mockReturnValue(false),
        waitUntilReady,
        getSessionGeneration: jest.fn().mockReturnValue(7),
        sendMessage,
      },
      localConnector: {
        isConnected: jest.fn().mockReturnValue(false),
        clearChunkBuffer: jest.fn(),
        sendMessage: jest.fn(),
      },
      message: {
        buildPayload: jest.fn().mockResolvedValue("payload"),
        buildRoborockMessage: jest.fn().mockResolvedValue(Buffer.from("wire")),
      },
      getRequestId: jest.fn().mockReturnValue(42),
      pendingRequests: new Map(),
      setTimeout: jest.fn((callback, timeout) => setTimeout(callback, timeout)),
      clearTimeout,
      log: { debug: jest.fn(), info: jest.fn() },
      updateTransportDiagnostics: jest.fn().mockResolvedValue(undefined),
      catchError: jest.fn(),
    };

    const request = new messageQueueHandler(adapter).sendRequest(
      "robot",
      "get_server_timer",
      [],
      false,
      false,
      { preferCloud: true, operationClass: "read" }
    );
    await tick();

    expect(waitUntilReady).toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(adapter.setTimeout).not.toHaveBeenCalled();

    releaseGate(7);
    await tick();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(adapter.setTimeout).toHaveBeenCalledTimes(1);
    expect(adapter.pendingRequests.get(42)).toEqual(
      expect.objectContaining({
        duid: "robot",
        transport: "cloud",
        operationClass: "read",
        sessionGeneration: 7,
        createdAt: expect.any(Number),
        publishedAt: expect.any(Number),
      })
    );

    const pending = adapter.pendingRequests.get(42);
    clearTimeout(pending.timeout);
    adapter.pendingRequests.delete(42);
    pending.resolve(["ok"]);
    await expect(request).resolves.toEqual(["ok"]);
  });
});
