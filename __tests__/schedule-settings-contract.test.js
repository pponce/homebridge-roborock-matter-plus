"use strict";

const fs = require("node:fs");
const path = require("node:path");

const REPO = path.join(__dirname, "..");

const read = (...parts) => fs.readFileSync(path.join(REPO, ...parts), "utf8");

const schema = JSON.parse(read("config.schema.json"));
const uiJs = read("homebridge-ui", "public", "index.js");
const uiHtml = read("homebridge-ui", "public", "index.html");
const platformSource = read("src", "platform.ts");
const typesSource = read("src", "types.ts");
const scheduleSource = read("src", "hap_schedule_accessory.ts");

describe("HomeKit schedule settings contract", () => {
  test("schedules are a separate config setting, not an action key", () => {
    expect(typesSource).toContain("enableHomeKitScheduleSwitches?: boolean;");

    const items = schema.schema.properties.homeKitActionSwitches.items;

    expect(items.enum).toEqual(["clean", "dock", "pause", "locate"]);

    expect(items.oneOf.some((entry) => entry.enum?.[0] === "schedules")).toBe(
      false
    );
  });

  test("the settings page has a dedicated schedule checkbox", () => {
    expect(uiJs).toContain("homeKitActionSchedules: document.getElementById(");
    expect(uiJs).toContain('"homekit-action-schedules"');
    expect(uiHtml).toContain('id="homekit-action-schedules"');
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
      "await window.homebridge.updatePluginConfig(configs);"
    );
    expect(uiJs).toContain("await window.homebridge.savePluginConfig();");
  });

  test("schedule changes are not auto-saved by the checkbox itself", () => {
    const scheduleCheckboxSection = uiJs.slice(
      uiJs.indexOf("elements.homeKitActionSchedules"),
      uiJs.indexOf("elements.homeKitActionSchedules") + 2500
    );

    expect(scheduleCheckboxSection).not.toContain(
      'addEventListener("change", () => autoSave())'
    );
  });

  test("runtime schedule exposure requires both the master and schedule settings", () => {
    expect(platformSource).toMatch(
      /private shouldExposeHapSchedules\(\): boolean \{[\s\S]*?enableHomeKitActionSwitches === true[\s\S]*?enableHomeKitScheduleSwitches === true[\s\S]*?\}/
    );
  });

  test("master-off schedule removal unregisters all schedule accessories", () => {
    expect(platformSource).toMatch(
      /private removeHapScheduleAccessories\(\): void \{[\s\S]*?hapScheduleAccessories\.clear\(\)[\s\S]*?unregisterPlatformAccessories/
    );

    expect(platformSource).toMatch(
      /if \(!this\.platformConfig\.enableHomeKitActionSwitches\) \{[\s\S]*?removeHapScheduleAccessories\(\)[\s\S]*?return;/
    );
  });

  test("schedule-only disable preserves the cached coordinator", () => {
    const disabledBlock = platformSource.match(
      /if \(!exposeSchedules\) \{([\s\S]*?)\n\s*return;/
    );

    expect(disabledBlock).not.toBeNull();
    expect(disabledBlock[1]).toContain("schedule.dispose()");
    expect(disabledBlock[1]).not.toContain("hapScheduleAccessories.clear()");
  });

  test("schedule initialization refreshes through the cached coordinator", () => {
    expect(scheduleSource).toContain("async initialize(");
    expect(scheduleSource).toContain(
      "): Promise<RoborockScheduleRefreshResult>"
    );

    expect(scheduleSource).toMatch(
      /Initial discovery always performs one cloud schedule request\.[\s\S]*?return this\.refreshDetailed\(\);/
    );

    expect(scheduleSource).toMatch(
      /async refreshIfNeeded\(\): Promise<boolean>/
    );

    expect(scheduleSource).toContain("return this.cachedSchedules.length > 0;");

    expect(scheduleSource).not.toContain("startPolling");
    expect(scheduleSource).not.toContain("stopPolling");
  });

  test("schedule refresh uses a 60-second cache and no permanent polling", () => {
    expect(scheduleSource).toMatch(/const SCHEDULE_CACHE_TTL_MS = 60 \* 1000;/);

    expect(scheduleSource).toMatch(
      /private cachedSchedules: RoborockSchedule\[\] \| undefined;/
    );

    expect(scheduleSource).toMatch(/private lastScheduleRefreshAt = 0;/);

    expect(scheduleSource).toMatch(
      /private refreshInProgress: Promise<RoborockScheduleRefreshResult> \| undefined;/
    );

    expect(scheduleSource).toMatch(
      /async refreshIfNeeded\(\): Promise<boolean>/
    );

    expect(scheduleSource).toMatch(
      /this\.refreshInProgress = this\.performRefresh\(\);/
    );

    expect(scheduleSource).toMatch(
      /const raw = await getServerTimers\(api, this\.duid, \{/
    );

    expect(scheduleSource).not.toContain("SCHEDULE_POLL_INTERVAL_MS");
    expect(scheduleSource).not.toContain("setInterval(");
    expect(scheduleSource).not.toContain("startPolling");
    expect(scheduleSource).not.toContain("stopPolling");
  });

  test("restored schedule groups are removed when initial refresh fails", () => {
    expect(platformSource).toMatch(
      /if \(schedule\) \{[\s\S]*?\.initialize\(target\.vacuumName\)[\s\S]*?if \(result\.success && result\.hasSchedules\) \{[\s\S]*?return;[\s\S]*?this\.removeHapScheduleAccessory\(duid, accessory\);/
    );
  });

  test("first-time schedule creation requires a successful non-empty snapshot", () => {
    expect(platformSource).toMatch(
      /\.initialize\(target\.vacuumName\)[\s\S]*?if \(!result\.success\) \{[\s\S]*?this\.hapScheduleAccessories\.delete\(duid\);[\s\S]*?if \(!result\.hasSchedules\) \{/
    );
  });

  test("failed restored schedule discovery unregisters the cached accessory", () => {
    expect(platformSource).toMatch(
      /if \(schedule\) \{[\s\S]*?if \(result\.success && result\.hasSchedules\) \{[\s\S]*?this\.removeHapScheduleAccessory\(duid, accessory\);/
    );

    expect(platformSource).toMatch(
      /private removeHapScheduleAccessory\([\s\S]*?unregisterPlatformAccessories/
    );
  });

  test("schedule switch GET returns cached state without waiting for refresh", () => {
    expect(scheduleSource).toMatch(
      /\.onGet\(\(\) => \{[\s\S]*?void this\.coordinator\.refreshIfNeeded\(\);[\s\S]*?return this\.schedule\.enabled;/
    );
    expect(scheduleSource).not.toMatch(
      /\.onGet\(async \(\) => \{[\s\S]*?await this\.coordinator\.refreshIfNeeded\(\);/
    );
  });

  test("verified schedule writes update the coordinator snapshot", () => {
    expect(scheduleSource).toMatch(
      /this\.coordinator\.recordScheduleUpdate\(current\);/
    );
  });

  test("schedule dispose removes dynamic services but preserves manager", () => {
    expect(scheduleSource).toMatch(
      /dispose\(\): void \{[\s\S]*?removeService\(service\)[\s\S]*?updatePlatformAccessories/
    );

    const disposeBlock = scheduleSource.match(
      /dispose\(\): void \{([\s\S]*?)\n\s*\}/
    );

    expect(disposeBlock).not.toBeNull();
    expect(disposeBlock[1]).not.toContain("unregisterPlatformAccessories");
  });
});
