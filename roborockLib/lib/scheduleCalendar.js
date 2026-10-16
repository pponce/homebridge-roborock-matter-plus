"use strict";

const MINUTE = 60000;
const DAY = 86400000;
const formatters = new Map();

function localParts(timestamp, timezone) {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    formatters.set(timezone, formatter);
  }
  const p = Object.fromEntries(formatter.formatToParts(timestamp).map((v) => [v.type, v.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: +p.hour, minute: +p.minute,
    wall: Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) };
}

function parseCron(cron) {
  if (typeof cron !== "string") throw new Error("Schedule has no cron time");
  const p = cron.trim().split(/\s+/);
  if (p.length !== 5 || !/^\d{1,2}$/.test(p[0]) || !/^\d{1,2}$/.test(p[1]) ||
      +p[0] > 59 || +p[1] > 23 || !["?", "*"].includes(p[2]) || p[3] !== "*" ||
      !/^(?:\*|[0-6](?:,[0-6])*)$/.test(p[4])) {
    throw new Error("Delay supports weekly cloud schedules with one time and a weekday list");
  }
  return { minute: +p[0], hour: +p[1], days: p[4] === "*" ? [0, 1, 2, 3, 4, 5, 6] : [...new Set(p[4].split(",").map(Number))], wildcard: p[4] === "*", dom: p[2] };
}

// Resolve a wall clock using the zone's offsets around that date. A skipped or
// repeated DST time is ambiguous for a recurring cloud job; refuse to guess.
function atLocal(date, hour, minute, timezone) {
  const wall = Date.parse(`${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`);
  if (!Number.isFinite(wall)) throw new Error("Invalid schedule date");
  const offsets = new Set([-2, -1, 0, 1, 2].map((n) => {
    const sample = wall + n * DAY;
    return localParts(sample, timezone).wall - sample;
  }));
  const candidates = [...offsets].map((offset) => wall - offset).filter((candidate) => localParts(candidate, timezone).wall === wall);
  if (candidates.length !== 1) throw new Error("This schedule time is skipped or repeated by daylight saving time");
  return candidates[0];
}

function occurrenceToday(job, now) {
  const cron = parseCron(job.cron);
  const date = localParts(now, job.timeZoneId).date;
  if (!cron.days.includes(new Date(`${date}T00:00:00Z`).getUTCDay())) return null;
  return { date, timestamp: atLocal(date, cron.hour, cron.minute, job.timeZoneId) };
}

function shiftedCron(original, originalOccurrenceAt, targetAt) {
  const parsed = parseCron(original.cron);
  const start = localParts(originalOccurrenceAt, original.timeZoneId);
  const target = localParts(targetAt, original.timeZoneId);
  if (atLocal(target.date, target.hour, target.minute, original.timeZoneId) !== targetAt) {
    throw new Error("The delayed time cannot be represented by this schedule");
  }
  const delta = (Date.parse(`${target.date}T00:00Z`) - Date.parse(`${start.date}T00:00Z`)) / DAY;
  const days = parsed.days.map((day) => ((day + delta) % 7 + 7) % 7).sort((a, b) => a - b);
  return `${target.minute} ${target.hour} ${parsed.dom} * ${parsed.wildcard ? "*" : days.join(",")}`;
}

function nextReset(now, clock) {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(clock)) throw new Error("Daily reset time must be HH:mm");
  const [hour, minute] = clock.split(":").map(Number);
  const reset = new Date(now);
  reset.setHours(hour, minute, 0, 0);
  if (reset.getTime() <= now) { reset.setDate(reset.getDate() + 1); reset.setHours(hour, minute, 0, 0); }
  return reset.getTime();
}

function validateSettings(config) {
  const minutes = config.scheduleDelayMinutes ?? 60;
  const resetTime = config.scheduleResetTime ?? "00:05";
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) throw new Error("Delay interval must be a whole number from 1 to 1440 minutes");
  nextReset(Date.now(), resetTime);
  return { minutes, resetTime };
}

module.exports = { MINUTE, localParts, atLocal, parseCron, occurrenceToday, shiftedCron, nextReset, validateSettings };
