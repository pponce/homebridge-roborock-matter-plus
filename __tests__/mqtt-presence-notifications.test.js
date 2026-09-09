"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

jest.mock("mqtt", () => ({
  connect: () => {
    throw new Error("Presence tests must not open a broker connection.");
  },
}));

const {
  roborock_mqtt_connector,
} = require("../roborockLib/lib/roborock_mqtt_connector");

function setup() {
  const logs = { debug: [], info: [], warn: [], error: [] };
  const adapter = {
    config: {},
    localKeys: new Map([
      ["robot-1", "test-key"],
      ["robot-2", "test-key"],
    ]),
    describeDevice: (duid) =>
      duid === "robot-1" ? "Test Robot One" : "Test Robot Two",
    log: Object.fromEntries(
      Object.keys(logs).map((level) => [
        level,
        (message) => logs[level].push(message),
      ])
    ),
    message: {
      _decodeMsg: (payload) => ({ protocol: 500, payload }),
    },
  };
  const connector = new roborock_mqtt_connector(adapter);
  const client = new EventEmitter();
  connector.client = client;
  connector.sessionGeneration = 3;
  connector.installClientHandlers(client, 3);
  const emit = (online, packet = {}, duid = "robot-1") =>
    client.emit(
      "message",
      `rr/m/o/test-account/test-client/${duid}`,
      Buffer.from(JSON.stringify({ online })),
      packet
    );
  return { logs, connector, client, emit };
}

describe("MQTT presence notifications", () => {
  test("first online report establishes a baseline without claiming recovery", () => {
    const { logs, connector, emit } = setup();
    emit(true);
    assert.equal(connector.robotPresenceByDuid.get("robot-1"), true);
    assert.equal(logs.info.length, 0);
    assert.equal(logs.warn.length, 0);
  });

  test("equal live values log once and a real recovery logs once", () => {
    const { logs, emit } = setup();
    emit(false);
    emit(false);
    emit(true);
    emit(true);
    assert.equal(logs.warn.length, 1);
    assert.deepEqual(logs.info, ["Test Robot One is back online."]);
    assert.match(logs.warn[0], /does not by itself prove/);
  });

  test("a retained offline snapshot cannot replace an online live value", () => {
    const { logs, connector, emit } = setup();
    emit(true);
    emit(false, { retain: true });
    assert.equal(connector.robotPresenceByDuid.get("robot-1"), true);
    assert.equal(logs.warn.length, 0);
    assert.match(logs.debug.at(-1), /retain=true/);
  });

  test("a retained first observation does not establish a live baseline", () => {
    const { logs, connector, emit } = setup();
    emit(false, { retain: true });
    assert.equal(connector.robotPresenceByDuid.has("robot-1"), false);
    emit(false);
    assert.equal(logs.warn.length, 1);
  });

  test("DUP offline can be the first received copy and must be processed", () => {
    const { logs, connector, emit } = setup();
    emit(true);
    emit(false, { dup: true });
    assert.equal(connector.robotPresenceByDuid.get("robot-1"), false);
    assert.equal(logs.warn.length, 1);
    emit(false, { dup: true });
    assert.equal(logs.warn.length, 1);
  });

  test("DUP online can carry the recovery and must not be discarded", () => {
    const { logs, connector, emit } = setup();
    emit(false);
    emit(true, { dup: true });
    assert.equal(connector.robotPresenceByDuid.get("robot-1"), true);
    assert.deepEqual(logs.info, ["Test Robot One is back online."]);
  });

  test("presence transitions are independent for two robots", () => {
    const { logs, emit } = setup();
    emit(false);
    emit(true, {}, "robot-2");
    assert.equal(logs.info.length, 0);
    emit(true);
    assert.deepEqual(logs.info, ["Test Robot One is back online."]);
  });

  test("numeric zero and one retain the previous protocol compatibility", () => {
    const { logs, emit } = setup();
    emit(0);
    emit(1);
    assert.equal(logs.warn.length, 1);
    assert.deepEqual(logs.info, ["Test Robot One is back online."]);
  });

  test("presence debug metadata includes flags and generation without topics", () => {
    const { logs, emit } = setup();
    emit(false, { retain: true, dup: true });
    assert.match(logs.debug.at(-1), /retain=true; dup=true; generation=3/);
    assert.doesNotMatch(
      logs.debug.join("\n"),
      /test-account|test-client|test-key|rr\/m\/o/
    );
  });

  test("retired-client notifications cannot change presence or produce warnings", () => {
    const { logs, connector, client, emit } = setup();
    emit(true);
    connector.client = new EventEmitter();
    connector.sessionGeneration = 4;
    client.emit(
      "message",
      "rr/m/o/test-account/test-client/robot-1",
      Buffer.from(JSON.stringify({ online: false }))
    );
    assert.equal(connector.robotPresenceByDuid.get("robot-1"), true);
    assert.equal(logs.warn.length, 0);
  });
});
