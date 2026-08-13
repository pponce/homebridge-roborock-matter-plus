const { updateServerTimer } = require("../src/hap_schedule_api.ts");

describe("HAP schedule API", () => {
  test("sends upd_server_timer with the nested Roborock timer tuple", async () => {
    const command = jest.fn().mockResolvedValue("ok");
    const api = {
      vacuums: {
        "device-1": { command },
      },
      getServerTimers: jest.fn(),
    };

    await updateServerTimer(api, "device-1", "timer-1", true, {
      requestTimeoutMs: 10000,
    });

    expect(command).toHaveBeenCalledWith(
      "device-1",
      "upd_server_timer",
      [["timer-1", "on"]],
      {
        requestTimeoutMs: 10000,
        preferCloud: true,
        waitForResult: true,
        throwOnError: true,
      }
    );
  });
});
