"use strict";

jest.mock("../src/hap_schedule_api.ts", () => ({
  getServerTimers: jest.fn(),
  updateServerTimer: jest.fn(),
  updateTimer: jest.fn(),
}));

const { getServerTimers } = require("../src/hap_schedule_api.ts");
const RoborockHapScheduleAccessory =
  require("../src/hap_schedule_accessory.ts").default;

function makeCoordinator() {
  const coordinator = Object.create(RoborockHapScheduleAccessory.prototype);

  coordinator.platform = {
    roborockAPI: {},
    log: {
      info: jest.fn(),
      debug: jest.fn(),
      warn: jest.fn(),
    },
  };

  coordinator.duid = "device-1";
  coordinator.scheduleAccessories = new Map();
  coordinator.managerAccessory = {};
  coordinator.vacuumName = "Test Vacuum";
  coordinator.managerRemoved = false;
  coordinator.cachedSchedules = undefined;
  coordinator.lastScheduleRefreshAt = 0;
  coordinator.lastFailedRefreshAt = 0;
  coordinator.refreshInProgress = undefined;
  coordinator.sync = jest.fn();

  return coordinator;
}

describe("HAP schedule coordinator cache", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("fresh cache does not make another cloud request", async () => {
    const coordinator = makeCoordinator();

    coordinator.cachedSchedules = [
      {
        id: "timer-1",
        enabled: true,
        timer: ["timer-1", "on"],
      },
    ];
    coordinator.lastScheduleRefreshAt = Date.now();

    await expect(coordinator.refreshIfNeeded()).resolves.toBe(true);

    expect(getServerTimers).not.toHaveBeenCalled();
    expect(coordinator.sync).not.toHaveBeenCalled();
  });

  test("stale cache makes one cloud request and updates the snapshot", async () => {
    const coordinator = makeCoordinator();

    coordinator.cachedSchedules = [
      {
        id: "timer-1",
        enabled: true,
        timer: ["timer-1", "on"],
      },
    ];
    coordinator.lastScheduleRefreshAt = Date.now() - 61000;

    getServerTimers.mockResolvedValue([
      ["timer-1", "off"],
      ["timer-2", "on"],
    ]);

    await expect(coordinator.refreshIfNeeded()).resolves.toBe(true);

    expect(getServerTimers).toHaveBeenCalledTimes(1);
    expect(getServerTimers).toHaveBeenCalledWith(
      coordinator.platform.roborockAPI,
      "device-1",
      {
        requestTimeoutMs: 10000,
      }
    );
    expect(coordinator.sync).toHaveBeenCalledTimes(1);
    expect(coordinator.sync).toHaveBeenCalledWith([
      {
        id: "timer-1",
        enabled: false,
        timer: ["timer-1", "off"],
      },
      {
        id: "timer-2",
        enabled: true,
        timer: ["timer-2", "on"],
      },
    ]);
  });

  test("concurrent refreshes share one in-flight cloud request", async () => {
    const coordinator = makeCoordinator();

    coordinator.cachedSchedules = [
      {
        id: "timer-1",
        enabled: true,
        timer: ["timer-1", "on"],
      },
    ];
    coordinator.lastScheduleRefreshAt = Date.now() - 61000;

    let resolveRequest;
    getServerTimers.mockReturnValue(
      new Promise((resolve) => {
        resolveRequest = resolve;
      })
    );

    const first = coordinator.refreshIfNeeded();
    const second = coordinator.refresh();
    const third = coordinator.refreshIfNeeded();

    expect(getServerTimers).toHaveBeenCalledTimes(1);

    resolveRequest([["timer-1", "off"]]);

    await expect(Promise.all([first, second, third])).resolves.toEqual([
      true,
      true,
      true,
    ]);

    expect(getServerTimers).toHaveBeenCalledTimes(1);
    expect(coordinator.sync).toHaveBeenCalledTimes(1);
  });

  test("failed refresh preserves existing schedule accessories", async () => {
    const coordinator = makeCoordinator();

    const existingSchedule = {
      id: "timer-existing",
      enabled: true,
      timer: ["timer-existing", "on"],
    };

    const existingChild = {
      updateIdentity: jest.fn(),
      dispose: jest.fn(),
    };

    coordinator.scheduleAccessories.set(existingSchedule.id, existingChild);

    getServerTimers.mockRejectedValue(new Error("cloud timeout"));

    await expect(coordinator.refresh()).resolves.toBe(true);

    expect(getServerTimers).toHaveBeenCalledTimes(1);
    expect(coordinator.sync).not.toHaveBeenCalled();
    expect(coordinator.scheduleAccessories.has("timer-existing")).toBe(true);
    expect(coordinator.scheduleAccessories.get("timer-existing")).toBe(
      existingChild
    );
  });

  test("failed refresh backoff suppresses repeated cloud requests and later retries", async () => {
    const coordinator = makeCoordinator();

    coordinator.cachedSchedules = [
      {
        id: "timer-existing",
        enabled: true,
        timer: ["timer-existing", "on"],
      },
    ];
    coordinator.lastScheduleRefreshAt = Date.now() - 61000;

    getServerTimers.mockRejectedValueOnce(new Error("cloud timeout"));

    await expect(coordinator.refreshIfNeeded()).resolves.toBe(false);
    expect(getServerTimers).toHaveBeenCalledTimes(1);
    expect(coordinator.lastFailedRefreshAt).toBeGreaterThan(0);

    // The failed refresh should suppress another cloud request during backoff,
    // while preserving the existing cached schedule state.
    await expect(coordinator.refreshIfNeeded()).resolves.toBe(true);
    expect(getServerTimers).toHaveBeenCalledTimes(1);

    // Simulate the 30-second backoff having expired.
    coordinator.lastFailedRefreshAt = Date.now() - 31000;

    getServerTimers.mockResolvedValueOnce([["timer-existing", "off"]]);

    await expect(coordinator.refreshIfNeeded()).resolves.toBe(true);
    expect(getServerTimers).toHaveBeenCalledTimes(2);

    expect(coordinator.cachedSchedules).toEqual([
      {
        id: "timer-existing",
        enabled: false,
        timer: ["timer-existing", "off"],
      },
    ]);
  });

  test("successful empty snapshot is cached as empty", async () => {
    const coordinator = makeCoordinator();

    getServerTimers.mockResolvedValue([]);

    await expect(coordinator.refresh()).resolves.toBe(false);
    expect(getServerTimers).toHaveBeenCalledTimes(1);
    expect(coordinator.cachedSchedules).toEqual([]);
    expect(coordinator.sync).toHaveBeenCalledWith([]);

    await expect(coordinator.refreshIfNeeded()).resolves.toBe(false);

    expect(getServerTimers).toHaveBeenCalledTimes(1);
  });
});
