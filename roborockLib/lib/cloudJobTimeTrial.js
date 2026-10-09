"use strict";

const { isDeepStrictEqual } = require("node:util");
const { createHash } = require("node:crypto");

class TrialError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = (code) => { throw new TrialError(code); };
const clone = (value) => JSON.parse(JSON.stringify(value));
const fingerprint = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function definition(job) {
  const { nextFireTime, ...rest } = job;
  return rest;
}
function body(job) {
  const { id, nextFireTime, ...rest } = job;
  return rest;
}
function same(a, b) { return isDeepStrictEqual(definition(a), definition(b)); }
function summary(job) {
  return { jobId: job.id, cron: job.cron, timezone: job.timeZoneId,
    cloudEnabled: job.enabled, repeated: job.repeated, paramFingerprint: fingerprint(job.param) };
}

function validate(original, expectedCron, timeZone, now) {
  if (original.cron !== expectedCron) fail("ORIGINAL_TIME_DOES_NOT_MATCH");
  if (original.enabled !== false) fail("CLOUD_JOB_MUST_BE_DISABLED");
  if (original.repeated !== true || original.timeZoneId !== timeZone) fail("UNEXPECTED_SCHEDULE_SETTINGS");
  if (Object.keys(original).some((k) => !["id", "cron", "timeZoneId", "repeated", "enabled", "param", "nextFireTime"].includes(k))) {
    fail("UNKNOWN_JOB_FIELDS");
  }
  if (original.param?.method !== "server_scheduled_start" ||
      !Array.isArray(original.param.params) || original.param.params.length !== 1 ||
      !/^\d{1,18}$/.test(String(original.param.params[0]?.name))) fail("UNEXPECTED_TASK_SHAPE");
  const parts = expectedCron.split(" ");
  if (parts.length !== 5 || !/^\d{1,2}$/.test(parts[0]) || !/^\d{1,2}$/.test(parts[1]) ||
      parts[2] !== "?" || parts[3] !== "*" || !/^[0-6](?:,[0-6])*$/.test(parts[4])) fail("UNSUPPORTED_CRON");
  const minute = Number(parts[0]), hour = Number(parts[1]);
  if (minute > 58 || hour > 23) fail("TRIAL_REQUIRES_ONE_MINUTE_WITHIN_SAME_HOUR");
  const days = parts[4].split(",").map(Number);
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  for (let offset = 0; offset <= 360; offset++) {
    const fields = Object.fromEntries(formatter.formatToParts(new Date(now.getTime() + offset * 60000)).map((p) => [p.type, p.value]));
    if (days.includes(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(fields.weekday)) &&
        Number(fields.hour) === hour && [minute, minute + 1].includes(Number(fields.minute))) fail("SCHEDULE_OCCURS_WITHIN_SIX_HOURS");
  }
  const changed = clone(original);
  parts[0] = String(minute + 1).padStart(parts[0].length, "0");
  changed.cron = parts.join(" ");
  return changed;
}

async function runTimeTrial({ request, collectionPath, jobId, expectedCron, timeZone,
  saveOriginal, progress = () => {}, cancelled = () => false, now = new Date(),
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  const report = { formatVersion: 1, startedAt: now.toISOString(), jobId,
    timeEditVerified: false, originalDefinitionRestored: false, writeAttempts: 0,
    otherJobsUnchanged: null, events: [] };
  let original, changed, initialJobs;
  const itemPath = `${collectionPath}/${jobId}`;
  const read = async () => {
    const answer = await request("GET", collectionPath);
    if (answer.status !== 200 || answer.data?.success !== true || !Array.isArray(answer.data.result)) fail("JOB_READ_FAILED");
    const jobs = answer.data.result;
    if (jobs.some((j) => !j || typeof j !== "object" || !/^\d{1,18}$/.test(String(j.id)))) fail("INVALID_JOB_LIST");
    if (new Set(jobs.map((j) => String(j.id))).size !== jobs.length) fail("DUPLICATE_JOB_IDS");
    const selected = jobs.filter((j) => String(j.id) === String(jobId));
    if (selected.length !== 1) fail("SELECTED_JOB_NOT_FOUND");
    return { jobs, selected: selected[0] };
  };
  const write = async (job, event) => {
    report.writeAttempts++;
    report.events.push(event);
    const answer = await request("PUT", itemPath, body(job));
    if (answer.status < 200 || answer.status >= 300 || answer.data?.success !== true) fail("JOB_UPDATE_REJECTED");
  };
  const errorCode = (error) => error instanceof TrialError ? error.code : "REQUEST_OR_STORAGE_FAILED";
  const settledRead = async (wanted) => {
    let value;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        value = await read();
        if (same(value.selected, wanted)) return value;
      } catch (error) {
        if (attempt === 2) throw error;
      }
      if (attempt < 2) await wait(1000);
    }
    return value;
  };
  try {
    ({ jobs: initialJobs, selected: original } = await read());
    original = clone(original);
    changed = validate(original, expectedCron, timeZone, now);
    report.before = summary(original);
    report.proposed = summary(changed);
    const methods = await request("OPTIONS", itemPath);
    const allow = String(methods.allow ?? "").split(",").map((v) => v.trim().toUpperCase());
    if (methods.status !== 200 || !allow.includes("PUT")) fail("UPDATE_METHOD_NOT_ADVERTISED");
    if (cancelled()) fail("CANCELLED_BEFORE_WRITE");
    // The raw snapshot contains the complete job but no account credentials.
    // Persistence must finish successfully before the first write is attempted.
    await saveOriginal({ formatVersion: 1, savedAt: new Date().toISOString(), original, proposed: changed });
    progress("Original definition saved. Testing a one-minute change with cloud enabled=false.");
    if (!same((await read()).selected, original)) fail("SCHEDULE_CHANGED_BEFORE_WRITE");
    if (cancelled()) fail("CANCELLED_BEFORE_WRITE");
    await write(changed, "attemptedTimeChange");
    const observed = await settledRead(changed);
    report.afterChange = summary(observed.selected);
    if (!same(observed.selected, changed)) fail("TIME_CHANGE_READBACK_MISMATCH");
    report.timeEditVerified = true;
    progress("One-minute change verified. Restoring the saved definition.");
  } catch (error) {
    report.error = errorCode(error);
  } finally {
    if (report.writeAttempts > 0) {
      try {
        // A timed-out PUT may have succeeded. Read before deciding what is
        // ours to restore; never blindly repeat an ambiguous time change.
        let current = (await settledRead(changed)).selected;
        if (same(current, original)) {
          report.originalDefinitionRestored = true;
        } else if (same(current, changed)) {
          report.timeEditVerified = true;
          if (!report.afterChange) report.afterChange = summary(current);
          try { await write(original, "attemptedRestoration"); }
          catch (error) { report.restorationWriteError = errorCode(error); }
          current = (await settledRead(original)).selected;
          report.originalDefinitionRestored = same(current, original);
        } else {
          report.restorationError = "UNEXPECTED_CURRENT_DEFINITION_MANUAL_RESTORE_REQUIRED";
        }
        report.final = summary(current);
        if (!report.originalDefinitionRestored && !report.restorationError) report.restorationError = "RESTORATION_NOT_VERIFIED";
      } catch (error) {
        report.restorationError = errorCode(error);
      }
    }
  }
  if (initialJobs && report.writeAttempts > 0) {
    try {
      const final = await read();
      const others = (jobs) => jobs.filter((j) => String(j.id) !== String(jobId))
        .map(definition).sort((a, b) => String(a.id).localeCompare(String(b.id)));
      report.otherJobsUnchanged = isDeepStrictEqual(others(initialJobs), others(final.jobs));
      report.originalDefinitionRestored = report.originalDefinitionRestored && same(final.selected, original);
      report.final = summary(final.selected);
    } catch { report.finalReadError = "FINAL_READ_FAILED"; report.originalDefinitionRestored = false; }
  }
  report.success = report.timeEditVerified && report.originalDefinitionRestored && report.otherJobsUnchanged === true;
  report.finishedAt = new Date().toISOString();
  return report;
}

module.exports = { runTimeTrial, validate, TrialError };
