"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "homebridge-ui/public/index.html"), "utf8");
const source = fs.readFileSync(path.join(root, "homebridge-ui/public/index.js"), "utf8");
const keys = ["schedulePauseAll", "schedulePausePerVacuum", "scheduleDelayAll", "scheduleDelayPerVacuum"];
const ids = ["schedule-pause-all", "schedule-pause-per-vacuum", "schedule-delay-all", "schedule-delay-per-vacuum"];

function harness(saved) {
  const elements = new Map();
  for (const [, attributes, id] of html.matchAll(/<\w+\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    const classes = new Set((attributes.match(/class="([^"]*)"/)?.[1] || "").split(/\s+/));
    let value = attributes.match(/value="([^"]*)"/)?.[1] || "";
    elements.set(id, { get value() { return value; }, set value(next) { value = String(next); }, checked: /\bchecked\b/.test(attributes),
      classList: { add: (s) => classes.add(s), remove: (s) => classes.delete(s), contains: (s) => classes.has(s),
        toggle: (s, force) => force ? classes.add(s) : classes.delete(s) }, addEventListener() {} });
  }
  const context = vm.createContext({ console, setTimeout: () => 0, clearTimeout() {},
    document: { getElementById: (id) => elements.get(id) || null, addEventListener() {} },
    window: { homebridge: { addEventListener() {}, getPluginConfig: async () => saved ? [{ platform: "RoborockVacuumPlatform", ...saved }] : [] } } });
  vm.runInContext(source, context);
  // Account/diagnostic endpoints are outside this form-persistence test.
  vm.runInContext("loadMatterPairing = async () => {}; loadDiagnostics = async () => {}; setLoggedInState = () => {};", context);
  return { elements, load: () => context.loadConfig(), sync: () => context.syncScheduleControlOptions(),
    form: () => JSON.parse(JSON.stringify(context.getFormValues())), context };
}

test("new and existing settings without scope keys default to all-vacuum controls", async () => {
  for (const saved of [undefined, { enableSchedulePauseUntilTomorrow: true, enableScheduleDelay: true }]) {
    const h = harness(saved);
    assert.deepEqual(keys.map((k) => h.form()[k]), [true, false, true, false]);
    await h.load();
    assert.deepEqual(keys.map((k) => h.form()[k]), [true, false, true, false]);
    assert.equal(h.elements.get("schedule-pause-options").classList.contains("hidden"), !saved);
    assert.equal(h.elements.get("schedule-delay-options").classList.contains("hidden"), !saved);
  }
});

test("explicit false and individual selections survive load, form save, and reload", async () => {
  const h = harness({ enableSchedulePauseUntilTomorrow: true, enableScheduleDelay: true }); await h.load();
  [false, true, false, true].forEach((value, i) => { h.elements.get(ids[i]).checked = value; });
  h.elements.get("schedule-delay-minutes").value = "30";
  h.elements.get("schedule-reset-time").value = "01:15";
  const saved = h.form();
  assert.deepEqual(keys.map((k) => saved[k]), [false, true, false, true]);
  const reopened = harness(saved); await reopened.load();
  assert.deepEqual(keys.map((k) => reopened.form()[k]), [false, true, false, true]);
  assert.equal(reopened.form().scheduleDelayMinutes, 30);
  assert.equal(reopened.form().scheduleResetTime, "01:15");
});

test("masters hide their own indented options without erasing remembered selections", async () => {
  const h = harness({ enableSchedulePauseUntilTomorrow: true, enableScheduleDelay: true, schedulePauseAll: false, schedulePausePerVacuum: true });
  await h.load();
  h.elements.get("enable-schedule-pause").checked = false; h.sync();
  assert.equal(h.elements.get("schedule-pause-options").classList.contains("hidden"), true);
  assert.equal(h.elements.get("schedule-delay-options").classList.contains("hidden"), false);
  assert.equal(h.elements.get("schedule-reset-options").classList.contains("hidden"), false);
  h.elements.get("enable-schedule-delay").checked = false; h.sync();
  assert.equal(h.elements.get("schedule-reset-options").classList.contains("hidden"), true);
  h.elements.get("enable-schedule-pause").checked = true; h.sync();
  assert.equal(h.elements.get("schedule-pause-options").classList.contains("hidden"), false);
  assert.equal(h.form().schedulePauseAll, false);
  assert.equal(h.form().schedulePausePerVacuum, true);
});

test("unrelated automatic saves do not persist unsaved scope changes", async () => {
  const h = harness({ enableScheduleDelay: true }); await h.load();
  h.elements.get("schedule-delay-all").checked = false;
  h.elements.get("schedule-delay-per-vacuum").checked = true;
  const patch = vm.runInContext("pickFields(getFormValues(), AUTO_SAVED_FIELDS)", h.context);
  for (const key of keys) assert.equal(Object.hasOwn(patch, key), false);
});

test("schema and markup agree on all-vacuum defaults", () => {
  const schema = JSON.parse(fs.readFileSync(path.join(root, "config.schema.json"), "utf8")).schema.properties;
  assert.deepEqual(keys.map((key) => schema[key].default), [true, false, true, false]);
  assert.deepEqual(ids.map((id) => harness().elements.get(id).checked), [true, false, true, false]);
});
