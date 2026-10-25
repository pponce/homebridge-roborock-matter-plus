"use strict";

/**
 * #24: "I can add rooms one by one and the selection sticks. When I select ALL
 * eight, it falls back to the two rooms I cleaned this morning, and from then
 * on I can never select all eight again."
 *
 * The log he could send had one line for it:
 *
 *     Matter service area selection request for S8: none.
 *
 * Which of these it was, the line does not say:
 *
 *  - the controller really did send an empty list (Apple Home treats "all
 *    areas" as "no area restriction" on some builds),
 *  - the controller sent eight ids and `normalizeMatterAreaIds` read none of
 *    them,
 *  - the set spanned two Roborock maps and was refused — the refusal IS the
 *    fall-back he describes, because a controller that gets InvalidSet keeps
 *    its previous selection.
 *
 * Three different causes, one indistinguishable line, and a week between runs
 * to spend on each guess. These pin that the line names what arrived as well
 * as what was understood, and that the multi-map refusal says which maps and
 * warns that the controller will revert.
 */

const RoborockMatterVacuumAccessory =
  require("../src/matter_vacuum_accessory").default;

function createAccessory({ rooms, maps = [] }) {
  const log = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
  const platform = {
    platformConfig: { enableMatter: true },
    log,
    getMatterApi: () => null,
    roborockAPI: {
      getVacuumDeviceInfo: (duid, property) =>
        property === "name" ? "S8" : "",
      getProductAttribute: () => "roborock.vacuum.a08",
      getVacuumDeviceStatus: () => "",
      getRoomMappingsForDevice: () => rooms.map((room) => ({ ...room })),
      getMapListForDevice: () => maps.map((map) => ({ ...map })),
      getMatterCleanModeCapabilities: () => ({
        canVacuum: true,
        canMop: false,
      }),
    },
  };
  const accessory = { UUID: "uuid-1", context: { duid: "device-1" } };
  const vacuum = new RoborockMatterVacuumAccessory(platform, accessory, {
    duid: "device-1",
  });
  return { accessory, log, vacuum };
}

/** Marrand's eight rooms, all on one map. */
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

function lines(mock) {
  return mock.mock.calls.map(([line]) => line);
}

describe("the selection request line names what arrived", () => {
  test("a selection that is understood in full reads exactly as before", async () => {
    const { accessory, log } = createAccessory({ rooms: ONE_MAP });
    await accessory.handlers.serviceArea.selectAreas({
      newAreas: [25, 18, 20, 24],
    });

    const request = lines(log.info).find((line) =>
      /service area selection request/.test(line)
    );
    expect(request).toMatch(/: 25, 18, 20, 24\.$/);
    expect(request).not.toMatch(/could not be read/);
  });

  test("an empty list from the controller says the controller sent an empty list", async () => {
    const { accessory, log } = createAccessory({ rooms: ONE_MAP });
    await accessory.handlers.serviceArea.selectAreas({ newAreas: [] });

    const request = lines(log.info).find((line) =>
      /service area selection request/.test(line)
    );
    expect(request).toMatch(/none/);
    expect(request).toMatch(/sent an empty list/);
  });

  test("entries that cannot be read as area ids are counted, not silently dropped", async () => {
    const { accessory, log } = createAccessory({ rooms: ONE_MAP });
    await accessory.handlers.serviceArea.selectAreas({
      newAreas: [16, null, "not-a-number", {}, 17],
    });

    const request = lines(log.info).find((line) =>
      /service area selection request/.test(line)
    );
    expect(request).toMatch(/: 16, 17 /);
    expect(request).toMatch(/sent 5 entries/);
    expect(request).toMatch(/3 of which could not be read as an area id/);
  });

  test("no area list at all is told apart from an empty one", async () => {
    const { accessory, log } = createAccessory({ rooms: ONE_MAP });
    await accessory.handlers.serviceArea.selectAreas({});

    const request = lines(log.info).find((line) =>
      /service area selection request/.test(line)
    );
    expect(request).toMatch(/no area list/);
  });
});

describe("a selection spanning two maps says so, and warns about the revert", () => {
  const TWO_MAPS = [
    { segmentId: 16, mapId: 0, name: "Salon" },
    { segmentId: 17, mapId: 0, name: "Kitchen" },
    { segmentId: 30, mapId: 1, name: "Attic" },
  ];
  // Area ids carry the map: mapId * 1_000_000 + segmentId.
  const ATTIC = 1_000_030;

  test("the refusal names the maps, the areas, and the fall-back", async () => {
    const { accessory, log } = createAccessory({
      rooms: TWO_MAPS,
      maps: [
        { mapId: 0, name: "Ground Floor" },
        { mapId: 1, name: "Upstairs" },
      ],
    });

    await expect(
      accessory.handlers.serviceArea.selectAreas({
        newAreas: [16, 17, ATTIC],
      })
    ).rejects.toThrow();
    const refusal = lines(log.warn).find((line) => /spanning/.test(line));
    expect(refusal).toMatch(/2 Roborock maps/);
    expect(refusal).toMatch(new RegExp(`16, 17, ${ATTIC}`));
    // The sentence #24 needed: the symptom is the controller reverting, not
    // the plugin clearing the selection.
    expect(refusal).toMatch(/controller will keep.*previous selection|revert/i);
  });

  test("the selection already held is left alone when the new one is refused", async () => {
    const { accessory, vacuum } = createAccessory({
      rooms: TWO_MAPS,
      maps: [{ mapId: 0, name: "Ground Floor" }],
    });

    await accessory.handlers.serviceArea.selectAreas({ newAreas: [16] });
    await expect(
      accessory.handlers.serviceArea.selectAreas({
        newAreas: [16, ATTIC],
      })
    ).rejects.toThrow();

    expect(vacuum.buildServiceAreaCluster().selectedAreas).toEqual([16]);
  });
});
