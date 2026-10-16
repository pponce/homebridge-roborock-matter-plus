#!/usr/bin/env node
"use strict";

// A fresh cloud GET plus historical robot-timer observations from existing
// logs. Does not restart services, query MQTT, or change any schedule.
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { makeRequester, loadSavedSession, readState, writePrivate } = require("./test-schedule-time.cjs");
const { scheduleShape } = require("../roborockLib/lib/inspectCloudJobs");
const { TrialError } = require("../roborockLib/lib/cloudJobTimeTrial");
const alias = (value) => createHash("sha256").update(String(value)).digest("hex").slice(0, 12);

function lastLoggedTimers(storage, duid) {
  let latest = { source: null, observedAt: null, historicalOnly: true, timers: null };
  const prefix = `Schedule discovery for ${duid}: type=array, value=`;
  for (const name of ["homebridge.log.1", "homebridge.log"]) {
    let fd;
    try {
      fd = fs.openSync(path.join(storage, name), "r");
      const size = fs.fstatSync(fd).size;
      const offset = Math.max(0, size - 16 * 1024 * 1024);
      const buffer = Buffer.alloc(size - offset);
      const count = fs.readSync(fd, buffer, 0, buffer.length, offset);
      let lines = buffer.subarray(0, count).toString("utf8").split("\n");
      if (offset) lines = lines.slice(1);
      for (const raw of lines) {
        const line = raw.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
        const start = line.indexOf(prefix);
        if (start < 0) continue;
        try {
          const timers = JSON.parse(line.slice(start + prefix.length));
          if (Array.isArray(timers)) latest = { source: name, observedAt: null, historicalOnly: true, timers };
        } catch { /* Incomplete log entries are not observations. */ }
      }
    } catch { /* Missing or unreadable logs do not invalidate the cloud GET. */ }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  return latest;
}

function describeJob(job, selectedJobId, logged) {
  const params = job.param?.params;
  const timerName = Array.isArray(params) && params.length === 1 ? params[0]?.name : null;
  const matches = timerName === null || timerName === undefined ? [] :
    (logged.timers ?? []).filter((timer) => Array.isArray(timer) && String(timer[0]) === String(timerName));
  const timerState = matches.length === 1 && ["on", "off"].includes(matches[0][1]) ? matches[0][1] : "unknown";
  const flag = job.enabled;
  return {
    jobId: job.id, selected: String(job.id) === String(selectedJobId),
    cron: scheduleShape(job.cron), timezone: scheduleShape(job.timeZoneId),
    cloudEnabled: typeof flag === "boolean" || flag === "true" || flag === "false" ? flag : null,
    cloudEnabledType: flag === null ? "null" : typeof flag,
    repeated: typeof job.repeated === "boolean" ? job.repeated : null,
    timerRef: timerName === null || timerName === undefined ? null : alias(timerName),
    matchingLoggedTimers: matches.length, timerStateFromLog: timerState,
    task: scheduleShape(job.param),
    paramFingerprint: createHash("sha256").update(JSON.stringify(job.param ?? null)).digest("hex"),
  };
}

async function inspect({ request, collectionPath, jobId, storage, duid }) {
  const requestedAt = new Date().toISOString();
  const response = await request("GET", collectionPath);
  if (response.status !== 200 || response.data?.success !== true || !Array.isArray(response.data.result)) throw new TrialError("CLOUD_READ_FAILED");
  const jobs = response.data.result;
  if (jobs.some((j) => !j || typeof j !== "object" || !/^\d{1,18}$/.test(String(j.id)))) throw new TrialError("UNEXPECTED_JOB_LIST");
  if (new Set(jobs.map((j) => String(j.id))).size !== jobs.length) throw new TrialError("DUPLICATE_JOB_IDS");
  const logged = lastLoggedTimers(storage, duid);
  return {
    formatVersion: 1, mode: "read-only preflight", success: true, writeAttempts: 0,
    cloudRequestedAt: requestedAt, cloudReceivedAt: new Date().toISOString(),
    selectedJobId: String(jobId), selectedJobFound: jobs.some((j) => String(j.id) === String(jobId)),
    robotPauseStateChecked: false,
    robotTimerObservation: { source: logged.source, observedAt: null, historicalOnly: true,
      note: "Last matching entry in bounded log tails; does not establish current robot state.",
      entryCount: logged.timers?.length ?? null },
    jobs: jobs.map((job) => describeJob(job, jobId, logged)),
  };
}

async function main(argv) {
  let output, report;
  try {
    const names = new Set(["storage", "robot", "model", "job-id", "output"]);
    const args = {};
    for (let i = 0; i < argv.length; i += 2) {
      const key = argv[i].slice(2);
      if (!argv[i].startsWith("--") || !names.has(key) || args[key] !== undefined || !argv[i + 1] || argv[i + 1].startsWith("--")) throw new TrialError("INVALID_ARGUMENTS");
      args[key] = argv[i + 1];
    }
    if ([...names].some((key) => !args[key]) || !/^\d{1,18}$/.test(args["job-id"])) throw new TrialError("MISSING_OR_INVALID_ARGUMENTS");
    const storage = path.resolve(args.storage);
    output = path.resolve(args.output);
    fs.mkdirSync(output, { mode: 0o700 });
    const home = readState(storage, "HomeData");
    const matches = (home.devices ?? []).filter((device) => device.name === args.robot);
    if (matches.length !== 1) throw new TrialError("ROBOT_NAME_NOT_UNIQUE_OR_NOT_OWNED");
    const device = matches[0];
    const product = (home.products ?? []).find((p) => String(p.id) === String(device.productId));
    if ((device.model ?? product?.model) !== args.model || typeof device.duid !== "string" || !device.duid) throw new TrialError("ROBOT_MODEL_OR_ID_MISMATCH");
    const { rriot, source } = loadSavedSession(storage);
    const collectionPath = `/user/devices/${encodeURIComponent(device.duid)}/jobs`;
    const request = makeRequester(rriot, collectionPath, args["job-id"], globalThis.fetch, { readOnly: true });
    report = await inspect({ request, collectionPath, jobId: args["job-id"], storage, duid: device.duid });
    Object.assign(report, { robot: args.robot, model: args.model, robotRef: alias(device.duid), authenticationSource: source });
  } catch (error) {
    report = { formatVersion: 1, mode: "read-only preflight", success: false, writeAttempts: 0,
      error: error instanceof TrialError ? error.code : "PREFLIGHT_FAILED" };
  }
  if (output) {
    try { writePrivate(path.join(output, "shareable-report.json"), report); }
    catch { report.reportFileSaved = false; }
  }
  process.stdout.write("\n===== START: SCHEDULE PREFLIGHT REPORT =====\n" + JSON.stringify(report, null, 2) + "\n===== STOP: SCHEDULE PREFLIGHT REPORT =====\n");
  if (output) process.stdout.write(`Report directory: ${output}\n`);
  process.stdout.write("Read-only diagnostic complete. No schedule or service changes were attempted.\n");
  process.exitCode = report.success ? 0 : 1;
}

if (require.main === module) main(process.argv.slice(2)).catch(() => {
  process.stderr.write("Read-only diagnostic failed; no schedule writes were attempted.\n");
  process.exitCode = 1;
});
module.exports = { inspect, lastLoggedTimers };
