"use strict";

/**
 * #24, the mechanism. Marrand (S8, ONE Roborock map, 8 rooms, Apple Home):
 * "I can add rooms one by one and the selection sticks. When I select all 8,
 * it falls back to Entrance + Hallway, the two rooms I cleaned this morning,
 * and from then on I can never select all 8 again." His log: `→ none`.
 *
 * Two facts, both read from the source Homebridge 2.4.0 actually runs:
 *
 *  - Homebridge's ServiceArea behaviour (dist/matter/behaviors/
 *    ServiceAreaBehavior.js) awaits the plugin's handler, THROWS AWAY its
 *    return value, and then runs matter.js 0.17.9's own
 *    ServiceAreaServer.selectAreas, whose answer goes to the controller. Only
 *    a throw stops matter.js from storing the selection.
 *  - Apple Home sends an EMPTY list for "all rooms" (Matter 1.4 §1.17.7.1.1:
 *    empty means no area restriction). matter.js stores [] and, for an empty
 *    list, leaves progress alone.
 *
 * The plugin's progress is persisted. So the morning's finished Entrance +
 * Hallway were still published as progress, and with nothing selected Apple
 * Home showed those two rooms — every time "all" was picked.
 *
 * The harness below is the real accessory, the repo's faithful 0.17.9 store,
 * and Homebridge's selectAreas order of events.
 */

const { createMatterStore } = require("../test-support/matter-0.17.9-store");
const RoborockMatterVacuumAccessory =
  require("../src/matter_vacuum_accessory").default;

const ONE_MAP = [
  { segmentId: 16, mapId: 0, name: "Salon" },
  { segmentId: 17, mapId: 0, name: "Kitchen" },
  { segmentId: 18, mapId: 0, name: "Bedroom 1" },
  { segmentId: 20, mapId: 0, name: "Bedroom 2" },
  { segmentId: 21, mapId: 0, name: "Dining Room" },
  { segmentId: 22, mapId: 0, name: "Bathroom" },
  { segmentId: 24, mapId: 0, name: "Hallway" },
  { segmentId: 25, mapId: 0, name: "Entrance" },
];

/** The morning's two-room clean, finished and persisted. */
const MORNING = {
  serviceAreaProgressState: {
    currentArea: null,
    progress: [
      { areaId: 25, status: 3 },
      { areaId: 24, status: 3 },
    ],
  },
};

class ConstraintError extends Error {}

const vacuums = [];
afterEach(() => {
  for (const vacuum of vacuums.splice(0)) {
    vacuum.dispose();
  }
});

function harness({
  rooms = ONE_MAP,
  maps = [{ mapId: 0, name: "Home" }],
  context = {},
} = {}) {
  let store;
  const status = { state: 8, battery: 100, charge_status: 1, error_code: 0 };
  const api = {
    getVacuumDeviceInfo: (duid, property) => (property === "name" ? "S8" : ""),
    getProductAttribute: () => "roborock.vacuum.a51",
    getVacuumDeviceStatus: (duid, property) => status[property] ?? "",
    getRoomMappingsForDevice: () => rooms.map((room) => ({ ...room })),
    getMapListForDevice: () => maps.map((map) => ({ ...map })),
    getCurrentMapIdForDevice: () => 0,
    getMatterCleanModeCapabilities: () => ({ canVacuum: true, canMop: true }),
    getStatus: jest.fn().mockResolvedValue(undefined),
    app_start: jest.fn().mockResolvedValue(undefined),
    app_segment_clean_by_ids: jest.fn().mockResolvedValue(undefined),
  };
  const log = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
  const platform = {
    log,
    platformConfig: { enableMatter: true },
    getMatterApi: () => ({
      updateAccessoryState: (...args) => store.updateAccessoryState(...args),
      status: { ConstraintError },
    }),
    shouldAcceptUnscopedLiveMessage: () => true,
    roborockAPI: api,
  };
  const accessory = {
    UUID: "uuid-sa",
    context: { duid: "device-sa", ...structuredClone(context) },
  };
  const vacuum = new RoborockMatterVacuumAccessory(
    platform,
    accessory,
    { duid: "device-sa" },
    true
  );
  vacuums.push(vacuum);
  store = createMatterStore(accessory.clusters);

  /** Homebridge 2.4.0 selectAreas, then matter.js 0.17.9 selectAreas. */
  async function selectAreas(newAreas) {
    try {
      await accessory.handlers.serviceArea.selectAreas({ newAreas });
    } catch (error) {
      return { thrown: error };
    }
    const serviceArea = store.clusters.serviceArea;
    const validated = [];
    for (const areaId of newAreas) {
      if (!serviceArea.supportedAreas.some((area) => area.areaId === areaId)) {
        return { status: "UnsupportedArea" };
      }
      if (!validated.includes(areaId)) validated.push(areaId);
    }
    const write = { selectedAreas: validated };
    if (serviceArea.progress !== undefined && validated.length > 0) {
      write.progress = validated.map((areaId) => ({ areaId, status: 0 }));
    }
    await store.updateAccessoryState("uuid-sa", "serviceArea", write);
    // The plugin's own deferred publish (setTimeout 0).
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { status: "Success" };
  }

  const shown = () => ({
    selectedAreas: store.clusters.serviceArea.selectedAreas,
    progress: store.clusters.serviceArea.progress.map((entry) => entry.areaId),
  });

  return { vacuum, accessory, store, api, log, status, selectAreas, shown };
}

describe("#24: picking every room", () => {
  test("is no longer shown as the rooms of the last run", async () => {
    const { vacuum, selectAreas, shown } = harness({ context: MORNING });
    await vacuum.updateMatterStateFromRoborock();
    expect(shown().progress).toEqual([25, 24]);

    await selectAreas([18, 25, 24]);
    await selectAreas([25, 18, 20, 24]);
    expect(shown().selectedAreas).toEqual([25, 18, 20, 24]);

    await selectAreas([]);
    expect(shown()).toEqual({ selectedAreas: [], progress: [] });
  });

  test("stays cleared across a restart", async () => {
    const first = harness({ context: MORNING });
    await first.vacuum.updateMatterStateFromRoborock();
    await first.selectAreas([]);

    const second = harness({ context: first.accessory.context });
    await second.vacuum.updateMatterStateFromRoborock();
    expect(second.shown().progress).toEqual([]);
  });

  test("and then Start cleans every room", async () => {
    const { vacuum, accessory, api, selectAreas } = harness({
      context: MORNING,
    });
    await vacuum.updateMatterStateFromRoborock();
    await selectAreas([]);

    await accessory.handlers.rvcRunMode.changeToMode({ newMode: 1 });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(api.app_start).toHaveBeenCalledTimes(1);
    expect(api.app_segment_clean_by_ids).not.toHaveBeenCalled();
  });

  test("a selection made during a run leaves that run's progress alone", async () => {
    const { vacuum, status, selectAreas, shown } = harness();
    await vacuum.updateMatterStateFromRoborock();
    await selectAreas([24, 25]);
    await vacuum.accessory.handlers.rvcRunMode.changeToMode({ newMode: 1 });
    status.state = 18; // segment clean
    await vacuum.updateMatterStateFromRoborock();
    const during = shown().progress;
    expect(during).toEqual([24, 25]);

    await selectAreas([16]);

    expect(shown().selectedAreas).toEqual([16]);
    expect(shown().progress).toEqual(during);
  });
});

describe("a refusal reaches the controller and nothing drifts", () => {
  const TWO_MAPS = [
    { segmentId: 16, mapId: 0, name: "Kitchen" },
    { segmentId: 17, mapId: 1, name: "Attic" },
  ];
  const ATTIC = 1_000_017;

  test("a set spanning two maps is thrown as ConstraintError, and matter.js stores nothing", async () => {
    const { vacuum, store, selectAreas } = harness({
      rooms: TWO_MAPS,
      maps: [
        { mapId: 0, name: "Ground" },
        { mapId: 1, name: "Upstairs" },
      ],
    });
    await vacuum.updateMatterStateFromRoborock();
    await selectAreas([16]);

    const outcome = await selectAreas([16, ATTIC]);

    expect(outcome.thrown).toBeInstanceOf(ConstraintError);
    expect(store.clusters.serviceArea.selectedAreas).toEqual([16]);
    // The heartbeat's forced write publishes the same selection matter.js
    // holds, so nothing snaps back later either.
    await vacuum.publishCurrentMatterState("Matter state heartbeat");
    expect(store.clusters.serviceArea.selectedAreas).toEqual([16]);
  });

  test("an area that is not on the room map is thrown too", async () => {
    const { vacuum, store, selectAreas } = harness();
    await vacuum.updateMatterStateFromRoborock();
    await selectAreas([16]);

    const outcome = await selectAreas([16, 99]);

    expect(outcome.thrown).toBeInstanceOf(ConstraintError);
    expect(store.clusters.serviceArea.selectedAreas).toEqual([16]);
  });

  test("without api.matter.status the refusal is still a throw", async () => {
    const { vacuum, selectAreas, accessory } = harness({
      rooms: TWO_MAPS,
      maps: [
        { mapId: 0, name: "Ground" },
        { mapId: 1, name: "Upstairs" },
      ],
    });
    await vacuum.updateMatterStateFromRoborock();
    vacuum.platform.getMatterApi = () => ({
      updateAccessoryState: async () => {},
    });

    await expect(
      accessory.handlers.serviceArea.selectAreas({ newAreas: [16, ATTIC] })
    ).rejects.toThrow(/only one Roborock map/);
    await expect(selectAreas([16])).resolves.toEqual({ status: "Success" });
  });
});

describe("the request line counts what it dropped, by cause", () => {
  test("a repeated id is called repeated, not unreadable", async () => {
    const { vacuum, log, selectAreas } = harness();
    await vacuum.updateMatterStateFromRoborock();

    await selectAreas([16, 17, 16]);

    const line = log.info.mock.calls
      .map(([text]) => text)
      .find((text) => /service area selection request/.test(text));
    expect(line).toMatch(/: 16, 17 /);
    expect(line).toMatch(/sent 3 entries, 1 repeated/);
    expect(line).not.toMatch(/could not be read/);
  });

  test("an empty list says what Matter means by it", async () => {
    const { vacuum, log, selectAreas } = harness();
    await vacuum.updateMatterStateFromRoborock();

    await selectAreas([]);

    const lines = log.info.mock.calls.map(([text]) => text);
    expect(
      lines.find((text) => /service area selection request/.test(text))
    ).toMatch(/empty list, which Matter defines as no area restriction/);
    expect(lines).toContainEqual(
      expect.stringMatching(/Start cleans every room/)
    );
  });
});
