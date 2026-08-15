"use strict";

const fs = require("node:fs");
const path = require("node:path");

const REPO = path.join(__dirname, "..");

const read = (...parts) =>
  fs.readFileSync(path.join(REPO, ...parts), "utf8");

const schema = JSON.parse(read("config.schema.json"));
const uiJs = read("homebridge-ui", "public", "index.js");
const uiHtml = read("homebridge-ui", "public", "index.html");
const platformSource = read("src", "platform.ts");
const typesSource = read("src", "types.ts");

describe("HomeKit schedule settings contract", () => {
  test("schedules are a separate config setting, not an action key", () => {
    expect(typesSource).toContain(
      "enableHomeKitScheduleSwitches?: boolean;"
    );

    const items =
      schema.schema.properties.homeKitActionSwitches.items;

    expect(items.enum).toEqual([
      "clean",
      "dock",
      "pause",
      "locate",
    ]);

    expect(
      items.oneOf.some((entry) => entry.enum?.[0] === "schedules")
    ).toBe(false);
  });

  test("the settings page has a dedicated schedule checkbox", () => {
    expect(uiJs).toContain(
      'homeKitActionSchedules: document.getElementById('
    );
    expect(uiJs).toContain('"homekit-action-schedules"');
    expect(uiHtml).toContain(
      'id="homekit-action-schedules"'
    );
  });

  test("the schedule checkbox is loaded from saved config", () => {
    expect(uiJs).toMatch(
      /elements\.homeKitActionSchedules\.checked\s*=\s*Boolean\(\s*config\.enableHomeKitScheduleSwitches\s*\)/
    );
  });

  test("Save Settings persists the schedule checkbox", () => {
    expect(uiJs).toMatch(
      /enableHomeKitScheduleSwitches:\s*Boolean\(\s*elements\.homeKitActionSchedules\?\.checked\s*\)/
    );

    expect(uiJs).toMatch(
      /elements\.saveFeatureSettings\.addEventListener\("click",[\s\S]*?handleSaveClick\(elements\.saveFeatureSettings\)/
    );

    expect(uiJs).toContain(
      'await window.homebridge.updatePluginConfig(configs);'
    );
    expect(uiJs).toContain(
      'await window.homebridge.savePluginConfig();'
    );
  });

  test("schedule changes are not auto-saved by the checkbox itself", () => {
    const scheduleCheckboxSection = uiJs.slice(
      uiJs.indexOf('elements.homeKitActionSchedules'),
      uiJs.indexOf('elements.homeKitActionSchedules') + 2500
    );

    expect(scheduleCheckboxSection).not.toContain(
      'addEventListener("change", () => autoSave())'
    );
  });

  test("runtime schedule exposure requires both the master and schedule setting", () => {
    expect(platformSource).toMatch(
      /private shouldExposeHapSchedules\(\): boolean \{\s*return \(\s*this\.platformConfig\.enableHomeKitActionSwitches === true &&\s*this\.platformConfig\.enableHomeKitScheduleSwitches === true\s*\);\s*\}/
    );
  });

  test("runtime schedule removal is tied to the same gate", () => {
    const start = platformSource.indexOf(
      "private syncHapSchedules(devices: any[]): void"
    );

    expect(start).toBeGreaterThan(-1);

    const body = platformSource.slice(start, start + 7000);

    expect(body).toContain(
      "if (!exposeSchedules)"
    );

    expect(body).toContain(
      "isHapScheduleAccessory(accessory)"
    );

    expect(body).toContain(
      "this.api.unregisterPlatformAccessories"
    );
  });
});
