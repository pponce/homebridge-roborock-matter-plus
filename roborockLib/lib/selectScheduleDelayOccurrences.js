"use strict";

const RECENT_RUN_WINDOW_MS = 10 * 60 * 1000;

/**
 * Select a vacuum's occurrences for one explicit Delay press.
 *
 * The caller resolves cron/timezones into timestamps and supplies the current
 * effective occurrence time (including previous delay presses). occurrenceDay
 * is the original local calendar date: a delayed run that crosses midnight
 * retains that date until the configured reset.
 *
 * This is the owner's chosen timing heuristic, not proof that a cloud job
 * started or completed. In particular, manual cleaning soon after a completed
 * schedule can make that recent schedule eligible again.
 *
 * Docking is independent of this selection and remains the caller's explicit
 * action, even when paused or when no schedules are eligible. This module does
 * not read robot history, write schedules, or issue robot commands.
 */
function selectScheduleDelayOccurrences({ pressedAt, occurrenceDay, isCleaning, paused, occurrences }) {
  if (!Number.isSafeInteger(pressedAt) || typeof isCleaning !== "boolean" || typeof paused !== "boolean" ||
      typeof occurrenceDay !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(occurrenceDay) || !Array.isArray(occurrences)) {
    throw new TypeError("A delay selection requires a timestamp, occurrence day, fresh cleaning state and schedule occurrences");
  }
  const ids = new Set();
  for (const item of occurrences) {
    if (!item || !["string", "number"].includes(typeof item.jobId) || !String(item.jobId) ||
        !Number.isSafeInteger(item.scheduledAt) || typeof item.enabled !== "boolean" ||
        typeof item.occurrenceDay !== "string" || ids.has(String(item.jobId))) {
      throw new TypeError("Schedule occurrence is invalid or duplicated");
    }
    ids.add(String(item.jobId));
  }
  if (paused) return { selected: [], recentCandidateIds: [], reason: "already-paused" };

  const today = occurrences.filter((item) => item.enabled && item.occurrenceDay === occurrenceDay);
  const future = today.filter((item) => item.scheduledAt > pressedAt);
  const recent = isCleaning ? today.filter((item) =>
    item.scheduledAt <= pressedAt && item.scheduledAt >= pressedAt - RECENT_RUN_WINDOW_MS) : [];
  const latestTime = recent.length ? Math.max(...recent.map((item) => item.scheduledAt)) : null;
  const latest = recent.filter((item) => item.scheduledAt === latestTime);

  // A tie does not identify one interrupted schedule. Delay future schedules
  // and explicitly report the ambiguity instead of choosing by job ID.
  const selected = [...future];
  if (latest.length === 1) selected.push(latest[0]);
  selected.sort((a, b) => a.scheduledAt - b.scheduledAt || String(a.jobId).localeCompare(String(b.jobId)));
  return {
    selected,
    recentCandidateIds: latest.map((item) => item.jobId),
    reason: latest.length > 1 ? "ambiguous-recent-schedule" : latest.length === 1 ? "recent-and-future" : "future-only",
  };
}

module.exports = { selectScheduleDelayOccurrences, RECENT_RUN_WINDOW_MS };
