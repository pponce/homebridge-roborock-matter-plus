"use strict";

// Observations only. Nothing in this class reconnects, gates requests, or
// changes the unanswered-method breaker. Silence while idle is normal.
const SILENCE_WINDOW_MS = 60_000;
const SNAPSHOT_INTERVAL_MS = 30_000;
const MAX_ROBOTS = 128;
const SINGLE_ROBOT_WINDOW_MS = 15 * 60_000;
const SINGLE_ROBOT_THRESHOLD = 3;

/** @typedef {"raw" | "attributed" | "decoded" | "correlated" | "local"} ActivityStage */
class MqttSessionDiagnostics {
  /** @param {(snapshot: ReturnType<MqttSessionDiagnostics["snapshot"]>) => void} publish */
  constructor(publish = () => {}) {
    this.publish = publish;
    this.generation = 0;
    this.connected = false;
    this.subscriptionAcknowledged = false;
    this.rawSequence = 0;
    /** @type {number | null} */
    this.connectedAt = null;
    /** @type {Record<ActivityStage, number | null>} */
    this.activity = {
      raw: null,
      attributed: null,
      decoded: null,
      correlated: null,
      local: null,
    };
    /** @type {Map<string, number>} */
    this.silentReads = new Map();
    /** @type {Map<string, number[]>} */
    this.singleRobotReads = new Map();
    /** @type {number | null} */
    this.lastPublishedAt = null;
    /** @type {boolean | null} */
    this.rawSilenceDuringRequest = null;
    /** @type {number | null} */
    this.lastReadTimeoutAt = null;
  }

  onConnect() {
    this.generation += 1;
    this.connected = true;
    this.subscriptionAcknowledged = false;
    this.connectedAt = performance.now();
    this.activity = {
      raw: null,
      attributed: null,
      decoded: null,
      correlated: null,
      local: null,
    };
    this.silentReads.clear();
    this.singleRobotReads.clear();
    this.rawSilenceDuringRequest = null;
    this.lastReadTimeoutAt = null;
    this.emit(true);
    return this.generation;
  }

  onDisconnect() {
    this.connected = false;
    this.subscriptionAcknowledged = false;
    this.silentReads.clear();
    this.singleRobotReads.clear();
    this.rawSilenceDuringRequest = null;
    this.lastReadTimeoutAt = null;
    this.emit(true);
  }

  /** @param {number} generation @param {unknown} error @param {unknown} granted */
  onSubscribe(generation, error, granted) {
    if (generation !== this.generation || !this.connected) return;
    this.subscriptionAcknowledged =
      !error &&
      Array.isArray(granted) &&
      granted.length > 0 &&
      granted.every((entry) => [0, 1, 2].includes(entry.qos));
    this.emit(true);
  }

  /** @param {ActivityStage} stage */
  noteActivity(stage) {
    this.activity[stage] = performance.now();
    if (stage === "raw") {
      this.rawSequence += 1;
      this.silentReads.clear();
      this.singleRobotReads.clear();
    }
  }

  captureRequest() {
    return { generation: this.generation, rawSequence: this.rawSequence };
  }

  /**
   * @param {string} duid
   * @param {string} method
   * @param {{generation: number, rawSequence: number} | undefined} request
   */
  noteTimeout(duid, method, request) {
    this.prune();
    let requestWasSilent = false;
    // Only active, unanswered reads on an acknowledged, connected session
    // can contribute. A write may have succeeded even without its reply.
    if (
      this.connected &&
      this.subscriptionAcknowledged &&
      request &&
      request.generation === this.generation &&
      /^get_/.test(method)
    ) {
      this.rawSilenceDuringRequest = request.rawSequence === this.rawSequence;
      this.lastReadTimeoutAt = performance.now();
      requestWasSilent = this.rawSilenceDuringRequest;
      if (requestWasSilent) {
        if (
          !this.singleRobotReads.has(duid) &&
          this.singleRobotReads.size >= MAX_ROBOTS
        ) {
          const oldest = this.singleRobotReads.keys().next().value;
          if (oldest !== undefined) this.singleRobotReads.delete(oldest);
        }
        const reads = this.singleRobotReads.get(duid) || [];
        this.singleRobotReads.set(
          duid,
          [...reads, performance.now()].slice(-SINGLE_ROBOT_THRESHOLD)
        );
        if (
          !this.silentReads.has(duid) &&
          this.silentReads.size >= MAX_ROBOTS
        ) {
          const oldest = this.silentReads.keys().next().value;
          if (oldest !== undefined) this.silentReads.delete(oldest);
        }
        this.silentReads.set(duid, performance.now());
      }
    }
    this.emit(true);
    return {
      ...this.snapshot(),
      requestWasSilent,
      singleRobotSilentReadCount: requestWasSilent
        ? this.singleRobotReads.get(duid)?.length || 0
        : 0,
    };
  }

  prune() {
    const cutoff = performance.now() - SILENCE_WINDOW_MS;
    for (const [duid, reads] of this.singleRobotReads) {
      const recent = reads.filter(
        (at) => at >= performance.now() - SINGLE_ROBOT_WINDOW_MS
      );
      if (recent.length) this.singleRobotReads.set(duid, recent);
      else this.singleRobotReads.delete(duid);
    }
    for (const [duid, at] of this.silentReads) {
      if (at < cutoff) this.silentReads.delete(duid);
    }
  }

  snapshot() {
    this.prune();
    const now = performance.now();
    /** @param {number | null} at */
    const age = (at) =>
      at === null ? null : Math.max(0, Math.round(now - at));
    return {
      capturedAt: new Date().toISOString(),
      generation: this.generation,
      connected: this.connected,
      subscriptionAcknowledged: this.subscriptionAcknowledged,
      connectedAgeMs: age(this.connectedAt),
      lastRawInboundAgeMs: age(this.activity.raw),
      lastAttributedInboundAgeMs: age(this.activity.attributed),
      lastDecodedInboundAgeMs: age(this.activity.decoded),
      lastCorrelatedReplyAgeMs: age(this.activity.correlated),
      lastLocalReplyAgeMs: age(this.activity.local),
      // Historical observation for the latest eligible read timeout, not
      // a verdict on the current session or on a silent single robot.
      rawSilenceDuringRequest: this.rawSilenceDuringRequest,
      lastReadTimeoutAgeMs: age(this.lastReadTimeoutAt),
      silentReadRobotCount: this.silentReads.size,
      correlatedSilenceObserved: this.silentReads.size >= 2,
      observationWindowMs: SILENCE_WINDOW_MS,
      singleRobotSilentReadCount: Math.max(
        0,
        ...[...this.singleRobotReads.values()].map((reads) => reads.length)
      ),
      singleRobotThreshold: SINGLE_ROBOT_THRESHOLD,
      singleRobotWindowMs: SINGLE_ROBOT_WINDOW_MS,
    };
  }

  emit(force = false) {
    const now = performance.now();
    if (
      !force &&
      this.lastPublishedAt !== null &&
      now - this.lastPublishedAt < SNAPSHOT_INTERVAL_MS
    )
      return;
    this.lastPublishedAt = now;
    // Telemetry failure must not interfere with message handling.
    try {
      this.publish(this.snapshot());
    } catch {
      /* observation only */
    }
  }
}

module.exports = { MqttSessionDiagnostics };
