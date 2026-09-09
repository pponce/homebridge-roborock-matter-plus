"use strict";

const mqtt = require("mqtt");
const crypto = require("crypto");
const Parser = require("binary-parser").Parser;
const zlib = require("zlib");
const roborockCrypto = require("./roborockCrypto");
const { describeDevice } = require("./describeDevice");
const {
  describeReplyRefusal,
  createRefusalError,
} = require("./describeReplyRefusal");
const {
  MqttSessionReplacedError,
  MqttReadinessError,
} = require("./mqttSessionErrors");

const PHOTO_MAGIC = "ROBOROCK";
const PHOTO_HEADER_MIN_LENGTH = 9;
const PROTOCOL_301_HEADER_LENGTH = 24;
const SILENT_READ_RECOVERY_WINDOW_MS = 15 * 60 * 1000;
const SILENT_READ_RECOVERY_SAME_ROBOT_THRESHOLD = 3;
const SILENT_READ_RECOVERY_DISTINCT_ROBOT_THRESHOLD = 2;

const protocol301Parser = new Parser()
  .endianess("little")
  .string("endpoint", {
    length: 15,
    stripNull: true,
  })
  .uint8("unknown1")
  .uint16("id")
  .buffer("unknown2", {
    length: 6,
  });

const photoParser = new Parser()
  .endianess("little")
  .string("roborock", {
    length: 8,
    stripNull: true,
  })
  .uint8("id");

let photoGzipChunks = [];
let photoChunkID = 0;

/**
 * True when a protocol-102 result is a bare "command accepted" acknowledgement
 * rather than real data. Roborock sends this as the single-element array
 * ["ok"]; some firmware answers with the bare string.
 * @param {unknown} result
 * @returns {boolean}
 */
function isOkAcknowledgement(result) {
  if (result === "ok") {
    return true;
  }
  return Array.isArray(result) && result.length === 1 && result[0] === "ok";
}

/**
 * Decide whether a protocol-102 reply completes a pending request.
 *
 * Only a secure request answered with a bare acknowledgement keeps waiting —
 * its real payload arrives on protocol 301. Everything else resolves here,
 * including a secure request that came back with an error, which would
 * otherwise hang until the request timeout.
 *
 * @param {{secure?: boolean}|undefined} pending
 * @param {unknown} result
 * @returns {boolean}
 */
function shouldResolveOn102(pending, result) {
  if (!pending) {
    return false;
  }
  return !(pending.secure === true && isOkAcknowledgement(result));
}

function payloadStartsWith(payload, value) {
  return (
    Buffer.isBuffer(payload) &&
    payload.length >= value.length &&
    payload.subarray(0, value.length).toString("utf8") === value
  );
}

function parsePhotoPayload(payload) {
  if (
    !payloadStartsWith(payload, PHOTO_MAGIC) ||
    payload.length < PHOTO_HEADER_MIN_LENGTH
  ) {
    return null;
  }

  return photoParser.parse(payload);
}

function parseProtocol301Header(payload) {
  if (
    !Buffer.isBuffer(payload) ||
    payload.length < PROTOCOL_301_HEADER_LENGTH
  ) {
    return null;
  }

  return protocol301Parser.parse(
    payload.subarray(0, PROTOCOL_301_HEADER_LENGTH)
  );
}

class roborock_mqtt_connector {
  constructor(adapter) {
    this.adapter = adapter;
    this.client = null;
    this.rriot = null;
    this.endpoint = null;
    this.mqttUser = null;
    this.mqttPassword = null;
    this.connected = false;
    this.socketConnected = false;
    this.subscriptionReady = false;
    this.sessionState = "disconnected";
    this.sessionGeneration = 0;
    this.readyAt = null;
    this.lastRawMqttMessageAt = null;
    this.lastAttributedCloudMessageAt = null;
    this.lastDecodedCloudMessageAt = null;
    this.lastCorrelatedCloudReplyAt = null;
    this.lastDecodedCloudMessageAtByDuid = new Map();
    this.lastCorrelatedCloudReplyAtByDuid = new Map();
    this.subscriptionTimeoutMs = 10000;
    this.shuttingDown = false;
    this.handlersInstalledFor = null;
    this.readinessWaiters = new Set();
    this.reconnectInProgress = null;
    this.lastReconnectAttemptAt = null;
    this.lastReconnectSucceededAt = null;
    this.lastReconnectFailureAt = null;
    this.consecutiveReconnectFailures = 0;
    this.nextReconnectAllowedAt = 0;
    this.reconnectCooldownMs = 30000;
    this.initialConnectTimeout = null;
    this.silentCloudReadTimeouts = [];
    // Last live presence value per robot, used only to suppress repeated logs.
    // Retained snapshots do not establish a live transition.
    this.robotPresenceByDuid = new Map();

    // NOTE: this class previously generated its own RSA-2048 keypair here,
    // but nothing ever read it — the protocol keypair lives in message.js
    // (lazily created for the rare photo path). Removed: one full RSA
    // keygen less at every startup.
  }

  async initUser(userdata) {
    this.rriot = userdata.rriot;

    this.endpoint = roborockCrypto
      .md5bin(this.rriot.k)
      .subarray(8, 14)
      .toString("base64"); // Could be a random but rather static string. The app generates it on first run.
    this.mqttUser = roborockCrypto
      .md5hex(this.rriot.u + ":" + this.rriot.k)
      .substring(2, 10);
    this.mqttPassword = roborockCrypto
      .md5hex(this.rriot.s + ":" + this.rriot.k)
      .substring(16);
    this.createClient();
  }

  createClient() {
    if (this.shuttingDown) {
      throw new MqttReadinessError(
        "Cannot create an MQTT session during shutdown.",
        "MQTT_SHUTTING_DOWN"
      );
    }
    this.sessionGeneration += 1;
    this.socketConnected = false;
    this.subscriptionReady = false;
    this.connected = false;
    this.readyAt = null;
    this.transitionSessionState("connecting", "client-created");
    const candidate = mqtt.connect(this.rriot.r.m, {
      clientId: this.mqttUser,
      username: this.mqttUser,
      password: this.mqttPassword,
      keepalive: 30,
    });
    this.client = candidate;
    this.handlersInstalledFor = null;
    this.installClientHandlers(candidate, this.sessionGeneration);
    return candidate;
  }

  async initMQTT_Subscribe() {
    // This used to invoke a `restart` method on the adapter, which the
    // Roborock class has never had — so on the one path it was written for
    // (the broker
    // neither connecting nor emitting `reconnect` within 30 s, e.g. a Pi that
    // boots before the network is up, or a SYN black-holed by a firewall) it
    // threw a TypeError inside an async timer. That is an unhandled rejection,
    // which terminates the Homebridge process under Node's default policy —
    // the exact opposite of the intended recovery. mqtt.js already retries on
    // its own reconnectPeriod, so the correct behaviour here is to say so
    // clearly and let it keep trying. The handle is stored and unref'd so
    // shutdown can cancel it instead of firing into a torn-down adapter.
    this.clearInitialConnectTimeout();
    this.initialConnectTimeout = setTimeout(() => {
      this.initialConnectTimeout = null;
      this.logConnectionIssue(
        `The Roborock MQTT broker has not answered within 30 seconds of startup. The client keeps reconnecting in the background; robots stay on cloud fallback until the session is up.`
      );
    }, 30000);
    if (typeof this.initialConnectTimeout?.unref === "function") {
      this.initialConnectTimeout.unref();
    }

    this.installClientHandlers(this.client, this.sessionGeneration);
  }

  isCurrentSession(candidate, generation) {
    return (
      !this.shuttingDown &&
      candidate === this.client &&
      generation === this.sessionGeneration
    );
  }

  transitionSessionState(nextState, reason) {
    if (this.sessionState !== nextState) {
      this.adapter?.log?.debug?.(
        `MQTT generation ${this.sessionGeneration} state ${this.sessionState} -> ${nextState}; reason=${reason}.`
      );
    }
    this.sessionState = nextState;
  }

  installClientHandlers(candidate, generation) {
    if (!candidate || this.handlersInstalledFor === candidate) {
      return;
    }
    this.handlersInstalledFor = candidate;

    candidate.on("connect", (result) => {
      if (!this.isCurrentSession(candidate, generation)) return;
      this.socketConnected = true;
      this.subscriptionReady = false;
      this.connected = false;
      this.transitionSessionState("subscribing", "socket-connected");
      this.clearInitialConnectTimeout();
      void this.subscribeForReplies(candidate, generation);
      this.adapter.log.debug(
        `MQTT generation ${generation} socket connected ${JSON.stringify(result)}.`
      );
    });

    candidate.on("message", (topic, message, packet) => {
      if (!this.isCurrentSession(candidate, generation)) return;
      this.handleMessage(topic, message, packet);
    });

    candidate.on("error", (error) => {
      if (!this.isCurrentSession(candidate, generation)) return;
      this.markNotReady("error");
      this.logConnectionIssue(
        `Roborock MQTT connection error: ${error?.message || error}. The client keeps reconnecting automatically.`
      );
    });
    candidate.on("close", () => {
      if (!this.isCurrentSession(candidate, generation)) return;
      if (this.connected)
        this.adapter.log.info(`MQTT connection closed; reconnecting.`);
      this.markNotReady("close");
    });
    candidate.on("offline", () => {
      if (!this.isCurrentSession(candidate, generation)) return;
      this.markNotReady("offline");
      this.logConnectionIssue(
        `Roborock MQTT connection is offline. The client keeps reconnecting automatically.`
      );
    });
    candidate.on("reconnect", () => {
      if (!this.isCurrentSession(candidate, generation)) return;
      this.markNotReady("reconnect");
      this.clearInitialConnectTimeout();
      this.adapter.log.debug(
        `MQTT generation ${generation} reconnect attempt.`
      );
    });
  }

  markNotReady(reason) {
    this.connected = false;
    this.socketConnected = false;
    this.subscriptionReady = false;
    this.readyAt = null;
    this.transitionSessionState("disconnected", reason);
  }

  async subscribeForReplies(candidate, generation) {
    const topic = `rr/m/o/${this.rriot.u}/${this.mqttUser}/#`;
    let timer;
    try {
      const granted = await Promise.race([
        new Promise((resolve, reject) => {
          candidate.subscribe(topic, (error, grants) =>
            error ? reject(error) : resolve(grants)
          );
        }),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("subscription acknowledgement timed out")),
            this.subscriptionTimeoutMs
          );
          timer.unref?.();
        }),
      ]);
      if (!this.isCurrentSession(candidate, generation)) return;
      const accepted =
        Array.isArray(granted) &&
        granted.some(
          (grant) => grant && grant.topic === topic && grant.qos !== 128
        );
      if (!accepted)
        throw new Error("broker did not grant the reply subscription");
      this.subscriptionReady = true;
      this.connected = true;
      this.readyAt = Date.now();
      this.transitionSessionState("ready", "subscription-acknowledged");
      this.resolveReadinessWaiters(generation);
      if (this._connectionIssueActive) {
        this._connectionIssueActive = false;
        this._connectionIssueLog?.clear();
        this.adapter.log.info(
          `Roborock MQTT connection recovered after the reported outage.`
        );
      }
      this.adapter.log.debug(
        `MQTT generation ${generation} subscription acknowledged.`
      );
    } catch (error) {
      if (!this.isCurrentSession(candidate, generation)) return;
      this.subscriptionReady = false;
      this.connected = false;
      this.transitionSessionState("disconnected", "subscription-failed");
      this.logConnectionIssue(
        `Failed to establish the Roborock MQTT reply subscription: ${error?.message || error}.`
      );
      this.rejectReadinessWaiters(
        new MqttReadinessError(
          `MQTT generation ${generation} could not establish reply readiness: ${error?.message || error}`,
          "MQTT_SUBSCRIPTION_FAILED"
        )
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Cancel the startup watchdog. Safe to call when it is not armed, and
   * called from shutdown so the timer cannot outlive the adapter.
   */
  clearInitialConnectTimeout() {
    if (this.initialConnectTimeout) {
      clearTimeout(this.initialConnectTimeout);
      this.initialConnectTimeout = null;
    }
  }

  /**
   * Warn about a connection problem at most once per 5 minutes per message,
   * and remember that an outage is in progress so the next successful
   * connect logs a single recovery line instead of silence.
   * @param {string} message
   */
  logConnectionIssue(message) {
    if (!this._connectionIssueLog) {
      this._connectionIssueLog = new Map();
    }
    this._connectionIssueActive = true;
    const now = Date.now();
    const lastAt = this._connectionIssueLog.get(message) || 0;
    if (now - lastAt >= 5 * 60 * 1000) {
      this._connectionIssueLog.set(message, now);
      this.adapter.log.warn(message);
    } else {
      this.adapter.log.debug(message);
    }
  }

  getKnownDeviceDuids() {
    const knownDuids = new Set();

    if (this.adapter.localKeys instanceof Map) {
      for (const duid of this.adapter.localKeys.keys()) {
        knownDuids.add(duid);
      }
    }

    if (this.adapter.devices && Array.isArray(this.adapter.devices)) {
      for (const device of this.adapter.devices) {
        if (device && device.duid) {
          knownDuids.add(device.duid);
        }
      }
    }

    return knownDuids;
  }

  resolveDuidFromTopic(topic) {
    const topicSegments = topic
      .split("/")
      .filter((segment) => segment && segment.length > 0);
    if (topicSegments.length === 0) {
      return null;
    }

    const knownDuids = this.getKnownDeviceDuids();
    const topicTail = topicSegments[topicSegments.length - 1];

    if (knownDuids.has(topicTail)) {
      return topicTail;
    }

    for (let index = topicSegments.length - 2; index >= 0; index--) {
      if (knownDuids.has(topicSegments[index])) {
        return topicSegments[index];
      }
    }

    if (knownDuids.size === 0) {
      return topicTail;
    }

    return null;
  }

  async initMQTT_Message() {
    this.adapter.log.debug(`MQTT initialized.`);
    this.installClientHandlers(this.client, this.sessionGeneration);
  }

  handleMessage(topic, message, packet = {}) {
    this.lastRawMqttMessageAt = Date.now();
    if (this.silentCloudReadTimeouts.length > 0) {
      this.silentCloudReadTimeouts = [];
      this.adapter.log.debug(
        "Cleared silent cloud-read recovery evidence after inbound MQTT activity."
      );
    }
    try {
      const duid = this.resolveDuidFromTopic(topic);
      if (!duid) {
        // Counted, not just logged: this is the one inbound path that drops
        // a frame silently as far as a user is concerned (decode failures
        // log at error, a missing localKey warns once). Without a count, a
        // cloud timeout cannot tell a robot that never answers from one
        // whose answers we fail to attribute — see #14.
        if (typeof this.adapter.noteUnattributedCloudMessage === "function") {
          this.adapter.noteUnattributedCloudMessage(topic);
        }
        this.adapter.log.debug(
          `Skipping MQTT message with unmatched topic '${topic}'.`
        );
        return;
      }
      this.lastAttributedCloudMessageAt = Date.now();

      const data = this.adapter.message._decodeMsg(message, duid);
      if (!data) {
        return;
      }
      this.lastDecodedCloudMessageAt = Date.now();
      this.lastDecodedCloudMessageAtByDuid.set(
        duid,
        this.lastDecodedCloudMessageAt
      );

      // Counted here and nowhere else: past the topic match AND past
      // decryption, so the count means the link delivered something real
      // from this robot. A cloud timeout reads it to tell "nothing came
      // back" from "something came back that we could not match" — two
      // causes that a bare timeout leaves indistinguishable (#14).
      if (typeof this.adapter.noteCloudMessageReceived === "function") {
        this.adapter.noteCloudMessageReceived(duid);
      }
      // this.adapter.log.debug(`MESSAGE RECEIVED for duid ${duid} with key: ${this.adapter.localKeys.get(duid)} data: ${JSON.stringify(data)} raw: ${JSON.stringify(mqttMessageParser.parse(message))} message: ${message}`);
      // this.adapter.log.debug(`MESSAGE RECEIVED for duid ${duid} with key: ${this.adapter.localKeys.get(duid)} data: ${JSON.stringify(data.toString("hex"))} message: ${message}`);
      // this.adapter.log.debug(`MESSAGE RECEIVED for duid ${duid} with key: ${this.adapter.localKeys.get(duid)} data: ${JSON.stringify(data)}`);

      // this.adapter.log.debug("Protocol: " + data.protocol);
      if (data.protocol == 102) {
        const parsedPayload = JSON.parse(data.payload);
        let dps;
        if (typeof parsedPayload.dps["102"] != "undefined") {
          dps = JSON.parse(parsedPayload.dps["102"]);
        } else if (typeof parsedPayload.dps["10001"] != "undefined") {
          if (typeof parsedPayload.dps["10001"] == "string") {
            dps = JSON.parse(parsedPayload.dps["10001"]);
          } else {
            dps = parsedPayload.dps["10001"];
          }
        } else {
          dps = parsedPayload.dps;
        }

        if (resolveB01PendingResponse(this.adapter, duid, dps)) {
          return;
        }

        if (dps.id !== undefined) {
          // Runs for every cloud message; only pay the stringify cost
          // when debug logging is actually enabled.
          if (this.adapter.config.debug) {
            // A reply with no `result` used to print "Result: undefined",
            // which reads like a robot that said nothing. It said something;
            // it just did not say it in `result`. Print the reply itself so
            // the refusal is on the record even when nobody is waiting for
            // this id any more.
            this.adapter.log.debug(
              typeof dps.result === "undefined"
                ? `Cloud message with protocol 102 and id ${dps.id} received. No result; reply was ${JSON.stringify(dps)}`
                : `Cloud message with protocol 102 and id ${dps.id} received. Result: ${JSON.stringify(dps.result)}`
            );
          }
          if (typeof dps.result !== "undefined") {
            this.adapter.setStateAsync("CloudMessage", {
              duid,
              payload: dps.result,
            });
          }
        } else {
          this.adapter.log.debug(
            `Cloud message with protocol 102 received. Result: ${data.payload}`
          );

          if (this.adapter.deviceNotify !== undefined) {
            this.adapter.deviceNotify("CloudMessage", {
              duid,
              payload: JSON.parse(data.payload),
            });
          }
        }

        // Secure requests (get_map_v1 and friends) answer protocol 102 with
        // a bare acknowledgement and deliver the real payload on protocol
        // 301, so those must stay pending. Everything else is resolved here.
        //
        // This used to be `if (dps.result != "ok")`, which is always true:
        // the wire format is the ARRAY ["ok"], and `["ok"] != "ok"` is false
        // only after ToPrimitive — so the guard never fired for the case it
        // was written for, and instead swallowed the completion of every
        // ordinary cloud command that answers ["ok"] (app_start, app_stop,
        // app_pause, app_charge, set_custom_mode, app_segment_clean, ...).
        // Those requests then sat until the 10 s timeout and failed in Apple
        // Home even though the robot had already carried them out.
        const pending = this.adapter.pendingRequests.get(dps.id);
        if (shouldResolveOn102(pending, dps.result)) {
          this.adapter.clearTimeout(pending.timeout);
          this.adapter.pendingRequests.delete(dps.id);
          this.noteCorrelatedReply(duid);
          // A refusal is a failed request, not an empty one. Resolving it
          // with `undefined` is indistinguishable from a real empty answer
          // to every caller upstream — see describeReplyRefusal.
          const refusal = describeReplyRefusal(dps);
          if (refusal) {
            pending.reject(
              createRefusalError(
                `The robot refused ${pending.method || "the request"} (cloud id ${dps.id}): ${refusal}`,
                dps
              )
            );
          } else {
            pending.resolve(dps.result);
          }
        }
        // protocol 300 seems to be for get_photo 0 only. get_photo 0 is for large images. 1 is for small images.
      } else if (data.protocol == 300) {
        const photoData = parsePhotoPayload(data.payload);
        if (photoData) {
          if (this.adapter.pendingRequests.has(photoData.id)) {
            this.adapter.log.debug(`First photo gzip chunk detected!`);

            photoGzipChunks.push(data.payload.slice(56));
            photoChunkID = photoData.id;
          }
        } else {
          this.adapter.log.debug(
            `Skipping protocol 300 MQTT message for ${duid} because the payload is not a complete Roborock photo header.`
          );
        }
      } else if (data.protocol == 301) {
        // B01/Q7 map upload responses arrive on protocol 301 as an opaque
        // base64 blob. Resolve the per-device pending map request first;
        // classic v1 photo/map chunk handling continues below otherwise.
        const pendingMap = this.adapter.pendingB01MapRequests?.get(duid);
        if (pendingMap) {
          this.adapter.clearTimeout(pendingMap.timeout);
          this.adapter.pendingB01MapRequests.delete(duid);
          pendingMap.resolve(data.payload);
          this.noteCorrelatedReply(duid);
          return;
        }

        // `photoGzipChunks != []` compared against a fresh array literal
        // and was therefore always true, so the guard it was written to be
        // never guarded anything.
        if (
          data.seq == 2 &&
          photoGzipChunks.length !== 0 &&
          photoChunkID != 0
        ) {
          this.adapter.log.debug(`Second photo gzip chunk detected!`);
          photoGzipChunks.push(data.payload);

          if (this.adapter.pendingRequests.has(photoChunkID)) {
            const { resolve, timeout } =
              this.adapter.pendingRequests.get(photoChunkID);
            this.adapter.clearTimeout(timeout);
            this.adapter.pendingRequests.delete(photoChunkID);

            const finalPhotoGzip = Buffer.concat(photoGzipChunks);

            photoGzipChunks = [];
            photoChunkID = 0;

            resolve(finalPhotoGzip);
            this.noteCorrelatedReply(duid);
          }
        } else {
          const photoData = parsePhotoPayload(data.payload);
          if (photoData) {
            this.adapter.log.debug(
              `Cloud message with protocol 301 and photo id ${photoData.id} received.`
            );

            if (this.adapter.pendingRequests.has(photoData.id)) {
              const { resolve, timeout } = this.adapter.pendingRequests.get(
                photoData.id
              );
              this.adapter.clearTimeout(timeout);
              this.adapter.pendingRequests.delete(photoData.id);
              this.adapter.log.debug(
                `Cloud message with protocol 301 and photo id ${photoData.id} received.`
              );
              resolve(data.payload.slice(56));
              this.noteCorrelatedReply(duid);
            }
          } else {
            const data2 = parseProtocol301Header(data.payload);
            if (!data2) {
              this.adapter.log.debug(
                `Skipping protocol 301 MQTT message for ${duid} because the payload is shorter than ${PROTOCOL_301_HEADER_LENGTH} bytes.`
              );
              return;
            }

            if (!this.endpoint.startsWith(data2.endpoint)) {
              return;
            }

            const iv = Buffer.alloc(16, 0);
            const decipher = crypto.createDecipheriv(
              "aes-128-cbc",
              this.adapter.nonce,
              iv
            );
            let decrypted = Buffer.concat([
              decipher.update(data.payload.subarray(24)),
              decipher.final(),
            ]);
            decrypted = zlib.gunzipSync(decrypted);
            // this.adapter.log.debug("raw 301: " + decrypted);

            if (this.adapter.pendingRequests.has(data2.id)) {
              const { resolve, timeout } = this.adapter.pendingRequests.get(
                data2.id
              );
              this.adapter.clearTimeout(timeout);
              this.adapter.pendingRequests.delete(data2.id);
              // this.adapter.log.debug("protocol 301 OK check: " + JSON.stringify(decrypted));
              this.adapter.log.debug(
                `Cloud message with protocol 301 and id ${data2.id} received.`
              );
              resolve(decrypted);
              this.noteCorrelatedReply(duid);
            }
          }
        }
      } else if (data.protocol == 500) {
        // 500 is for general information
        const dataString = data.payload.toString("utf8");
        let parsedData;

        try {
          parsedData = JSON.parse(dataString);
        } catch (error) {
          // If parsing fails, the data might be corrupted or in an unexpected format
          this.adapter.log.warn(
            `Unable to parse message for ${describeDevice(this.adapter, duid)}. Error: ${error.message}. Data: ${dataString}`
          );
          return;
        }

        // Accept Boolean presence and the numeric 0/1 form supported by the
        // previous loose comparison, without coercing arbitrary values.
        if (
          typeof parsedData.online === "boolean" ||
          parsedData.online === 0 ||
          parsedData.online === 1
        ) {
          const online = Boolean(parsedData.online);
          const retained = packet?.retain === true;
          const duplicate = packet?.dup === true;
          const label = describeDevice(this.adapter, duid);

          this.adapter.log.debug(
            `MQTT presence for ${label}: online=${online}; retain=${retained}; dup=${duplicate}; generation=${this.sessionGeneration}.`
          );
          if (retained) {
            // A subscription snapshot is not evidence of a new transition.
            return;
          }

          // DUP does not prove we received the earlier delivery. Process it
          // normally and suppress logs by the observed value, not the flag.
          const previous = this.robotPresenceByDuid.get(duid);
          this.robotPresenceByDuid.set(duid, online);
          if (previous === online) {
            return;
          }
          if (!online) {
            this.adapter.log.warn(
              `${label} reports itself offline via MQTT. This presence notification does not by itself prove that local or cloud commands will fail.`
            );
          } else if (previous === false) {
            this.adapter.log.info(`${label} is back online.`);
          }
        } else if (
          // Check for firmware update information
          parsedData.mqttOtaData
        ) {
          const otaStatus = parsedData.mqttOtaData.mqttOtaStatus?.status;
          const otaProgress = parsedData.mqttOtaData.mqttOtaProgress?.progress;

          if (otaStatus) {
            this.adapter.log.info(
              `${describeDevice(this.adapter, duid)} firmware update status: ${otaStatus}`
            );
          }

          if (otaProgress !== undefined) {
            this.adapter.log.info(
              `${describeDevice(this.adapter, duid)} firmware update progress: ${otaProgress}%`
            );
          }
        } else {
          // Received an unrecognized message
          this.adapter.log.warn(
            `Received an unrecognized message for ${describeDevice(this.adapter, duid)}. Data: ${dataString}`
          );
        }
      } else {
        this.adapter.log.debug(
          `Received message with unknown protocol ${data.protocol} data: ${JSON.stringify(data)}.`
        );
      }
    } catch (error) {
      this.adapter.log.error(
        `client.on message failed for topic '${topic}': ${error.stack || error}`
      );
    }
  }

  getEndpoint() {
    return this.endpoint;
  }

  noteCorrelatedReply(duid) {
    this.lastCorrelatedCloudReplyAt = Date.now();
    this.lastCorrelatedCloudReplyAtByDuid.set(
      duid,
      this.lastCorrelatedCloudReplyAt
    );
  }

  noteSilentCloudReadTimeout({
    duid,
    method,
    operationClass,
    sessionGeneration,
    publishedAt,
  }) {
    if (
      operationClass !== "read" ||
      !duid ||
      sessionGeneration !== this.sessionGeneration ||
      !Number.isFinite(publishedAt) ||
      (this.lastRawMqttMessageAt !== null &&
        this.lastRawMqttMessageAt > publishedAt)
    ) {
      return false;
    }

    const now = Date.now();
    this.silentCloudReadTimeouts = this.silentCloudReadTimeouts.filter(
      (failure) =>
        failure.generation === sessionGeneration &&
        now - failure.at <= SILENT_READ_RECOVERY_WINDOW_MS
    );
    this.silentCloudReadTimeouts.push({
      at: now,
      duid,
      method,
      generation: sessionGeneration,
    });

    const distinctRobots = new Set(
      this.silentCloudReadTimeouts.map((failure) => failure.duid)
    ).size;
    const sameRobotCount = this.silentCloudReadTimeouts.filter(
      (failure) => failure.duid === duid
    ).length;
    if (
      distinctRobots < SILENT_READ_RECOVERY_DISTINCT_ROBOT_THRESHOLD &&
      sameRobotCount < SILENT_READ_RECOVERY_SAME_ROBOT_THRESHOLD
    ) {
      return false;
    }

    const evidenceCount = this.silentCloudReadTimeouts.length;
    this.silentCloudReadTimeouts = [];
    this.adapter.log.info(
      `Repeated silent cloud reads detected on MQTT generation ${sessionGeneration}: failures=${evidenceCount}; distinctRobots=${distinctRobots}; lastMethod=${method}. Starting account session recovery.`
    );
    void this.reconnectAndWaitReady({
      reason: "repeated-silent-cloud-reads",
      mode: "recovery",
      drainTimeoutMs: 2000,
    }).catch((error) => {
      this.adapter.log.warn(
        `MQTT recovery after repeated silent cloud reads failed: ${error?.message || error}.`
      );
    });
    return true;
  }

  isPreventiveReconnectDue(minimumReadyAgeMs) {
    return (
      this.isReady() &&
      this.readyAt !== null &&
      Date.now() - this.readyAt >= minimumReadyAgeMs
    );
  }

  isReady() {
    return this.sessionState === "ready" && this.subscriptionReady;
  }

  getSessionGeneration() {
    return this.sessionGeneration;
  }

  getSessionHealthSnapshot(duid) {
    const now = Date.now();
    const age = (timestamp) =>
      typeof timestamp === "number" ? Math.max(0, now - timestamp) : null;
    return {
      state: this.sessionState,
      generation: this.sessionGeneration,
      socketConnected: this.socketConnected,
      subscriptionReady: this.subscriptionReady,
      readyAgeMs: age(this.readyAt),
      lastRawInboundAgeMs: age(this.lastRawMqttMessageAt),
      lastAttributedInboundAgeMs: age(this.lastAttributedCloudMessageAt),
      lastDecodedInboundAgeMs: age(
        duid
          ? this.lastDecodedCloudMessageAtByDuid.get(duid)
          : this.lastDecodedCloudMessageAt
      ),
      lastCorrelatedReplyAgeMs: age(
        duid
          ? this.lastCorrelatedCloudReplyAtByDuid.get(duid)
          : this.lastCorrelatedCloudReplyAt
      ),
    };
  }

  sendMessage(duid, roborockMessage) {
    this.client.publish(
      `rr/m/i/${this.rriot.u}/${this.mqttUser}/${duid}`,
      roborockMessage,
      {
        qos: 1,
      }
    );
  }

  isConnected() {
    return this.connected;
  }

  waitUntilReady({ timeoutMs = 10000, signal } = {}) {
    if (this.isReady()) return Promise.resolve(this.sessionGeneration);
    if (this.shuttingDown) {
      return Promise.reject(
        new MqttReadinessError(
          "MQTT readiness was requested during shutdown.",
          "MQTT_SHUTTING_DOWN"
        )
      );
    }
    if (signal?.aborted) {
      return Promise.reject(
        new MqttReadinessError("MQTT readiness wait was aborted.", "ABORT_ERR")
      );
    }

    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null, abortHandler: null };
      const finish = (callback, value) => {
        if (!this.readinessWaiters.delete(waiter)) return;
        if (waiter.timer) clearTimeout(waiter.timer);
        if (waiter.abortHandler) {
          signal?.removeEventListener("abort", waiter.abortHandler);
        }
        callback(value);
      };
      waiter.timer = setTimeout(
        () =>
          finish(
            reject,
            new MqttReadinessError(
              `MQTT session did not become ready within ${timeoutMs}ms.`,
              "MQTT_READINESS_TIMEOUT"
            )
          ),
        timeoutMs
      );
      waiter.timer.unref?.();
      if (signal) {
        waiter.abortHandler = () =>
          finish(
            reject,
            new MqttReadinessError(
              "MQTT readiness wait was aborted.",
              "ABORT_ERR"
            )
          );
        signal.addEventListener("abort", waiter.abortHandler, { once: true });
      }
      waiter.complete = (generation) => finish(resolve, generation);
      waiter.fail = (error) => finish(reject, error);
      this.readinessWaiters.add(waiter);
      if (this.isReady()) waiter.complete(this.sessionGeneration);
    });
  }

  resolveReadinessWaiters(generation) {
    for (const waiter of [...this.readinessWaiters])
      waiter.complete(generation);
  }

  rejectReadinessWaiters(error) {
    for (const waiter of [...this.readinessWaiters]) waiter.fail(error);
  }

  pendingCloudRequests(generation = this.sessionGeneration) {
    return [...(this.adapter.pendingRequests?.entries?.() || [])].filter(
      ([, pending]) =>
        pending?.transport === "cloud" &&
        pending?.sessionGeneration === generation
    );
  }

  pendingB01CloudRequests(generation = this.sessionGeneration) {
    return [...(this.adapter.pendingB01MapRequests?.entries?.() || [])].filter(
      ([, pending]) => pending?.sessionGeneration === generation
    );
  }

  allPendingCloudRequests(generation = this.sessionGeneration) {
    return [
      ...this.pendingCloudRequests(generation),
      ...this.pendingB01CloudRequests(generation),
    ];
  }

  rejectGenerationCloudRequests(generation) {
    let rejected = 0;
    for (const [id, pending] of this.pendingCloudRequests(generation)) {
      this.adapter.clearTimeout(pending.timeout);
      this.adapter.pendingRequests.delete(id);
      pending.reject(
        new MqttSessionReplacedError({
          generation,
          method: pending.method,
          operationClass: pending.operationClass,
        })
      );
      rejected += 1;
    }
    for (const [
      duid,
      pending,
    ] of this.adapter.pendingB01MapRequests?.entries?.() || []) {
      if (pending.sessionGeneration !== generation) continue;
      this.adapter.clearTimeout(pending.timeout);
      this.adapter.pendingB01MapRequests.delete(duid);
      pending.reject(
        new MqttSessionReplacedError({
          generation,
          method: pending.method,
          operationClass: "secure-map",
        })
      );
      rejected += 1;
    }
    if (photoChunkID && !this.adapter.pendingRequests?.has(photoChunkID)) {
      photoGzipChunks = [];
      photoChunkID = 0;
    }
    return rejected;
  }

  async waitForCloudDrain(generation, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (
      this.allPendingCloudRequests(generation).length > 0 &&
      Date.now() < deadline &&
      !this.shuttingDown
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return this.allPendingCloudRequests(generation);
  }

  async endClient(candidate, timeoutMs = 2000) {
    if (!candidate) return;
    candidate.removeAllListeners();
    if (typeof candidate.endAsync === "function") {
      let timer;
      try {
        await Promise.race([
          candidate.endAsync(true),
          new Promise((resolve) => {
            timer = setTimeout(resolve, timeoutMs);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    } else {
      candidate.end(true);
    }
  }

  reconnectAndWaitReady(options = {}) {
    if (this.reconnectInProgress) return this.reconnectInProgress;
    const operation = this.performReconnect(options);
    this.reconnectInProgress = operation;
    void operation
      .finally(() => {
        if (this.reconnectInProgress === operation)
          this.reconnectInProgress = null;
      })
      .catch(() => undefined);
    return operation;
  }

  async performReconnect({
    reason = "unspecified",
    mode = "recovery",
    drainTimeoutMs = 500,
    connectTimeoutMs = 10000,
    subscribeTimeoutMs = 10000,
    force = false,
  } = {}) {
    if (this.shuttingDown) {
      throw new MqttReadinessError(
        "MQTT reconnect was requested during shutdown.",
        "MQTT_SHUTTING_DOWN"
      );
    }
    const now = Date.now();
    if (!force && now < this.nextReconnectAllowedAt) {
      throw new MqttReadinessError(
        `MQTT reconnect cooldown remains active for ${this.nextReconnectAllowedAt - now}ms.`,
        "MQTT_RECONNECT_COOLDOWN"
      );
    }

    const startedAt = now;
    const oldGeneration = this.sessionGeneration;
    const oldClient = this.client;
    this.lastReconnectAttemptAt = now;
    this.connected = false;
    this.transitionSessionState("draining", reason);
    const counts = this.allPendingCloudRequests(oldGeneration).reduce(
      (value, [, request]) => {
        value[request.operationClass === "write" ? "writes" : "reads"] += 1;
        return value;
      },
      { reads: 0, writes: 0 }
    );
    this.adapter.log.info(
      `MQTT generation ${oldGeneration} entering ${mode}: reason=${reason}; pendingCloudReads=${counts.reads}; pendingCloudWrites=${counts.writes}.`
    );

    try {
      const remaining = await this.waitForCloudDrain(
        oldGeneration,
        drainTimeoutMs
      );
      if (this.shuttingDown) {
        throw new MqttReadinessError(
          "MQTT reconnect was cancelled by shutdown.",
          "MQTT_SHUTTING_DOWN"
        );
      }
      if (mode === "preventive" && remaining.length > 0) {
        this.connected = this.socketConnected && this.subscriptionReady;
        this.transitionSessionState(
          this.connected ? "ready" : "disconnected",
          "preventive-request-pending"
        );
        this.resolveReadinessWaiters(oldGeneration);
        return {
          generation: oldGeneration,
          connected: this.connected,
          subscriptionAcknowledged: this.subscriptionReady,
          oldCloudRequestsRejected: 0,
          durationMs: Date.now() - startedAt,
          skipped: true,
        };
      }

      const rejected =
        mode === "recovery"
          ? this.rejectGenerationCloudRequests(oldGeneration)
          : 0;
      this.transitionSessionState("reconnecting", reason);
      await this.endClient(oldClient);
      this.subscriptionTimeoutMs = subscribeTimeoutMs;
      this.createClient();
      const generation = await this.waitUntilReady({
        timeoutMs: connectTimeoutMs + subscribeTimeoutMs,
      });
      this.lastReconnectSucceededAt = Date.now();
      this.consecutiveReconnectFailures = 0;
      this.nextReconnectAllowedAt = 0;
      this.adapter.log.info(
        `MQTT generation ${generation} recovery completed in ${Date.now() - startedAt}ms; subscriptionAcknowledged=true; oldCloudRequestsRejected=${rejected}.`
      );
      return {
        generation,
        connected: true,
        subscriptionAcknowledged: true,
        oldCloudRequestsRejected: rejected,
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      this.lastReconnectFailureAt = Date.now();
      this.consecutiveReconnectFailures += 1;
      this.nextReconnectAllowedAt =
        Date.now() +
        this.reconnectCooldownMs * this.consecutiveReconnectFailures;
      this.rejectReadinessWaiters(error);
      try {
        await this.endClient(this.client);
      } catch (cleanupError) {
        this.adapter.log.debug(
          `MQTT reconnect cleanup failed: ${cleanupError?.message || cleanupError}.`
        );
      }
      if (!this.shuttingDown) this.markNotReady("reconnect-failed");
      throw error;
    }
  }

  /**
   * Close the MQTT session on shutdown.
   *
   * `client.end()` existed in exactly 1 place in this codebase — inside
   * `reconnectClient` — and never on the shutdown path. So during the seconds
   * between Homebridge's SIGTERM and its forced exit, robot frames kept
   * arriving and being dispatched into disposed accessories, and the socket
   * kept the event loop alive so the process only ever died by being killed.
   *
   * `end(true)` rather than a graceful close: there is nothing left worth
   * flushing to a broker at this point, and a graceful close can wait on an
   * ack that will not come if the network is what is broken.
   */
  disconnect() {
    this.clearInitialConnectTimeout();
    this.shuttingDown = true;
    this.subscriptionReady = false;
    this.socketConnected = false;
    this.connected = false;
    this.transitionSessionState("shutting-down", "shutdown");
    const shutdownError = new MqttReadinessError(
      "MQTT session shut down.",
      "MQTT_SHUTTING_DOWN"
    );
    this.rejectReadinessWaiters(shutdownError);
    this.rejectGenerationCloudRequests(this.sessionGeneration);
    if (!this.client) {
      return;
    }
    try {
      this.client.removeAllListeners();
      this.client.end(true);
    } catch (error) {
      this.adapter?.log?.debug?.(
        `Closing the MQTT client on shutdown failed: ${error?.message || error}`
      );
    }
  }

  /**
   * Resolve once the MQTT session is usable, or after `timeoutMs` regardless.
   *
   * The broker handshake takes a few seconds, and cloud requests issued
   * before it completes fail outright with "Cloud connection not available".
   * Startup used to get away with this because an unrelated fixed delay
   * happened to sit in front of the first requests; waiting on the real
   * signal makes that timing explicit rather than accidental. Resolving on
   * timeout (instead of rejecting) keeps a slow or offline broker from
   * blocking startup — callers fall back to their own error handling.
   *
   * @param {number} [timeoutMs=10000]
   * @returns {Promise<boolean>} whether the connection came up in time
   */
  async waitUntilConnected(timeoutMs = 10000) {
    if (this.connected) {
      return true;
    }

    const deadline = Date.now() + timeoutMs;
    while (!this.connected && Date.now() < deadline) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 100);
        if (typeof timer?.unref === "function") {
          timer.unref();
        }
      });
    }

    return this.connected;
  }

  async ensureConnected() {
    if (this.client && this.connected) {
      this.adapter.log.debug("MQTT health check passed. Reconnect skipped.");
      return false;
    }

    await this.reconnectClient(false);
    return true;
  }

  async reconnectClient(force = false) {
    if (!force && this.isReady()) {
      this.adapter.log.debug(
        "MQTT reconnect skipped because client is already ready."
      );
      return false;
    }
    try {
      await this.reconnectAndWaitReady({
        reason: "connectivity-check",
        mode: "recovery",
        force,
      });
      return true;
    } catch (error) {
      this.adapter.catchError(
        `Failed to reconnect with error: ${error}`,
        `reconnectClient`
      );
      return false;
    }
  }
}

/**
 * Correlate a Q7/B01 RPC response (dps 10001 payload) to its pending request
 * by msgId. Returns true when the dps object was a B01 message and has been
 * fully handled; false when the caller should continue v1 processing.
 * Robot-initiated B01 pushes (no matching request) trigger a status refresh
 * instead of guessing at undocumented event payload formats.
 */
function resolveB01PendingResponse(adapter, duid, dps) {
  if (!dps || dps.msgId === undefined || dps.id !== undefined) {
    return false;
  }

  const b01Key = String(dps.msgId);
  const pendingB01 = adapter.pendingRequests.get(b01Key);

  if (pendingB01) {
    adapter.clearTimeout(pendingB01.timeout);
    adapter.pendingRequests.delete(b01Key);
    adapter.rr_mqtt_connector?.noteCorrelatedReply?.(duid);
    if (dps.code !== undefined && dps.code !== 0) {
      pendingB01.reject(
        new Error(
          `B01 command ${dps.method || "(unknown method)"} failed with code ${dps.code} for ${describeDevice(adapter, duid)}.`
        )
      );
    } else {
      pendingB01.resolve(dps.data !== undefined ? dps.data : null);
    }
  } else {
    adapter.log.debug(
      `Unsolicited B01 message for ${describeDevice(adapter, duid)} (${dps.method || "no method"}); scheduling a status refresh.`
    );
    if (typeof adapter.getStatus === "function") {
      void adapter.getStatus(duid, { force: true }).catch(() => undefined);
    }
  }

  return true;
}

module.exports = {
  resolveB01PendingResponse,
  roborock_mqtt_connector,
  parseProtocol301Header,
  parsePhotoPayload,
  payloadStartsWith,
  isOkAcknowledgement,
  shouldResolveOn102,
};
