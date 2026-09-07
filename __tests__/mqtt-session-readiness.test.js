"use strict";

const mockClients = [];
jest.mock("mqtt", () => ({
  connect: jest.fn(() => {
    const { EventEmitter } = require("events");
    const client = new EventEmitter();
    client.subscribe = jest.fn();
    client.publish = jest.fn();
    client.end = jest.fn();
    client.removeAllListeners = jest.fn(
      EventEmitter.prototype.removeAllListeners
    );
    mockClients.push(client);
    return client;
  }),
}));

const {
  roborock_mqtt_connector,
} = require("../roborockLib/lib/roborock_mqtt_connector");

const USER = {
  rriot: {
    u: "account-user",
    k: "account-key",
    s: "account-secret",
    r: { m: "mqtts://broker.example" },
  },
};

function adapter() {
  return {
    config: {},
    localKeys: new Map([["robot-1", "key"]]),
    devices: [{ duid: "robot-1" }],
    pendingRequests: new Map(),
    clearTimeout,
    setStateAsync: jest.fn(),
    message: { _decodeMsg: jest.fn(() => null) },
    log: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
  };
}

async function connectorAndClient() {
  const connector = new roborock_mqtt_connector(adapter());
  await connector.initUser(USER);
  await connector.initMQTT_Subscribe();
  return { connector, client: mockClients.at(-1) };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("MQTT session readiness", () => {
  beforeEach(() => {
    mockClients.length = 0;
  });

  test("socket connection is not readiness until the matching SUBACK", async () => {
    const { connector, client } = await connectorAndClient();
    client.emit("connect", { sessionPresent: false });

    expect(connector.socketConnected).toBe(true);
    expect(connector.isReady()).toBe(false);
    expect(connector.isConnected()).toBe(false);

    const [topic, callback] = client.subscribe.mock.calls[0];
    callback(null, [{ topic, qos: 0 }]);
    await flush();

    expect(connector.isReady()).toBe(true);
    expect(connector.getSessionHealthSnapshot()).toEqual(
      expect.objectContaining({
        state: "ready",
        generation: 1,
        socketConnected: true,
        subscriptionReady: true,
      })
    );
  });

  test("failed or refused subscriptions remain non-ready", async () => {
    const { connector, client } = await connectorAndClient();
    client.emit("connect", {});
    client.subscribe.mock.calls[0][1](null, [
      { topic: client.subscribe.mock.calls[0][0], qos: 128 },
    ]);
    await flush();

    expect(connector.isReady()).toBe(false);
    expect(connector.sessionState).toBe("disconnected");
    expect(connector.adapter.log.warn).toHaveBeenCalledWith(
      expect.stringContaining("did not grant")
    );
  });

  test("reconnect telemetry does not subscribe a second time", async () => {
    const { client } = await connectorAndClient();
    client.emit("connect", {});
    expect(client.subscribe).toHaveBeenCalledTimes(1);

    client.emit("reconnect");
    expect(client.subscribe).toHaveBeenCalledTimes(1);
  });

  test("late old-client events and SUBACK cannot change a new generation", async () => {
    const { connector, client: oldClient } = await connectorAndClient();
    oldClient.emit("connect", {});
    const oldSuback = oldClient.subscribe.mock.calls[0][1];

    await connector.initUser(USER);
    await connector.initMQTT_Subscribe();
    const currentClient = mockClients.at(-1);
    currentClient.emit("connect", {});
    const [topic, currentSuback] = currentClient.subscribe.mock.calls[0];
    currentSuback(null, [{ topic, qos: 1 }]);
    await flush();

    oldSuback(null, [{ topic: "old", qos: 1 }]);
    oldClient.emit("close");
    await flush();

    expect(connector.getSessionGeneration()).toBe(2);
    expect(connector.isReady()).toBe(true);
  });

  test("raw, attributed, and decoded activity are recorded at separate stages", async () => {
    const { connector, client } = await connectorAndClient();
    await connector.initMQTT_Message();

    client.emit(
      "message",
      "rr/m/o/account-user/user/unknown",
      Buffer.from("x")
    );
    let health = connector.getSessionHealthSnapshot("robot-1");
    expect(health.lastRawInboundAgeMs).not.toBeNull();
    expect(health.lastAttributedInboundAgeMs).toBeNull();

    client.emit(
      "message",
      "rr/m/o/account-user/user/robot-1",
      Buffer.from("x")
    );
    health = connector.getSessionHealthSnapshot("robot-1");
    expect(health.lastAttributedInboundAgeMs).not.toBeNull();
    expect(health.lastDecodedInboundAgeMs).toBeNull();

    connector.adapter.message._decodeMsg.mockReturnValue({
      protocol: 999,
      payload: "x",
    });
    client.emit(
      "message",
      "rr/m/o/account-user/user/robot-1",
      Buffer.from("x")
    );
    health = connector.getSessionHealthSnapshot("robot-1");
    expect(health.lastDecodedInboundAgeMs).not.toBeNull();
    expect(health.lastCorrelatedReplyAgeMs).toBeNull();
    expect(JSON.stringify(health)).not.toMatch(
      /account-user|account-key|topic|password/
    );
  });

  test("shutdown invalidates pending SUBACK", async () => {
    const { connector, client } = await connectorAndClient();
    client.emit("connect", {});
    const [topic, suback] = client.subscribe.mock.calls[0];
    connector.disconnect();
    suback(null, [{ topic, qos: 1 }]);
    await flush();

    expect(connector.isReady()).toBe(false);
    expect(connector.sessionState).toBe("shutting-down");
  });
});
