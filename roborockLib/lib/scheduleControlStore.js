"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

class ScheduleControlStore {
  constructor(filename) { this.filename = filename; }
  load() {
    let text;
    try { text = fs.readFileSync(this.filename, "utf8"); }
    catch (error) { if (error.code === "ENOENT") return { version: 1, robots: {} }; throw error; }
    const state = JSON.parse(text);
    if (state?.version !== 1 || !state.robots || typeof state.robots !== "object" || Array.isArray(state.robots)) {
      throw new Error("Saved schedule controls state is invalid; originals have been left untouched");
    }
    for (const robot of Object.values(state.robots)) {
      if (!robot || !Number.isFinite(robot.expiresAt) || typeof robot.paused !== "boolean" ||
          !robot.jobs || Array.isArray(robot.jobs) || !robot.timers || Array.isArray(robot.timers) || !Array.isArray(robot.conflicts)) throw new Error("Saved schedule controls record is invalid");
      for (const entry of Object.values(robot.jobs)) {
        if (!entry?.original || !entry.expected || typeof entry.original.cron !== "string" || typeof entry.expected.cron !== "string" ||
            !Number.isSafeInteger(entry.originalOccurrenceAt) || !Number.isSafeInteger(entry.currentOccurrenceAt)) throw new Error("Saved schedule original is invalid");
      }
      for (const entry of Object.values(robot.timers)) {
        if (!entry || typeof entry.original !== "boolean" || typeof entry.expected !== "boolean" ||
            (entry.desired !== undefined && typeof entry.desired !== "boolean")) throw new Error("Saved schedule enable state is invalid");
      }
    }
    return state;
  }
  save(state) {
    fs.mkdirSync(path.dirname(this.filename), { recursive: true, mode: 0o700 });
    const temporary = `${this.filename}.${randomUUID()}.tmp`;
    const handle = fs.openSync(temporary, "wx", 0o600);
    try { fs.writeFileSync(handle, JSON.stringify(state)); fs.fsyncSync(handle); }
    finally { fs.closeSync(handle); }
    fs.renameSync(temporary, this.filename);
    const directory = fs.openSync(path.dirname(this.filename), "r");
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  }
}
module.exports = { ScheduleControlStore };
