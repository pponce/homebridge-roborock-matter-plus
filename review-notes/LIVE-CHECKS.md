# Live Apple Home checks

These install branches contain the corresponding PR source plus compiled `dist/` output only. Their code scope was checked against the published PRs. They let the observations be attributed to the reviewed change.

| PR | Install branch | Source revision | Build revision |
| --- | --- | --- | --- |
| #37 | [test-pr37-v339](https://github.com/pponce/homebridge-roborock-matter-plus/tree/test-pr37-v339) | `b4e9342fcfff73c7ca3897bf48509fdfbd241d6f` | `371d2e4499210913e2fbc07fa77971b03d523ba2` |
| #38 | [test-pr38-v339](https://github.com/pponce/homebridge-roborock-matter-plus/tree/test-pr38-v339) | `5ae9c12f1e0fdc26e609bfa7a02f47f17bcd58be` | `cef62f096c1a6c48d1eb68c5fa86f603e5812291` |
| #39 | [test-pr39-v339](https://github.com/pponce/homebridge-roborock-matter-plus/tree/test-pr39-v339) | `b7986ee090b0b1dc92913f34c8bd4ff34134047f` | `7e6e859ab83635faf849df624e2eab1b91139792` |

#37 is v3.39.0 plus readiness. #38 is v3.39.0 plus #32 and optimistic schedule feedback. #39 is v3.39.0 plus its Find/Routine changes, without MQTT recovery, readiness or schedule reconciliation.

## Install one build at a time

Use the host terminal for the Homebridge service and stop it before changing the plugin. These commands use the standard [Homebridge service commands](https://github.com/homebridge/homebridge/wiki/Install-Homebridge-on-Debian-or-Ubuntu-Linux#configuration-reference) and pin the compiled build revision.

### #37 — MQTT readiness

```bash
sudo hb-service stop
sudo hb-service add "github:pponce/homebridge-roborock-matter-plus#371d2e4499210913e2fbc07fa77971b03d523ba2"
sudo hb-service start
```

Use a cloud-routed command with no working LAN route for the readiness-expiry cases; a working LAN would correctly bypass the MQTT wait. Record how the outage was produced.

1. Briefly interrupt MQTT and restore it within ten seconds. During the interruption, issue a Matter command. Record tap time, connection/subscription recovery, command send/response and actual Home/robot behavior. Repeat with a HAP switch.
2. Repeat with an MQTT outage lasting longer than ten seconds. Record when the command is rejected as not sent, what Home displays, and whether the robot acts after connectivity returns. The expired command must not replay.
3. With LAN working and preferCloudForMatterCommands enabled, interrupt MQTT and issue a Matter command. Confirm that the working LAN route handles it without the readiness delay.

Do not infer that a button's immediate acknowledgement means the robot acted. Record the UI and physical result separately.

### #38 — schedule display

```bash
sudo hb-service stop
sudo hb-service add "github:pponce/homebridge-roborock-matter-plus#cef62f096c1a6c48d1eb68c5fa86f603e5812291"
sudo hb-service start
```

Use one identifiable schedule and preserve its Home name in the report.

1. Toggle successfully. Record immediate display, final confirmed state and elapsed time; compare with the Roborock app.
2. Produce a definite refusal/failure and record the visible rollback, its timing and the named rollback log line. Retap during a pending operation and check that an older failure does not overwrite the newest intent.
3. Restart Homebridge while a schedule write is pending. Record the restored display, interruption/rollback log and later fresh-read resolution. Homebridge's cache is saved before shutdown, which is the case the new context state protects.
4. Where reproducible, let a write be submitted but lose its acknowledgement/verification. Record “outcome unknown,” the one follow-up read, any later correction and whether a correct retap is accepted. A definite failure and an unknown outcome are distinct cases; say when an unknown outcome cannot be reproduced.

Typical confirmation is 5–8 seconds; an ambiguous write plus fallback can take over a minute, plus account queueing. Those are expectations to compare against observed timings, not recorded results.

### #39 — Find and Routine actions

```bash
sudo hb-service stop
sudo hb-service add "github:pponce/homebridge-roborock-matter-plus#7e6e859ab83635faf849df624e2eab1b91139792"
sudo hb-service start
```

1. Run Find successfully; record button response, the robot's announcement and logs.
2. Run one Routine successfully; record button response, actual robot behavior and logs.
3. Repeat Find and that Routine with a failure condition, such as the robot offline or the cloud refusing. Confirm the accepted press is followed by a warning/error naming the action, robot and reason. An offline robot may not cause an immediate cloud refusal; record the actual outcome rather than assuming failure.
4. If a Routine request remains queued/in flight beyond the 1.5-second switch reset, press it again. Record the ignored-duplicate info line and whether only one request executes. The guard ends at the request response, not physical cleaning completion.

This is the isolated test Mathias requested; observations from the integrated home branch do not substitute for it.

## Capture and report

Use `sudo hb-service logs` or the Homebridge UI log view. For each case capture the installed build revision, robot/switch names, timestamp with timezone, tap time, visible Home response, physical/Roborock-app result, and the corresponding log interval through recovery or failure.

| Case | Tap time | Home display / time | Robot or app result | Relevant logs |
| --- | --- | --- | --- | --- |
| Fill after testing | | | | |

No live checks have been completed by this review work. Add actual observations to the relevant PR before taking #37–#39 out of draft.

## Return to the existing combined home build

The previously linked home branch and its compiled output are unchanged. To return to that exact revision after testing:

```bash
sudo hb-service stop
sudo hb-service add "github:pponce/homebridge-roborock-matter-plus#42f0cc4c862d8e0307d9907f6405c71c53271417"
sudo hb-service start
```
