"use strict";

/**
 * A schedule switch whose write the Roborock cloud refuses must stay where it
 * was — measured against HAP itself, not a fake.
 *
 * HAP stores the requested value once an onSet handler RESOLVES, over any
 * value the handler wrote while it ran. Until 3.39.0 a failed write restored
 * the previous state and then resolved, so HAP put the refused state straight
 * back: the switch showed "off" for a schedule that was still on, every other
 * controller was told it had changed, and the next refresh flipped it back
 * without a word. Only a thrown HapStatusError keeps the previous value.
 *
 * Real hap-nodejs Service and Characteristic (the version Homebridge's dev
 * dependency installs; the onSet contract is the same in 2.2.2), the real
 * schedule coordinator, and a cloud that refuses the write.
 */

const path = require("path");
// Homebridge's own hap-nodejs, wherever npm placed it.
const hap = require(
  require.resolve("hap-nodejs", {
    paths: [path.dirname(require.resolve("homebridge/package.json"))],
  })
);
const RoborockHapScheduleAccessory =
  require("../src/hap_schedule_accessory.ts").default;

const DUID = "duid-a144";

class Accessory {
  constructor(displayName) {
    this.displayName = displayName;
    this.context = {};
    this.services = [];
    this.UUID = `uuid:${displayName}`;
  }
  getService(serviceType) {
    return this.services.find((s) => s.UUID === serviceType.UUID);
  }
  getServiceById(serviceType, subtype) {
    return this.services.find(
      (s) => s.UUID === serviceType.UUID && s.subtype === subtype
    );
  }
  addService(serviceType, displayName, subtype) {
    const service = new serviceType(displayName, subtype);
    this.services.push(service);
    return service;
  }
  removeService(service) {
    this.services = this.services.filter((s) => s !== service);
  }
}

function sceneParam(enabled) {
  return JSON.stringify({
    triggers: [
      {
        id: 7033921,
        name: "TIMER",
        type: "TIMER",
        entityId: "",
        param: `{"cron": "0 9 * * 3", "type": "NORMAL", "enabled": ${enabled}, "repeated": true, "timeZoneId": "Europe/Berlin"}`,
      },
    ],
    action: {
      type: "S",
      items: [
        {
          id: 1,
          type: "CMD",
          name: "Kitchen",
          entityId: DUID,
          param:
            '{"id":1,"method":"do_scenes_segments","params":{"data":[{"tid":"1","segs":[{"sid":2}]}],"source":101}}',
          finishDpIds: [130],
        },
      ],
    },
  });
}

function setup({ refuse }) {
  const scenes = [
    {
      id: 1,
      name: "Mornings",
      param: sceneParam(true),
      enabled: true,
      extra: null,
      type: "WORKFLOW",
    },
  ];
  const roborockAPI = {
    getServerTimers: jest.fn(async () => {
      throw new Error("Not FCC robot (code -10007)");
    }),
    getCloudScenes: jest.fn(async () => scenes.map((s) => ({ ...s }))),
    updateCloudSceneParam: jest.fn(async (sceneId, param) => {
      if (refuse) {
        throw new Error("The Roborock cloud refused the change (HTTP 500).");
      }
      scenes[0].param = JSON.stringify(param);
    }),
    setCloudSceneEnabled: jest.fn(async (sceneId, enabled) => {
      scenes[0].enabled = enabled;
    }),
    vacuums: { [DUID]: { command: jest.fn(async () => "ok") } },
  };
  const platform = {
    Service: hap.Service,
    Characteristic: hap.Characteristic,
    roborockAPI,
    api: { hap, updatePlatformAccessories: jest.fn() },
    log: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
  };
  const manager = new Accessory("Rocky Schedules");
  const coordinator = new RoborockHapScheduleAccessory(platform, manager, DUID);
  return { coordinator, manager, platform };
}

function onOf(manager) {
  return manager
    .getServiceById(hap.Service.Switch, "roborock-schedule-scene%3A1")
    .getCharacteristic(hap.Characteristic.On);
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test("a refused write leaves HAP's value on the state Roborock still has", async () => {
  const { coordinator, manager, platform } = setup({ refuse: true });
  await coordinator.initialize("Rocky");
  const on = onOf(manager);
  expect(on.value).toBe(true);
  const changes = [];
  on.on("change", (change) => changes.push(change.newValue));

  const request = on.handleSetRequest(false).then(
    () => "resolved",
    (status) => status
  );
  await jest.advanceTimersByTimeAsync(5000);

  expect(await request).toBe(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  expect(on.value).toBe(true);
  // No controller was ever told the schedule went off.
  expect(changes).not.toContain(false);
  expect(platform.log.warn).toHaveBeenCalledWith(
    expect.stringMatching(/Unable to disable Roborock schedule/)
  );
});

test("a write that succeeds still reads as the new state", async () => {
  const { coordinator, manager } = setup({ refuse: false });
  await coordinator.initialize("Rocky");
  const on = onOf(manager);

  const request = on.handleSetRequest(false).then(
    () => "resolved",
    (status) => status
  );
  await jest.advanceTimersByTimeAsync(5000);

  expect(await request).toBe("resolved");
  expect(on.value).toBe(false);
});

test("a retry of the refused state inside the cooldown is refused the same way", async () => {
  const { coordinator, manager } = setup({ refuse: true });
  await coordinator.initialize("Rocky");
  const on = onOf(manager);

  const first = on.handleSetRequest(false).catch((status) => status);
  await jest.advanceTimersByTimeAsync(5000);
  await first;

  const retry = on.handleSetRequest(false).then(
    () => "resolved",
    (status) => status
  );
  await jest.advanceTimersByTimeAsync(10);

  expect(await retry).toBe(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  expect(on.value).toBe(true);
});
