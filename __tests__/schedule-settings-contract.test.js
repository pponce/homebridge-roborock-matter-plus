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

  test("runtime schedule exposure is controlled independently by the schedule setting", () => {
    expect(platformSource).toMatch(
      /private shouldExposeHapSchedules\(\): boolean \{\s*return this\.platformConfig\.enableHomeKitScheduleSwitches === true;\s*\}/
    );
  });

  test("runtime schedule removal is tied to the same gate", () => {
    expect(platformSource).toMatch(
      /if \(!exposeSchedules\) \{[\s\S]*?schedule\.dispose\(\)[\s\S]*?return;/
    );
  });

  test("disabled schedules preserve the cached manager accessory", () => {
    const disabledBlock = platformSource.match(
      /if \(!exposeSchedules\) \{([\s\S]*?)\n\s*return;/
    );

    expect(disabledBlock).not.toBeNull();
    expect(disabledBlock[1]).toContain("schedule.dispose()");
    expect(disabledBlock[1]).not.toContain(
      "hapScheduleAccessories.clear()"
    );
    expect(disabledBlock[1]).not.toContain(
      "unregisterPlatformAccessories"
    );
  });

  test("schedule initialization rebuilds dynamic switch services", () => {
    const fs = require("fs");
    const path = require("path");

    const scheduleSource = fs.readFileSync(
      path.join(__dirname, "..", "src", "hap_schedule_accessory.ts"),
      "utf8"
    );

    expect(scheduleSource).toMatch(
      /async initialize\(vacuumName: string\): Promise<void> \{[\s\S]*?removeService\(service\)/
    );
  });

  test("schedule dispose removes dynamic services but preserves manager", () => {
    const fs = require("fs");
    const path = require("path");

    const scheduleSource = fs.readFileSync(
      path.join(__dirname, "..", "src", "hap_schedule_accessory.ts"),
      "utf8"
    );

    expect(scheduleSource).toMatch(
      /dispose\(\): void \{[\s\S]*?removeService\(service\)[\s\S]*?updatePlatformAccessories/
    );

    const disposeBlock = scheduleSource.match(
      /dispose\(\): void \{([\s\S]*?)\n\s*\}/
    );

    expect(disposeBlock).not.toBeNull();
    expect(disposeBlock[1]).not.toContain(
      "unregisterPlatformAccessories"
    );
  });
});
