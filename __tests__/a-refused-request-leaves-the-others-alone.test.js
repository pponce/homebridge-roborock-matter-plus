"use strict";

/**
 * A request refused before it is sent must not touch the pending entry of
 * another request.
 *
 * The three refusal branches (robot offline, no cloud, no local socket) used
 * to delete `pendingRequests[messageID]` although their own id had not been
 * stored yet. Request ids are shared by all robots, wrap at 9999, and a photo
 * request uses `id % 256`, so an id can collide with one still waiting for
 * its reply. That request then lost its entry, its real reply was dropped,
 * and its timeout counted as an "unanswered" strike in the give-up register.
 */

const {
  messageQueueHandler,
} = require("../roborockLib/lib/messageQueueHandler");

function adapterRefusing() {
  return {
    isRemoteDevice: jest.fn().mockResolvedValue(false),
    getRobotVersion: jest.fn().mockResolvedValue("1.0"),
    onlineChecker: jest.fn().mockResolvedValue(false),
    rr_mqtt_connector: {
      isConnected: jest.fn().mockReturnValue(true),
      sendMessage: jest.fn(),
    },
    config: {},
    localConnector: {
      isConnected: jest.fn().mockReturnValue(false),
      sendMessage: jest.fn(),
      clearChunkBuffer: jest.fn(),
    },
    message: {
      buildPayload: jest.fn().mockResolvedValue("payload"),
      buildRoborockMessage: jest.fn().mockResolvedValue(Buffer.from("frame")),
    },
    getRequestId: jest.fn().mockReturnValue(42),
    pendingRequests: new Map(),
    setTimeout: jest.fn(),
    clearTimeout: jest.fn(),
    log: { info: jest.fn(), debug: jest.fn(), warn: jest.fn() },
    updateTransportDiagnostics: jest.fn().mockResolvedValue(undefined),
    catchError: jest.fn(),
  };
}

test("a refused request with a colliding id leaves the waiting request's entry", async () => {
  const adapter = adapterRefusing();
  const waiting = { resolve: jest.fn(), reject: jest.fn() };
  adapter.pendingRequests.set(42, waiting);

  await expect(
    new messageQueueHandler(adapter).sendRequest("d1", "get_status", [])
  ).rejects.toBeTruthy();

  expect(adapter.pendingRequests.get(42)).toBe(waiting);
});
