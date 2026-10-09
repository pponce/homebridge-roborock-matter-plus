"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { setImmediate: tick } = require("node:timers/promises");

function compile(source) {
  try {
    const ts = require("typescript");
    return ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018 } }).outputText;
  } catch (error) {
    if (error.code !== "MODULE_NOT_FOUND") throw error;
    // Local dependency-free checks; CI uses the repository's TypeScript above.
    return require("node:module").stripTypeScriptTypes(source, { mode: "transform" })
      .replace(/import\s+(\{[^}]+\})\s+from\s+("[^"]+");/g, "const $1 = require($2);")
      .replace(/export (class|function)/g, "$1") + "\nmodule.exports = { NativeScheduleControls, isNativeScheduleControl };";
  }
}
class Characteristic {
  removeAllListeners() { return this; }
  onGet(fn) { this.get = fn; return this; }
  onSet(fn) { this.set = fn; return this; }
}
class Service {
  constructor() { this.on = new Characteristic(); this.history = []; }
  setCharacteristic() { return this; }
  getCharacteristic() { return this.on; }
  updateCharacteristic(_key, value) { this.value = value; this.history.push(value); return this; }
}
class Accessory {
  constructor(name, uuid) { this.displayName = name; this.UUID = uuid; this.context = {}; this.services = new Map(); }
  getService(key) { return this.services.get(key); }
  addService(key) { const s = new Service(); this.services.set(key, s); return s; }
}
function harness(t, config = {}) {
  const h = { calls: [], registered: [], removed: [], engines: [], errors: [] };
  class Controller {
    constructor(options) { this.options = options; this.state = { robots: {} }; h.engines.push(this); }
    async initialize() { if (h.initializing) await h.initializing; }
    status(id) { return this.state.robots[id] || { paused: false, delayed: false }; }
    async execute(id, action) {
      h.calls.push([id, action]);
      if (h.execute) return h.execute(id, action, this);
      if (h.fail === id) throw new Error("simulated robot failure");
      this.state.robots[id] ||= { paused: false, delayed: false };
      const s = this.state.robots[id];
      if (action === "pause") s.paused = true;
      if (action === "resume") s.paused = false;
      if (action === "startDelay" || action === "delay") s.delayed = true;
      if (action === "cancelDelay") s.delayed = false;
      this.options.changed();
    }
    dispose() { this.disposed = true; }
  }
  const module = { exports: {} };
  const source = fs.readFileSync(path.join(__dirname, "../src/native_schedule_controls.ts"), "utf8");
  vm.runInNewContext(compile(source), { module, exports: module.exports, setTimeout, clearTimeout, require: (id) => {
    if (id.endsWith("nativeScheduleController")) return { NativeScheduleController: Controller };
    if (id.endsWith("scheduleControlStore")) return { ScheduleControlStore: class {} };
    if (id.endsWith("nativeScheduleApi")) return { createNativeScheduleApi: () => ({}) };
    if (id.endsWith("redactSecrets")) return { redactSecrets: String };
    if (id === "node:fs") return { existsSync: () => false };
    if (id === "./settings") return { HAP_PLUGIN_IDENTIFIER: "plugin", PLATFORM_NAME: "platform" };
    return require(id);
  } });
  h.accessories = [];
  h.platform = {
    platformConfig: { email: "test@example.invalid", ...config }, roborockAPI: {},
    Service: { AccessoryInformation: "info", Switch: "switch" },
    Characteristic: { Manufacturer: "manufacturer", Model: "model", SerialNumber: "serial", Name: "name", On: "on" },
    api: { hap: { uuid: { generate: (s) => s } }, platformAccessory: Accessory,
      registerPlatformAccessories: (_p, _n, values) => h.registered.push(...values),
      unregisterPlatformAccessories: (_p, _n, values) => h.removed.push(...values) },
    log: { info() {}, error: (s) => h.errors.push(s) },
  };
  h.manager = new module.exports.NativeScheduleControls(h.platform, h.accessories, {}, "/unused");
  h.sync = () => h.manager.sync([{ duid: "a", name: "Uptown" }, { duid: "b", name: "Downtown" }]);
  h.characteristic = (duid, control) => h.accessories.find((a) => a.context.duid === duid && a.context.control === control).getService("switch").on;
  h.service = (duid, control) => h.accessories.find((a) => a.context.duid === duid && a.context.control === control).getService("switch");
  t.after(() => h.manager.dispose()); return h;
}

test("new controls are opt-in and independent of the legacy action-switch master", (t) => {
  const off = harness(t); off.sync(); assert.equal(off.registered.length, 0);
  const on = harness(t, { enableSchedulePauseUntilTomorrow: true, enableScheduleDelay: true, enableHomeKitActionSwitches: false });
  on.sync(); on.sync(); assert.equal(on.registered.length, 9);
  assert.equal(new Set(on.registered.map((a) => a.UUID)).size, 9);
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("pause stays optimistic through initialization, GETs and refreshes; aggregate follows any robot", async (t) => {
  const h = harness(t, { enableSchedulePauseUntilTomorrow: true });
  const startup = deferred(), write = deferred(); h.initializing = startup.promise; h.sync();
  h.execute = async (id, action, engine) => {
    await write.promise;
    engine.state.robots[id] = { paused: true, delayed: false };
    engine.options.changed();
  };
  h.characteristic("b", "pause").set(true);
  assert.equal(h.characteristic("b", "pause").get(), true);
  assert.equal(h.characteristic(null, "pause").get(), true);
  h.engines[0].options.changed();
  assert.equal(h.service("b", "pause").value, true);
  startup.resolve(); await tick();
  const mark = h.service("b", "pause").history.length;
  h.sync(); await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(h.characteristic("b", "pause").get(), true);
  write.resolve(); await h.manager.commandTail;
  assert.equal(h.characteristic("b", "pause").get(), true);
  assert.ok(h.service("b", "pause").history.slice(mark).every(Boolean));
  assert.equal(h.characteristic("a", "pause").get(), false);
});

test("resume stays OFF while restoring; failure reverts ON and logs an error", async (t) => {
  const h = harness(t, { enableSchedulePauseUntilTomorrow: true }); h.sync();
  h.engines[0].state.robots.a = { paused: true, delayed: false };
  const write = deferred();
  h.execute = async () => { await write.promise; throw new Error("restore refused"); };
  h.characteristic("a", "pause").set(false);
  assert.equal(h.characteristic("a", "pause").get(), false);
  h.engines[0].options.changed();
  assert.equal(h.service("a", "pause").value, false);
  assert.equal(h.characteristic(null, "pause").get(), false);
  write.resolve(); await h.manager.commandTail;
  assert.equal(h.characteristic("a", "pause").get(), true);
  assert.match(h.errors[0], /\[SCHEDULE CONTROL FAILED\].*Uptown.*resume.*restore refused.*reverted to ON/);
});

test("failed partial pause reverts OFF despite tentative journal flags until recovery completes", async (t) => {
  const h = harness(t, { enableSchedulePauseUntilTomorrow: true }); h.sync();
  h.execute = async (id, action, engine) => {
    engine.state.robots[id] = { paused: true, delayed: false, recovering: true };
    engine.options.changed(); throw new Error("timer confirmation failed");
  };
  h.characteristic("b", "pause").set(true); await h.manager.commandTail;
  assert.equal(h.characteristic("b", "pause").get(), false);
  h.engines[0].options.changed(); h.sync();
  assert.equal(h.service("b", "pause").value, false);
  assert.equal(h.characteristic(null, "pause").get(), false);
  assert.match(h.errors[0], /SCHEDULE CONTROL FAILED.*Downtown.*reverted to OFF.*restoration is still pending/);
  delete h.engines[0].state.robots.b; h.engines[0].options.changed();
  assert.equal(h.characteristic("b", "pause").get(), false);
  assert.equal(h.manager.failedValues.size, 0);
});

test("newer individual OFF survives an older all-vacuum ON and executes after the whole batch", async (t) => {
  const h = harness(t, { enableSchedulePauseUntilTomorrow: true }); h.sync();
  const write = deferred();
  h.execute = async (id, action, engine) => {
    if (id === "a" && action === "pause") await write.promise;
    engine.state.robots[id] = { paused: action === "pause", delayed: false };
    engine.options.changed();
  };
  h.characteristic(null, "pause").set(true); await tick();
  h.characteristic("b", "pause").set(false);
  assert.equal(h.characteristic("b", "pause").get(), false);
  assert.equal(h.characteristic("a", "pause").get(), true);
  const mark = h.service("b", "pause").history.length;
  write.resolve(); await h.manager.commandTail;
  assert.deepEqual(h.calls, [["a", "pause"], ["b", "pause"], ["b", "resume"]]);
  assert.equal(h.characteristic("b", "pause").get(), false);
  assert.ok(h.service("b", "pause").history.slice(mark).every((v) => !v));
  assert.equal(h.characteristic(null, "pause").get(), true);
});

test("all-vacuum partial failure rolls back only the failed robot and keeps aggregate any-paused semantics", async (t) => {
  const h = harness(t, { enableSchedulePauseUntilTomorrow: true }); h.sync(); h.fail = "a";
  h.characteristic(null, "pause").set(true);
  assert.equal(h.characteristic("a", "pause").get(), true);
  assert.equal(h.characteristic("b", "pause").get(), true);
  await h.manager.commandTail;
  assert.equal(h.characteristic("a", "pause").get(), false);
  assert.equal(h.characteristic("b", "pause").get(), true);
  assert.equal(h.characteristic(null, "pause").get(), true);
  assert.equal(h.errors.length, 1);
});

test("Delay Active is optimistic but the Delay button remains momentary", async (t) => {
  const h = harness(t, { enableScheduleDelay: true }); h.sync();
  const write = deferred();
  h.execute = async (id, action, engine) => {
    await write.promise; engine.state.robots[id] = { delayed: true, paused: false };
  };
  h.characteristic("a", "delayActive").set(true);
  assert.equal(h.characteristic("a", "delayActive").get(), true);
  assert.equal(h.characteristic(null, "delayActive").get(), true);
  assert.equal(h.characteristic("a", "delay").get(), false);
  write.resolve(); await h.manager.commandTail;
  assert.equal(h.characteristic("a", "delayActive").get(), true);
});

test("Delay Active reflects any delayed robot and OFF cancels both without resuming ordinary pauses", async (t) => {
  const h = harness(t, { enableScheduleDelay: true }); h.sync();
  h.engines[0].state.robots.a = { delayed: true, paused: true };
  assert.equal(h.characteristic(null, "delayActive").get(), true);
  h.characteristic(null, "delayActive").set(false);
  await tick(); await tick();
  assert.deepEqual(h.calls, [["a", "cancelDelay"], ["b", "cancelDelay"]]);
  assert.equal(h.engines[0].status("a").paused, true);
  assert.equal(h.characteristic(null, "delayActive").get(), false);
});

test("momentary OFF sends no command; all-vacuum actions continue after one failure", async (t) => {
  const h = harness(t, { enableScheduleDelay: true }); h.sync(); h.fail = "a";
  h.characteristic(null, "delay").set(false); assert.equal(h.calls.length, 0);
  h.characteristic(null, "delay").set(true);
  await tick(); await tick();
  assert.deepEqual(h.calls, [["a", "delay"], ["b", "delay"]]);
  assert.equal(h.errors.length, 1);
  assert.equal(h.engines[0].status("b").delayed, true);
});

test("stateful ON requests one delay and disabling exposure removes only these controls", async (t) => {
  const h = harness(t, { enableScheduleDelay: true }); h.sync();
  h.characteristic("a", "delayActive").set(true); await tick(); await tick();
  assert.deepEqual(h.calls, [["a", "startDelay"]]);
  const unrelated = new Accessory("Existing schedule", "existing");
  h.accessories.push(unrelated);
  h.platform.platformConfig.enableScheduleDelay = false; h.sync();
  assert.equal(h.removed.length, 6);
  assert.deepEqual(h.accessories, [unrelated]);
});
