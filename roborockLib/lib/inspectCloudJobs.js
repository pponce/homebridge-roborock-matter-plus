"use strict";

// Read-only diagnostics for cloud jobs. This module has no login, MQTT, file
// writes, or schedule-write path. The caller supplies its existing API client.
const { createHash } = require("node:crypto");

const SECRET = /password|token|secret|local.?key|authorization|cookie|rriot|client.?id|serial|mac|ssid|bssid|email|url|host|^ip$/i;
const CRON = /^[\d*/?,\-]+(?:\s+[\d*/?,\-]+){4,6}$/;
const ZONE = /^(?:Africa|America|Antarctica|Arctic|Asia|Atlantic|Australia|Europe|Indian|Pacific|Etc)\/[A-Za-z_+\-/0-9]+$/;
const WORDS = new Set(["on", "off", "NORMAL", "TIMER", "WORKFLOW", "UTC", "GMT", "once", "daily"]);
const VERBS = new Set(["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]);

function scheduleShape(value, field = "", depth = 0) {
  if (depth > 30) return "<depth limit>";
  if (Array.isArray(value)) {
    return value.map((entry) => scheduleShape(entry, "", depth + 1));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      key,
      SECRET.test(key) ? "<redacted>" : scheduleShape(entry, key, depth + 1),
    ]));
  }
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return { jsonString: scheduleShape(JSON.parse(trimmed), "", depth + 1) };
    } catch {
      return "<unparseable JSON string>";
    }
  }
  if (field === "method" && /^[a-z_][a-z_0-9]{0,79}$/.test(value)) return value;
  if (WORDS.has(value) || CRON.test(value) || ZONE.test(value) || /^\d{1,18}$/.test(value)) return value;
  return "<string>";
}

function allowedMethods(headers) {
  const raw = typeof headers?.get === "function"
    ? headers.get("allow")
    : headers?.allow ?? headers?.Allow;
  if (typeof raw !== "string") return [];
  return [...new Set(raw.split(",").map((s) => s.trim().toUpperCase()).filter((s) => VERBS.has(s)))];
}

async function inspectCloudJobs(api, duid, jobs) {
  if (!Array.isArray(jobs)) return null;
  const report = {
    schemaVersion: 1,
    observedAt: new Date().toISOString(),
    jobs: jobs.map((job) => ({
      definition: scheduleShape(job),
      // A comparison aid, not a restoration snapshot. Do not print raw task
      // strings to expose settings that the sanitizer deliberately masks.
      paramFingerprint: createHash("sha256").update(JSON.stringify(job?.param ?? null)).digest("hex"),
    })),
    methodChecks: [],
  };
  const first = jobs.find((job) => job && typeof job === "object" &&
    /^\d{1,18}$/.test(String(job.id)) && typeof job.cron === "string" &&
    job.param && typeof job.param === "object");
  if (!first) return report;

  // The item path is used by existing Roborock clients. An Allow header is
  // evidence about routing, never proof of a working time-edit payload.
  // Controls distinguish a mapped endpoint from a catch-all OPTIONS answer.
  const base = `user/devices/${encodeURIComponent(duid)}/jobs`;
  for (const [target, path] of [
    ["collection", base],
    ["existingJob", `${base}/${first.id}`],
    ["absentControl", `${base}/${first.id}/no-such-subresource-control`],
  ]) {
    try {
      const response = await api.options(path, { timeout: 10000 });
      report.methodChecks.push({ target, jobId: first.id, ok: true,
        status: response.status ?? null, allow: allowedMethods(response.headers) });
    } catch (error) {
      report.methodChecks.push({ target, jobId: first.id, ok: false,
        status: error?.response?.status ?? null, allow: allowedMethods(error?.response?.headers) });
    }
  }
  return report;
}

module.exports = { inspectCloudJobs, scheduleShape };
