"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { selectScheduleDelayOccurrences } = require("../roborockLib/lib/selectScheduleDelayOccurrences");
const day = "2026-10-09";
const at = (clock) => Date.parse(`${day}T${clock}:00-07:00`);
const occurrence = (jobId, clock, other = {}) => ({ jobId, scheduledAt: at(clock), enabled: true, occurrenceDay: day, ...other });
const choose = (occurrences, other = {}) => selectScheduleDelayOccurrences({
  pressedAt: at("09:06"), occurrenceDay: day, isCleaning: false, paused: false, occurrences, ...other,
});
const chosenIds = (result) => result.selected.map((item) => item.jobId);

test("an idle vacuum only postpones future schedules, not an earlier completed run", () => {
  assert.deepEqual(chosenIds(choose([occurrence("morning", "09:00"), occurrence("next", "09:30")])), ["next"]);
});

test("cleaning at 09:06 includes the 09:00 schedule and later schedules", () => {
  assert.deepEqual(chosenIds(choose([occurrence("morning", "09:00"), occurrence("next", "09:30")], { isCleaning: true })), ["morning", "next"]);
});

test("an active run started more than ten minutes ago is outside the heuristic", () => {
  assert.deepEqual(chosenIds(choose([occurrence("morning", "08:55"), occurrence("next", "09:30")], { isCleaning: true })), ["next"]);
});

test("ten minutes is inclusive and a schedule due at the press is recent, not future", () => {
  assert.deepEqual(chosenIds(choose([occurrence("edge", "08:56")], { isCleaning: true })), ["edge"]);
  assert.deepEqual(chosenIds(choose([occurrence("now", "09:06")])), []);
  assert.deepEqual(chosenIds(choose([occurrence("now", "09:06")], { isCleaning: true })), ["now"]);
});

test("only the most recent of two different recent times is selected", () => {
  assert.deepEqual(chosenIds(choose([occurrence("first", "08:58"), occurrence("second", "09:03")], { isCleaning: true })), ["second"]);
});

test("simultaneous recent schedules are reported as ambiguous; future schedules still qualify", () => {
  const result = choose([occurrence("a", "09:00"), occurrence("b", "09:00"), occurrence("later", "09:30")], { isCleaning: true });
  assert.equal(result.reason, "ambiguous-recent-schedule");
  assert.deepEqual(chosenIds(result), ["later"]);
  assert.deepEqual(result.recentCandidateIds, ["a", "b"]);
});

test("disabled schedules, other occurrence days, and already-paused vacuums are excluded", () => {
  const items = [occurrence("off", "09:30", { enabled: false }), occurrence("tomorrow", "09:30", { occurrenceDay: "2026-10-10" }), occurrence("today", "09:30")];
  assert.deepEqual(chosenIds(choose(items)), ["today"]);
  assert.deepEqual(chosenIds(choose(items, { paused: true, isCleaning: true })), []);
});

test("repeat presses use the delayed effective time, not the original start", () => {
  const shifted = occurrence("morning", "10:00");
  assert.deepEqual(chosenIds(choose([shifted], { pressedAt: at("10:04"), isCleaning: true })), ["morning"]);
  assert.deepEqual(chosenIds(choose([shifted], { pressedAt: at("10:04"), isCleaning: false })), []);
});

test("a second press while docked keeps postponing a still-future delayed occurrence", () => {
  const first = choose([occurrence("morning", "09:00")], { pressedAt: at("09:05"), isCleaning: true });
  assert.deepEqual(chosenIds(first), ["morning"]);
  // The controller's successful first write changed 09:00 to 10:00.
  const second = choose([occurrence("morning", "10:00")], { pressedAt: at("09:20") });
  assert.deepEqual(chosenIds(second), ["morning"]);
  // After another successful write to 11:00 and a completed run, being idle
  // at 11:20 excludes it from the next press; it is not blindly re-added.
  assert.deepEqual(chosenIds(choose([occurrence("morning", "11:00")], { pressedAt: at("11:20") })), []);
});

test("does not mutate its input and refuses unknown robot/enable states", () => {
  const items = [Object.freeze(occurrence("future", "09:30"))];
  Object.freeze(items);
  choose(items);
  assert.throws(() => choose(items, { isCleaning: undefined }), TypeError);
  assert.throws(() => choose([occurrence("unknown", "09:30", { enabled: "on" })]), TypeError);
  assert.throws(() => choose([items[0], items[0]]), TypeError);
});
