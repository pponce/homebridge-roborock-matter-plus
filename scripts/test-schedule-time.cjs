#!/usr/bin/env node
"use strict";

// Developer trial bundled with this fork. Uses an existing session and the
// same Hawk signer as the plugin; never logs in or creates an MQTT client.
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { buildHawkAuthorization } = require("../roborockLib/lib/hawkSignature");
const { runTimeTrial, TrialError } = require("../roborockLib/lib/cloudJobTimeTrial");

function readState(storage, name) {
  try {
    const wrapped = JSON.parse(fs.readFileSync(path.join(storage, `roborock.${name}`), "utf8"));
    const value = wrapped.val ?? wrapped;
    return typeof value === "string" ? JSON.parse(value) : value;
  } catch { throw new TrialError(name === "UserData" ? "SAVED_SESSION_UNAVAILABLE" : "DEVICE_INVENTORY_UNAVAILABLE"); }
}

function writePrivate(file, data) {
  const fd = fs.openSync(file, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(data, null, 2) + "\n");
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}

function makeRequester(rriot, collectionPath, jobId, fetchImpl = globalThis.fetch) {
  let base;
  try { base = new URL(rriot.r.a); } catch { throw new TrialError("INVALID_SAVED_API_ADDRESS"); }
  if (base.protocol !== "https:" || !base.hostname.endsWith(".roborock.com") ||
      base.username || base.password || base.search || base.hash ||
      (base.port && base.port !== "443") || !["", "/"].includes(base.pathname)) throw new TrialError("INVALID_SAVED_API_ADDRESS");
  if (![rriot.u, rriot.s, rriot.h].every((v) => typeof v === "string" && v.length > 0)) throw new TrialError("INVALID_SAVED_SESSION");
  const itemPath = `${collectionPath}/${jobId}`;
  return async (method, requestPath, payload) => {
    const permitted = (method === "GET" && requestPath === collectionPath) ||
      (["OPTIONS", "PUT"].includes(method) && requestPath === itemPath);
    if (!permitted) throw new TrialError("REQUEST_OUTSIDE_SELECTED_JOB");
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    const url = new URL(requestPath, base);
    const headers = { Authorization: buildHawkAuthorization(rriot, url.pathname, body) };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetchImpl(url, { method, headers, body, redirect: "error", signal: AbortSignal.timeout(15000) });
    let data;
    if (method !== "OPTIONS") {
      const text = await response.text();
      if (text.length > 2 * 1024 * 1024) throw new TrialError("RESPONSE_TOO_LARGE");
      try { data = JSON.parse(text); } catch { throw new TrialError("INVALID_CLOUD_RESPONSE"); }
    }
    return { status: response.status, allow: response.headers.get("allow"), data };
  };
}

function argumentsFrom(argv) {
  const options = {};
  const names = new Set(["storage", "robot", "model", "job-id", "expect-cron", "timezone", "output"]);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--execute") { options.execute = true; continue; }
    const name = argv[i].slice(2);
    if (!argv[i].startsWith("--") || !names.has(name) || options[name] !== undefined || !argv[i + 1] || argv[i + 1].startsWith("--")) {
      throw new TrialError("INVALID_ARGUMENTS");
    }
    options[name] = argv[++i];
  }
  if (!options.execute || [...names].some((n) => !options[n]) || !/^\d{1,18}$/.test(options["job-id"])) throw new TrialError("EXECUTE_AND_ALL_ARGUMENTS_REQUIRED");
  return options;
}

async function main(argv) {
  let report, output, lock, lockPath, interrupted = false, originalTime = "its original time";
  const cancel = () => {
    interrupted = true;
    process.stderr.write("Cancellation requested; finishing restoration checks before stopping.\n");
  };
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  try {
    const options = argumentsFrom(argv);
    const cronParts = options["expect-cron"].split(" ");
    if (/^\d{1,2}$/.test(cronParts[0]) && /^\d{1,2}$/.test(cronParts[1])) {
      originalTime = `${cronParts[1].padStart(2, "0")}:${cronParts[0].padStart(2, "0")}`;
    }
    const storage = path.resolve(options.storage);
    output = path.resolve(options.output);
    // Existing paths are refused. Never overwrite an earlier original.
    fs.mkdirSync(output, { mode: 0o700 });
    const home = readState(storage, "HomeData");
    const devices = (home.devices ?? []).filter((d) => d.name === options.robot);
    if (devices.length !== 1) throw new TrialError("ROBOT_NAME_NOT_UNIQUE_OR_NOT_OWNED");
    const device = devices[0];
    const product = (home.products ?? []).find((p) => String(p.id) === String(device.productId));
    if ((device.model ?? product?.model) !== options.model || typeof device.duid !== "string" || !device.duid) throw new TrialError("ROBOT_MODEL_OR_ID_MISMATCH");
    const rriot = readState(storage, "UserData")?.rriot;
    const collectionPath = `/user/devices/${encodeURIComponent(device.duid)}/jobs`;
    const request = makeRequester(rriot, collectionPath, options["job-id"]);
    lockPath = path.join(storage, "roborock.ScheduleTimeTrial.lock");
    try { lock = fs.openSync(lockPath, "wx", 0o600); }
    catch { throw new TrialError("ANOTHER_TRIAL_LOCK_EXISTS_OR_STORAGE_NOT_WRITABLE"); }
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, output, startedAt: new Date().toISOString() }));
    report = await runTimeTrial({ request, collectionPath, jobId: options["job-id"],
      expectedCron: options["expect-cron"], timeZone: options.timezone,
      cancelled: () => interrupted, progress: (message) => process.stdout.write(message + "\n"),
      saveOriginal: async (snapshot) => {
        writePrivate(path.join(output, "original-job.private.json"), { ...snapshot, deviceId: device.duid });
        const directory = fs.openSync(output, "r");
        try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
      },
    });
    report.robot = options.robot;
    report.model = options.model;
    report.robotRef = createHash("sha256").update(device.duid).digest("hex").slice(0, 12);
    report.robotPauseStateChecked = false;
  } catch (error) {
    report = { formatVersion: 1, success: false, writeAttempts: 0,
      error: error instanceof TrialError ? error.code : "LOCAL_SETUP_FAILED" };
  } finally {
    if (lock !== undefined) {
      fs.closeSync(lock);
      fs.unlinkSync(lockPath);
    }
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
  if (output) {
    try { writePrivate(path.join(output, "shareable-report.json"), report); }
    catch { report.reportFileSaved = false; }
  }
  process.stdout.write("\n===== START: SCHEDULE TIME TRIAL REPORT =====\n" + JSON.stringify(report, null, 2) + "\n===== STOP: SCHEDULE TIME TRIAL REPORT =====\n");
  if (output) process.stdout.write(`Report directory: ${output}\n`);
  if (report.success) process.stdout.write(`Cloud time change and restoration verified. Check that the app still shows ${originalTime} and disabled.\n`);
  else if (report.writeAttempts > 0 && !report.originalDefinitionRestored) process.stdout.write(`Restoration was NOT verified. In the Roborock app, restore this schedule to ${originalTime} and disable it. Keep the private original locally.\n`);
  else if (report.writeAttempts === 0) process.stdout.write("No schedule writes were attempted.\n");
  else process.stdout.write("The original cloud definition is restored, but the complete test did not pass.\n");
  process.exitCode = report.success ? 0 : 1;
}

if (require.main === module) main(process.argv.slice(2)).catch(() => {
  process.stderr.write("Unexpected diagnostic failure. Check the app and restore the original time and disabled state if needed.\n");
  process.exitCode = 1;
});

module.exports = { makeRequester, argumentsFrom, writePrivate };
