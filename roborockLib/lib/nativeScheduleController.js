"use strict";

const { selectScheduleDelayOccurrences } = require("./selectScheduleDelayOccurrences");
const { MINUTE, occurrenceToday, shiftedCron, nextReset, validateSettings } = require("./scheduleCalendar");
const { scheduleControlOptions } = require("./scheduleControlOptions");
const copy = (value) => JSON.parse(JSON.stringify(value));
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
function writable(job) {
  const result = copy(job);
  delete result.id;
  delete result.nextFireTime;
  return result;
}
function sameDefinition(a, b) {
  if (!a || !b || String(a.id) !== String(b.id)) return false;
  const left = writable(a), right = writable(b);
  // Enable changes belong to the user. Time restoration must preserve them.
  delete left.enabled; delete right.enabled;
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}
function timerId(job) {
  let p = job.param;
  if (typeof p === "string") { try { p = JSON.parse(p); } catch { return null; } }
  if (p?.method !== "server_scheduled_start" || !Array.isArray(p.params) || p.params.length !== 1) return null;
  const id = p.params[0]?.name;
  return ["string", "number"].includes(typeof id) ? String(id) : null;
}

class NativeScheduleController {
  constructor({ api, store, config = {}, clock = Date.now, changed = () => {}, log = () => {} }) {
    this.api = api; this.store = store; this.config = config; this.clock = clock;
    this.changed = changed; this.log = log; this.settings = validateSettings(config);
    this.state = store.load(); this.tail = Promise.resolve(); this.disposed = false;
  }

  status(duid) {
    const s = this.state.robots[duid];
    return { paused: Boolean(s?.paused), delayed: Boolean(s && (Object.keys(s.jobs).length || (s.paused && s.pauseSource === "delay") ||
      (s.recovering && !s.paused && Object.keys(s.timers).length))), recovering: Boolean(s?.recovering) };
  }
  save() { this.store.save(this.state); }
  get pauseUntilTomorrow() { return this.state.pauseUntilTomorrow !== false; }
  setPauseUntilTomorrow(enabled) {
    if (typeof enabled !== "boolean") return Promise.reject(new Error("Pause Until Tomorrow must be ON or OFF"));
    return this.enqueue(() => {
      if (this.pauseUntilTomorrow === enabled) return;
      const next = copy(this.state);
      next.pauseUntilTomorrow = enabled;
      if (enabled) {
        // Re-enabling this preference permits the next daily reset. An old
        // deadline from an indefinite pause must not cause immediate resume.
        const expiresAt = nextReset(this.clock(), this.settings.resetTime);
        for (const s of Object.values(next.robots)) if (s.paused && !s.recovering) s.expiresAt = expiresAt;
      }
      this.store.save(next);
      this.state = next;
    }, false);
  }
  expiryEnabled(s) { return !s.paused || this.pauseUntilTomorrow; }
  record(duid) {
    const current = this.state.robots[duid];
    if (current && !current.paused && !current.recovering && !Object.keys(current.jobs).length && !Object.keys(current.timers).length) {
      current.expiresAt = nextReset(this.clock(), this.settings.resetTime);
    }
    return this.state.robots[duid] ||= { expiresAt: nextReset(this.clock(), this.settings.resetTime), paused: false,
      jobs: {}, timers: {}, conflicts: [], recovering: false, failures: 0 };
  }
  enqueue(operation, useAccountQueue = true) {
    const run = this.tail.then(() => {
      if (this.disposed) throw new Error("Schedule controls are shutting down");
      return useAccountQueue && this.api.enqueue ? this.api.enqueue(operation) : operation();
    });
    this.tail = run.catch(() => {});
    return run.finally(() => { this.changed(); this.arm(); });
  }
  async initialize() { await this.recoverDue(); this.arm(); }
  dispose() { this.disposed = true; clearTimeout(this.timer); }
  arm() {
    clearTimeout(this.timer);
    if (this.disposed) return;
    const times = Object.values(this.state.robots).filter((s) => s.recovering || (this.expiryEnabled(s) && (s.paused || Object.keys(s.jobs).length || Object.keys(s.timers).length)))
      .map((s) => s.recovering ? (s.retryAt || this.clock() + MINUTE) : Math.max(s.expiresAt, s.retryAt || 0));
    if (!times.length) return;
    const delay = Math.max(1000, Math.min(2147483647, Math.min(...times) - this.clock()));
    this.timer = setTimeout(() => { void this.recoverDue().catch(() => {}).finally(() => this.arm()); }, delay);
    this.timer.unref?.();
  }
  async read(duid) {
    const jobs = await this.api.getJobs(duid);
    const timers = await this.api.getTimers(duid);
    if (!Array.isArray(jobs) || !Array.isArray(timers)) throw new Error("Schedule state is unavailable");
    const jobMap = new Map(), timerMap = new Map();
    for (const job of jobs) {
      if (!job || !["string", "number"].includes(typeof job.id) || jobMap.has(String(job.id))) throw new Error("Cloud jobs contain invalid or duplicate IDs");
      jobMap.set(String(job.id), job);
    }
    for (const timer of timers) {
      if (!timer || typeof timer.enabled !== "boolean" || timerMap.has(String(timer.id))) throw new Error("Robot timer state is invalid");
      timerMap.set(String(timer.id), timer);
    }
    return { jobs: jobMap, timers: timerMap };
  }
  conflict(duid, type, id) {
    const s = this.record(duid);
    s.conflicts.push({ type, id, detectedAt: this.clock(), saved: copy(s.jobs[id] || s.timers[id] || {}) });
    s.conflicts = s.conflicts.slice(-100);
    this.log(duid, `Preserved a changed or deleted ${type}; its saved original was not written over the current value.`);
  }
  abandonJob(duid, id, entry) {
    const s = this.record(duid), linkedTimer = timerId(entry.original);
    this.conflict(duid, "schedule", id);
    // Do not re-enable a temporarily stopped timer whose job disappeared or
    // unexpectedly changed while we were editing it. Keep its original for
    // inspection, and leave its present enable state to the owner.
    if (linkedTimer && s.timers[linkedTimer]) {
      this.conflict(duid, "timer", linkedTimer); delete s.timers[linkedTimer];
    }
    delete s.jobs[id]; this.save();
  }
  async writeTimer(duid, id, before, target) {
    if (before === target) return;
    if (this.disposed) throw new Error("Schedule controls are shutting down");
    const fresh = (await this.api.getTimers(duid)).find((timer) => String(timer.id) === id);
    if (!fresh) throw new Error("Schedule timer disappeared before its update");
    if (fresh.enabled === target) return;
    if (fresh.enabled !== before) throw new Error("Schedule timer changed before its update");
    const s = this.record(duid);
    const entry = s.timers[id] ||= { original: before, expected: before };
    entry.desired = target;
    this.save();
    let failure;
    try { await this.api.putTimer(duid, id, target); } catch (error) { failure = error; }
    const timers = await this.api.getTimers(duid);
    const current = timers.find((timer) => String(timer.id) === id);
    if (!current || current.enabled !== target) throw failure || new Error("Robot did not confirm the schedule enable state");
    entry.expected = target; delete entry.desired;
    this.save();
  }
  async writeJob(duid, before, after, metadata) {
    if (this.disposed) throw new Error("Schedule controls are shutting down");
    const id = String(before.id), s = this.record(duid);
    const entry = s.jobs[id] ||= { original: copy(before), expected: copy(before), ...metadata };
    entry.desired = copy(after);
    if (metadata) Object.assign(entry, metadata);
    this.save();
    let failure;
    try { await this.api.putJob(duid, id, writable(after)); } catch (error) { failure = error; }
    const current = (await this.api.getJobs(duid)).find((job) => String(job.id) === id);
    if (!sameDefinition(current, after) || current.enabled !== after.enabled) throw failure || new Error("Cloud did not confirm the requested schedule time and enable flag");
    entry.expected = copy(current); delete entry.desired;
    this.save();
  }
  async restoreTimes(duid, current) {
    const s = this.state.robots[duid];
    if (!s) return;
    for (const [id, entry] of Object.entries(s.jobs)) {
      const actual = current.jobs.get(id);
      if (!actual) {
        this.abandonJob(duid, id, entry); continue;
      }
      if (sameDefinition(actual, entry.original)) { delete s.jobs[id]; this.save(); continue; }
      if (![entry.expected, entry.desired].some((known) => sameDefinition(actual, known))) {
        this.abandonJob(duid, id, entry); continue;
      }
      // Only our cron edit is reverted. Preserve the fresh cloud enable flag.
      const restored = { ...actual, cron: entry.original.cron };
      await this.writeJob(duid, actual, restored);
      current.jobs.set(id, restored);
      delete s.jobs[id]; this.save();
    }
  }
  async restoreTimers(duid, current) {
    const s = this.state.robots[duid];
    if (!s) return;
    for (const [id, entry] of Object.entries(s.timers)) {
      const actual = current.timers.get(id);
      if (!actual) { this.conflict(duid, "timer", id); delete s.timers[id]; this.save(); continue; }
      if (actual.enabled !== entry.original) {
        if (actual.enabled !== entry.expected && actual.enabled !== entry.desired) {
          this.conflict(duid, "timer", id); delete s.timers[id]; this.save(); continue;
        }
        await this.writeTimer(duid, id, actual.enabled, entry.original);
        actual.enabled = entry.original;
      }
      delete s.timers[id]; this.save();
    }
  }
  async restoreAll(duid) {
    const s = this.state.robots[duid];
    if (!s) return;
    const current = await this.read(duid);
    // Original times must be restored before any paused timer is re-enabled.
    await this.restoreTimes(duid, current);
    await this.restoreTimers(duid, current);
    s.paused = false; s.recovering = false; s.failures = 0; delete s.retryAt; delete s.recoveryMode; delete s.pauseSource;
    if (!s.conflicts.length) delete this.state.robots[duid];
    this.save();
  }
  deferRecovery(duid) {
    const s = this.state.robots[duid];
    if (!s) return;
    s.recovering = true; s.failures = (s.failures || 0) + 1;
    s.retryAt = this.clock() + Math.min(15 * MINUTE, MINUTE * 2 ** Math.min(s.failures - 1, 4));
    this.save();
    this.log(duid, "Schedule restoration is pending; originals are saved and will be retried. No cleaning will be started by recovery.");
    this.changed(); this.arm();
  }
  async recoverOne(duid) {
    const s = this.state.robots[duid];
    if (s?.recoveryMode === "times" && s.expiresAt > this.clock()) {
      await this.restoreTimes(duid, await this.read(duid));
      s.recovering = false; s.failures = 0; delete s.retryAt; delete s.recoveryMode; this.save();
    } else await this.restoreAll(duid);
  }
  needsRecovery(s) {
    if (!s || (!s.paused && !s.recovering && !Object.keys(s.jobs).length && !Object.keys(s.timers).length)) return false;
    const options = scheduleControlOptions(this.config);
    const featureHidden = (s.paused && (s.pauseSource === "delay" ? !options.delayEnabled : !options.pauseEnabled)) ||
      (Object.keys(s.jobs).length && !options.delayEnabled);
    if (featureHidden) return true;
    if (!s.recovering && (!this.expiryEnabled(s) || s.expiresAt > this.clock())) return false;
    return !s.retryAt || s.retryAt <= this.clock();
  }
  async recoverDue() {
    for (const duid of Object.keys(this.state.robots)) {
      if (!this.needsRecovery(this.state.robots[duid])) continue;
      try { await this.enqueue(() => {
        // A preference or newer request may have changed while this waited.
        if (this.needsRecovery(this.state.robots[duid])) return this.recoverOne(duid);
      }); }
      catch { this.deferRecovery(duid); }
    }
  }
  async execute(duid, action, pressedAt = this.clock()) {
    return this.enqueue(async () => {
      let s = this.state.robots[duid];
      if (s && (s.recovering || (this.expiryEnabled(s) && s.expiresAt <= this.clock()))) {
        try { await this.recoverOne(duid); } catch (error) { this.deferRecovery(duid); throw error; }
        s = this.state.robots[duid];
      }
      if (s && !s.paused && !s.recovering && !Object.keys(s.jobs).length && !Object.keys(s.timers).length) s = undefined;
      if (action === "resume") {
        if (!s?.paused) return;
        s.recovering = true; s.recoveryMode = "all"; this.save();
        try { return await this.restoreAll(duid); } catch (error) { this.deferRecovery(duid); throw error; }
      }
      if (action === "cancelDelay") {
        if (s?.paused && s.pauseSource === "delay") {
          s.recovering = true; s.recoveryMode = "all"; this.save();
          try { return await this.restoreAll(duid); } catch (error) { this.deferRecovery(duid); throw error; }
        }
        if (!s || !Object.keys(s.jobs).length) return;
        s.recovering = true; s.recoveryMode = "times"; this.save();
        try { await this.recoverOne(duid); }
        catch (error) { this.deferRecovery(duid); throw error; }
        return;
      }
      if (!["pause", "delay", "startDelay"].includes(action)) throw new Error("Unknown schedule control action");
      if (action === "startDelay" && this.status(duid).delayed) return;
      const isCleaning = await this.api.isCleaning(duid);
      if (typeof isCleaning !== "boolean") throw new Error("Fresh robot cleaning state is unavailable");
      // Dock only for this explicit request. Recovery never calls this path.
      if (isCleaning) await this.api.dock(duid);
      if (s?.paused) {
        if (action === "pause" && s.pauseSource === "delay") { s.pauseSource = "pause"; this.save(); }
        return;
      }
      const current = await this.read(duid);
      if (action === "pause") return this.pause(duid, current);
      const candidates = [];
      const supportedTimers = new Set();
      const selectionDay = new Date(pressedAt).toISOString().slice(0, 10);
      for (const job of current.jobs.values()) {
        const id = timerId(job);
        if (id && supportedTimers.has(id) && current.timers.get(id)?.enabled) throw new Error("More than one cloud job refers to the same enabled timer");
        if (id) supportedTimers.add(id);
        const timer = id && current.timers.get(id);
        if (!timer?.enabled) continue;
        if (job.repeated !== true) throw new Error("Delay requires a repeated cloud schedule (repeated must be true)");
        if (typeof job.timeZoneId !== "string" || !job.timeZoneId.trim()) throw new Error("Delay requires the cloud schedule timeZoneId");
        const saved = s?.jobs[String(job.id)];
        if (saved && !sameDefinition(job, saved.expected)) throw new Error("A delayed schedule was edited externally; cancel its delay before extending it");
        const occurrence = saved ? { timestamp: saved.currentOccurrenceAt } : occurrenceToday(job, pressedAt);
        if (!occurrence) continue;
        // The selector sees today's eligible set, including an owned occurrence
        // carried past midnight. Its original date is retained in the journal.
        candidates.push({ jobId: job.id, enabled: true, occurrenceDay: selectionDay, scheduledAt: occurrence.timestamp, job, timerId: id,
          original: saved?.original || job, originalOccurrenceAt: saved?.originalOccurrenceAt ?? occurrence.timestamp });
      }
      if ([...current.timers.values()].some((timer) => timer.enabled && !supportedTimers.has(String(timer.id)))) {
        throw new Error("An enabled timer has no supported cloud schedule definition; its time cannot be delayed");
      }
      const selection = selectScheduleDelayOccurrences({ pressedAt, occurrenceDay: selectionDay, isCleaning, paused: false, occurrences: candidates });
      if (selection.reason === "ambiguous-recent-schedule") this.log(duid, "Two recent schedules share a time; only future schedules will be delayed.");
      if (!selection.selected.length) return;
      const cutoff = s?.expiresAt || nextReset(this.clock(), this.settings.resetTime);
      const targets = selection.selected.map((item) => ({ ...item, targetAt: item.scheduledAt + this.settings.minutes * MINUTE }));
      if (targets.some((item) => item.targetAt >= cutoff)) {
        await this.pause(duid, current, "delay");
        this.log(duid, "The delay would reach the daily reset; schedules are paused instead.");
        return;
      }
      if (targets.some((item) => item.targetAt <= this.clock() + MINUTE)) {
        throw new Error("The delayed time is already past or less than a minute away; no schedule times were changed");
      }
      for (const item of targets) item.after = { ...item.job, cron: shiftedCron(item.original, item.originalOccurrenceAt, item.targetAt) };
      s = this.record(duid); s.recovering = true; s.recoveryMode = "all"; this.save();
      try {
        // Temporarily stop the selected timers while their definitions change.
        for (const item of targets) await this.writeTimer(duid, item.timerId, true, false);
        for (const item of targets) {
          const fresh = (await this.api.getJobs(duid)).find((job) => String(job.id) === String(item.jobId));
          if (!sameDefinition(fresh, item.job)) throw new Error("Schedule changed before its time edit; restoring saved originals");
          // Some models mirror our temporary timer disable into cloud.enabled;
          // others keep it true. Preserve the freshly observed value in the PUT.
          await this.writeJob(duid, fresh, { ...fresh, cron: item.after.cron }, {
            original: copy(item.original), originalOccurrenceAt: item.originalOccurrenceAt, currentOccurrenceAt: item.targetAt,
          });
        }
        if (targets.some((item) => item.targetAt <= this.clock() + MINUTE)) {
          throw new Error("The delayed run became due during the update; saved originals will be restored");
        }
        await this.restoreTimers(duid, await this.read(duid));
        s.recovering = false; s.failures = 0; delete s.retryAt; delete s.recoveryMode; this.save();
        this.log(duid, `Delayed ${targets.length} schedule(s) by ${this.settings.minutes} minutes.`);
      } catch (error) { this.deferRecovery(duid); throw error; }
    });
  }
  async pause(duid, current, source = "pause") {
    const s = this.record(duid);
    s.paused = true; s.pauseSource = source; s.recovering = true; s.recoveryMode = "all"; this.save();
    try {
      for (const timer of current.timers.values()) {
        if (timer.enabled) await this.writeTimer(duid, String(timer.id), true, false);
      }
      await this.restoreTimes(duid, current);
      s.recovering = false; s.failures = 0; delete s.retryAt; delete s.recoveryMode; this.save();
      this.log(duid, this.pauseUntilTomorrow ? "Schedules are paused until the daily reset." : "Schedules are paused until manually resumed or automatic resume is enabled.");
    } catch (error) { this.deferRecovery(duid); throw error; }
  }
}

module.exports = { NativeScheduleController, writable, sameDefinition, timerId };
