"use strict";

/**
 * THE PLUGIN TOLD #28 TO REPORT A BUG THAT WAS NOT THERE.
 *
 * A protocol-301 frame carries a 15-byte endpoint field naming the controller
 * the reply belongs to. Ours is an 8-character key derived from the account
 * (`md5bin(rriot.k)[8..14]`, base64), and it is ACCOUNT-wide, not plugin-wide:
 * the Roborock phone app, a second Homebridge, a voice assistant skill — each
 * has its own endpoint, and every one of them shares the MQTT topic. A frame
 * addressed to the phone app therefore lands in our handler, fails the
 * endpoint guard, and is dropped as `addressed-elsewhere`. That is CORRECT.
 * It is not our reply.
 *
 * The give-up line said otherwise. On any `get_map_v1` give-up with a non-zero
 * drop count it asserted, at info level:
 *
 *     "so the robot IS answering and this side is throwing it away.
 *      Please report this — it is a bug here, not on your robot."
 *
 * CooperCGN (#28) read exactly that, with `addressed-elsewhere: 30`, while his
 * S8 Pro Ultra was being watched in the Roborock app during a scheduled clean.
 * The claim was false, and it sends users to file a bug against correct code.
 *
 * The two cases are distinguishable by measurement, which is why the counter
 * now has a second half. If our endpoint were wrong, NOTHING would ever be
 * addressed to us — so a single accepted frame proves the key is right and
 * convicts the other controller instead. Zero accepted frames alongside drops
 * is the shape of a real bug here, and only then does the line say so.
 */

const mockCapturedHandlers = new Map();

jest.mock("mqtt", () => ({
  connect: jest.fn(() => ({
    on: (event, handler) => {
      mockCapturedHandlers.set(event, handler);
    },
    subscribe: jest.fn(),
    end: jest.fn(),
    removeAllListeners: jest.fn(),
  })),
}));

const {
  describeDroppedFrames,
  noteAcceptedFrame,
  noteDroppedFrame,
  resetFrameCounters,
} = require("../roborockLib/lib/roborock_mqtt_connector");
const {
  createRealRoborockOnFakeWire,
} = require("../test-support/real-roborock-wire");

const DUID = "duid-s8-pro-ultra";

describe("the frame counter has both halves", () => {
  beforeEach(() => {
    resetFrameCounters();
  });

  test("a robot nothing has happened to reports zeroes, not undefined", () => {
    expect(describeDroppedFrames(DUID)).toEqual({
      total: 0,
      accepted: 0,
      byReason: {},
    });
  });

  test("accepted frames are counted per robot, alongside the drops", () => {
    noteAcceptedFrame(DUID);
    noteAcceptedFrame(DUID);
    noteDroppedFrame(DUID, "addressed-elsewhere");
    noteAcceptedFrame("another-robot");

    expect(describeDroppedFrames(DUID)).toEqual({
      total: 1,
      accepted: 2,
      byReason: { "addressed-elsewhere": 1 },
    });
    expect(describeDroppedFrames("another-robot").accepted).toBe(1);
  });
});

describe("the give-up line tells another controller from a bug here", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    resetFrameCounters();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  async function giveUpOnMap(seed) {
    const wire = createRealRoborockOnFakeWire({ transport: "cloud" });
    const { api, log } = wire;
    api.unansweredMethods.govern(DUID, "get_map_v1");
    seed();

    for (let i = 0; i < 6; i += 1) {
      const request = api.messageQueueHandler
        .sendRequest(DUID, "get_map_v1", [])
        .catch((error) => error);
      await jest.advanceTimersByTimeAsync(30_000);
      await request;
    }

    return log.info.mock.calls
      .map(([line]) => line)
      .find((line) => /has not answered get_map_v1 6 times/.test(line));
  }

  test("drops for another controller, with frames of ours accepted, are not called a bug", async () => {
    const giveUp = await giveUpOnMap(() => {
      noteAcceptedFrame(DUID);
      for (let i = 0; i < 30; i += 1) {
        noteDroppedFrame(DUID, "addressed-elsewhere");
      }
    });

    expect(giveUp).toMatch(/addressed to a different controller/);
    expect(giveUp).toMatch(/Roborock app/);
    expect(giveUp).not.toMatch(/it is a bug here/);
    expect(giveUp).not.toMatch(/Please report this/);
  });

  // 3.38.0 called this one a bug here. The endpoint sent and the endpoint
  // checked are the same value, so "nothing addressed to us" only means the
  // robot sent no map reply to this plugin — which the line already says.
  test("drops for another controller with nothing ever accepted are not called a bug either", async () => {
    const giveUp = await giveUpOnMap(() => {
      for (let i = 0; i < 30; i += 1) {
        noteDroppedFrame(DUID, "addressed-elsewhere");
      }
    });

    expect(giveUp).toMatch(/addressed to a different controller/);
    expect(giveUp).toMatch(/No reply to this plugin's own map request arrived/);
    expect(giveUp).not.toMatch(/bug here/);
    expect(giveUp).not.toMatch(/account key/);
    expect(giveUp).not.toMatch(/please report/i);
  });

  test("a frame with our endpoint that could not be used names the second-instance cause", async () => {
    const giveUp = await giveUpOnMap(() => {
      noteAcceptedFrame(DUID);
      noteDroppedFrame(DUID, "no-request-waiting");
      noteDroppedFrame(DUID, "no-request-waiting");
    });

    expect(giveUp).toMatch(/no-request-waiting: 2/);
    expect(giveUp).toMatch(/same Roborock account/);
    expect(giveUp).toMatch(/please report this line/);
    expect(giveUp).not.toMatch(/it is a bug here/);
  });

  test("a robot with no frames at all keeps the plain silent verdict", async () => {
    const giveUp = await giveUpOnMap(() => {});

    expect(giveUp).toMatch(/no map reply frame was received and discarded/);
    expect(giveUp).not.toMatch(/it is a bug here/);
  });
});

describe("a frame addressed to us is counted as accepted on the real path", () => {
  beforeEach(() => {
    resetFrameCounters();
    mockCapturedHandlers.clear();
  });

  /**
   * The 301 branch, driven through the real message handler. Only the cipher
   * is faked: `_decodeMsg` hands back the frame the robot would have sent.
   */
  async function deliver301(endpointOnTheWire) {
    const adapter = {
      config: {},
      log: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      },
      localKeys: new Map([[DUID, "local-key"]]),
      devices: [{ duid: DUID }],
      pendingRequests: new Map(),
      nonce: Buffer.alloc(16, 7),
      setTimeout: jest.fn(),
      clearTimeout: jest.fn(),
      setStateAsync: jest.fn(),
      message: { _decodeMsg: jest.fn() },
    };

    const connector =
      new (require("../roborockLib/lib/roborock_mqtt_connector").roborock_mqtt_connector)(
        adapter
      );
    await connector.initUser({
      rriot: { u: "user-id", k: "key", s: "secret", r: { m: "mqtts://b" } },
    });
    const ours = connector.getEndpoint();

    // 15-byte endpoint, 1 unknown, 2-byte id, 6 unknown — then a body the
    // decipher will refuse. Only the guard is under test, so the throw that
    // follows an accepted frame is caught and ignored here.
    const header = Buffer.alloc(24, 0);
    Buffer.from(endpointOnTheWire === "ours" ? ours : "Zz9yXw1v", "utf8").copy(
      header,
      0
    );
    header.writeUInt16LE(4242, 16);
    adapter.message._decodeMsg = jest.fn(() => ({
      protocol: 301,
      payload: Buffer.concat([header, Buffer.alloc(32, 1)]),
    }));

    await connector.initMQTT_Message();
    try {
      mockCapturedHandlers.get("message")(
        `rr/m/o/user-id/mqttuser/${DUID}`,
        Buffer.from("raw")
      );
    } catch {
      // The fake body cannot be deciphered; the guard has already run.
    }
    return adapter;
  }

  test("our own endpoint counts as accepted and is not dropped", async () => {
    await deliver301("ours");
    const seen = describeDroppedFrames(DUID);
    expect(seen.accepted).toBe(1);
    expect(seen.byReason["addressed-elsewhere"]).toBeUndefined();
  });

  test("another controller's endpoint is dropped and not counted as accepted", async () => {
    await deliver301("theirs");
    const seen = describeDroppedFrames(DUID);
    expect(seen.accepted).toBe(0);
    expect(seen.byReason["addressed-elsewhere"]).toBe(1);
  });
});
