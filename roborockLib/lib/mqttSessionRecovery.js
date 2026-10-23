"use strict";

const DEFAULT_PREVENTIVE_REFRESH_MINUTES = 240;
const COOLDOWN_MS = 60_000;
const SILENCE_COOLDOWN_MS = 30 * 60_000;
const READY_TIMEOUT_MS = 30_000; // 10 s upstream backoff + 20 s for connect/SUBACK.
const DRAIN_MS = 500;

// Optional triggers and request draining; the connector owns client replacement and retry backoff.
class MqttSessionRecovery {
  constructor(connector) {
    this.connector = connector;
    this.adapter = connector.adapter;
    this.preventiveRefreshEnabled =
      this.adapter.config.enableMqttPreventiveRefresh === true;
    const minutes = this.adapter.config.mqttPreventiveRefreshMinutes;
    this.preventiveRefreshMinutes = Number.isSafeInteger(minutes) && minutes >= 1 && Number.isSafeInteger(minutes * 60_000)
      ? minutes : DEFAULT_PREVENTIVE_REFRESH_MINUTES;
    /** @type {string | null} */
    this.lastReason = null;
    this.lastResult = "never";
    this.stopped = false;
    this.recovering = false;
    this.sendPaused = false;
    this.inFlight = null;
    this.readyAt = null;
    this.nextAllowedAt = 0;
    this.failures = 0;
    this.waits = new Set();
    this.timer = null;
  }

  // Connection listeners and logging are installed by the same connector path
  // as ordinary MQTT. They use upstream's listen/whileCurrent retirement guards.
  install() {
    if (!this.timer) {
      this.timer = setInterval(() => {
        if (
          this.preventiveRefreshEnabled &&
          this.readyAt !== null &&
          performance.now() - this.readyAt >= this.preventiveRefreshMinutes * 60_000
        ) {
          void this.recreate("preventive");
        }
      }, 60_000);
      this.timer.unref?.();
    }
  }

  onSessionChanged() {
    const session = this.connector.sessionDiagnostics;
    if (session.connected && session.subscriptionAcknowledged) {
      if (this.readyAt === null) this.readyAt = performance.now();
      if (!this.recovering && this.lastResult === "failed") {
        this.lastResult = "recovered";
        this.failures = 0;
      }
    } else {
      this.readyAt = null;
    }
  }

  observeTimeout(observation) {
    if (
      observation?.requestWasSilent &&
      observation?.correlatedSilenceObserved
    ) {
      void this.recreate("correlated-silence");
    }
  }

  snapshot() {
    return {
      enabled: true,
      preventiveRefreshEnabled: this.preventiveRefreshEnabled,
      preventiveRefreshMinutes: this.preventiveRefreshMinutes,
      preventiveRemainingMs: this.readyAt === null ? null : Math.max(0, this.preventiveRefreshMinutes * 60_000 - (performance.now() - this.readyAt)),
      waitingForIdle: this.lastResult === "deferred",
      inProgress: this.recovering,
      lastReason: this.lastReason,
      lastResult: this.lastResult,
      cooldownRemainingMs: Math.max(
        0,
        Math.round(this.nextAllowedAt - performance.now())
      ),
      silenceCooldownRemainingMs: Math.max(
        0,
        (this.adapter.cloudSessionHealth?.lastRestartAt || 0) +
          SILENCE_COOLDOWN_MS -
          Date.now()
      ),
      consecutiveFailures: this.failures,
    };
  }

  pending() {
    return [
      ...[...(this.adapter.pendingRequests?.entries() || [])]
        .filter(([, request]) => request.transport === "cloud")
        .map(([key, request]) => ({
          map: this.adapter.pendingRequests,
          key,
          request,
        })),
      ...[...(this.adapter.pendingB01MapRequests?.entries() || [])].map(
        ([key, request]) => ({
          map: this.adapter.pendingB01MapRequests,
          key,
          request,
        })
      ),
    ];
  }

  rejectPending() {
    for (const { map, key, request } of this.pending()) {
      if (request.timeout !== undefined) this.adapter.clearTimeout(request.timeout);
      map.delete(key);
      // Teardown is not a robot reply; keep upstream silence/breaker evidence.
      (request.abandon ?? request.reject)(
        Object.assign(
          new Error(
            "The MQTT session was replaced before a reply arrived. The command outcome is unknown; it was not replayed."
          ),
          {
            code: "MQTT_SESSION_REPLACED",
            generation: request.sessionGeneration ?? this.connector.sessionDiagnostics.generation,
            method: request.method,
            operationClass: request.operationClass,
            ambiguousWrite: request.operationClass === "write",
            transientKind: "mqtt session replaced",
            transportWasUp: false,
            unansweredRequest: false,
          }
        )
      );
    }
  }

  pause(ms) {
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.waits.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      timer.unref?.();
      this.waits.add(finish);
    });
  }

  busy() {
    return this.pending().length > 0 || this.adapter.config.isScheduleOperationPending?.() === true;
  }

  canRecoverSilence() {
    const lastRestartAt = this.adapter.cloudSessionHealth?.lastRestartAt || 0;
    return (
      !this.stopped &&
      !this.inFlight &&
      performance.now() >= this.nextAllowedAt &&
      (!lastRestartAt || Date.now() - lastRestartAt >= SILENCE_COOLDOWN_MS)
    );
  }

  recreate(reason) {
    if (this.inFlight) return this.inFlight;
    if (
      (reason === "correlated-silence" || reason === "cloud-silence") &&
      !this.canRecoverSilence()
    )
      return Promise.resolve(false);
    if (this.stopped || performance.now() < this.nextAllowedAt)
      return Promise.resolve(false);
    // A busy preventive refresh defers before touching the shared send gate.
    if (reason === "preventive" && (!this.connector.isReady() || this.busy())) {
      this.lastReason = reason;
      this.lastResult = "deferred";
      this.connector.sessionDiagnostics.emit(true);
      return Promise.resolve(false);
    }
    // New sends wait on the ordinary readiness gate while the old client drains.
    this.lastReason = reason;
    this.lastResult = "in-progress";
    this.adapter.log.info(`MQTT refresh starting: reason=${reason}; generation=${this.connector.sessionDiagnostics.generation}.`);
    this.recovering = true;
    this.sendPaused = true;
    this.nextAllowedAt = performance.now() + COOLDOWN_MS;
    this.connector.sessionDiagnostics.emit(true);
    this.inFlight = Promise.resolve()
      .then(() => this.perform(reason))
      .finally(() => {
        this.recovering = false;
        this.sendPaused = false;
        this.inFlight = null;
        this.connector.readiness.changed();
        if (!this.stopped) this.connector.sessionDiagnostics.emit(true);
      });
    return this.inFlight;
  }

  async perform(reason) {
    const connector = this.connector;
    const startedAt = performance.now();
    const before = connector.sessionDiagnostics.captureRequest();
    try {
      const deadline = startedAt + DRAIN_MS;
      while (
        !this.stopped &&
        this.pending().length &&
        performance.now() < deadline
      )
        await this.pause(20);
      if (this.stopped) return false;
      // Never deliberately interrupt an active request for an age refresh.
      // New inbound evidence during a reactive drain also cancels the need.
      if (
        (reason === "preventive" && this.busy()) ||
        (reason === "correlated-silence" &&
          before.rawSequence !==
            connector.sessionDiagnostics.captureRequest().rawSequence)
      ) {
        this.lastResult = "deferred";
        return false;
      }
      // Only silence-triggered replacements consume the 30-minute silence
      // cooldown. Preventive and health checks use the short general backoff.
      if (this.adapter.cloudSessionHealth) {
        if (reason === "correlated-silence" || reason === "cloud-silence") {
          this.adapter.cloudSessionHealth.lastRestartAt = Date.now();
        }
        this.adapter.cloudSessionHealth.consecutiveSilences = 0;
      }
      // Share upstream's one replacement path, random client IDs and 10 s x1.5
      // retry backoff. An age refresh never runs its own reconnect loop.
      const started = await connector.reconnectClient(true);
      if (!started && !connector.reconnectTimer) {
        this.lastResult = "deferred";
        return false;
      }
      this.sendPaused = false;
      connector.readiness.changed();
      // Observing our own replacement is not an unsent user request and must
      // not increment #37's connected/unsubscribed expiry counter.
      await connector.readiness.wait(READY_TIMEOUT_MS);
      if (this.stopped) return false;
      this.lastResult = "succeeded";
      this.failures = 0;
      this.nextAllowedAt = performance.now() + COOLDOWN_MS;
      this.adapter.log.info(
        `MQTT session recreation completed: reason=${reason}; generation=${connector.sessionDiagnostics.generation}; subscriptionAcknowledged=true; durationMs=${Math.round(performance.now() - startedAt)}.`
      );
      return true;
    } catch (error) {
      if (this.stopped) return false;
      this.readyAt = null;
      this.lastResult = "failed";
      this.failures = Math.min(this.failures + 1, 5);
      const backoff = Math.min(
        COOLDOWN_MS * 2 ** (this.failures - 1),
        15 * 60_000
      );
      this.nextAllowedAt = performance.now() + backoff;
      // Ordinary reconnect/backoff and #37's SUBACK recovery remain in charge.
      // No second retry timer competes with the connector.
      this.adapter.log.warn(
        `MQTT refresh did not become ready: reason=${reason}; ${error.message}. Upstream reconnect and subscription recovery remain active.`
      );
      return false;
    }
  }

  stop() {
    if (this.recovering) this.lastResult = "stopped";
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = null;
    for (const finish of [...this.waits]) finish();
    this.rejectPending();
  }
}

module.exports = { MqttSessionRecovery };
