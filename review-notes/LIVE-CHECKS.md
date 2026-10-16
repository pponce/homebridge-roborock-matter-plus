# Live checks on Pedro's combined build

Use `SCHEDULE_PAUSE_DELAY`, keeping its pause/delay controls. This guide replaces the earlier instructions to swap isolated PR builds into the live installation.

The combined revision prepared for this work is [`eeb36fac8bbee9e9ede8fac80aaaaa3e813fc84a`](https://github.com/pponce/homebridge-roborock-matter-plus/commit/eeb36fac8bbee9e9ede8fac80aaaaa3e813fc84a). Report the revision or npm package/version actually installed. A checkout's Git revision does not establish what Homebridge has installed, and the shared package version `3.39.0` alone does not identify the combined build.

All observations here are **integration testing on the combined build**, which includes the revised PRs, additional MQTT work, and native schedule pause/delay controls. They do not isolate an individual PR. Mathias explicitly requested isolated-branch evidence for [#39](https://github.com/mathiashornbek/homebridge-roborock-matter/pull/39#issuecomment-6190896487); these results leave him to decide whether he can accept that limitation. No upstream merge is needed to run these tests.

## Prepare once

1. Keep the combined build installed. Do not remove accessories or disable the pause/delay feature settings.
2. Pick one robot that is online and idle. Choose a time with no active pause/delay operation and no cleaning scheduled during the tests. Record a normal schedule's original enabled state.
3. Open the Homebridge UI log on your computer and Apple Home on your phone. Enable the plugin's **Debug Mode** temporarily. Save the logs from just before each test until its result and reconnection, and screen-record Apple Home.
4. For the MQTT tests, enable **Use Roborock Cloud Only** (`cloudOnlyMode: true`) in this plugin and restart its child bridge, or Homebridge if it has no child bridge. This prevents a working LAN command from bypassing the MQTT wait. Leave the recovery and pause/delay options as you normally use them; record those settings.
5. Wait until the robot and switches work normally. Do one successful Find press. Restore the original Cloud Only and Debug Mode settings after all tests.

Test one action at a time. Stop/dock any cleaning started by a success test before the next case. The action switch resetting to OFF is acknowledgement of the press, not proof that the robot acted.

## One reusable Linux command

Run this on the **Linux Homebridge host**, not the development computer. First choose `0` for a read-only check. On later runs choose the number requested by the test below.

The helper needs existing `python3`, `curl`, `sha256sum`, `ss`, `nft`, and `sudo`. It does not install packages. If the check stops, return the bounded output; do not guess a PID or firewall rule.

The MQTT choices block the detected MQTT destination port for the Linux user running Homebridge, and close only the selected existing MQTT socket. The HTTPS choice blocks outbound TCP port 443 for that user. **Other plugins/processes running as the same user and using that port are affected during the selected interval.** Local HomeKit/Matter traffic and ordinary SSH use different ports. Homebridge itself stays running.

The helper creates its own temporary firewall table; it does not flush or change existing tables. Its blocking set entry expires in the kernel even if the terminal closes. After the interval it removes its table. A five-second countdown lets you get ready to tap. Watch the Roborock log to confirm the selected connection is actually its MQTT session; if it is not, let the short interruption expire and return the output.

```bash
{
  echo "START COPY HERE — Roborock live check"
  RR_LIVE_TMP=""
  if ! command -v curl >/dev/null || ! command -v python3 >/dev/null || ! command -v sha256sum >/dev/null; then
    echo "STOP: curl, python3, and sha256sum are required. Nothing changed."
  elif ! RR_LIVE_TMP=$(mktemp); then
    echo "STOP: Could not create the temporary helper file."
  elif ! curl --connect-timeout 15 --max-time 60 -fsSL \
    'https://raw.githubusercontent.com/pponce/homebridge-roborock-matter-plus/af4670030679706f5ee522f70eada6b873159dec/review-notes/roborock-live-test.py' \
    -o "$RR_LIVE_TMP"; then
    echo "STOP: Helper download failed."
  elif ! printf '%s  %s\n' '89a9383502bcfdc9c2aece89d39809d47e46aa84f8e788ecb9b1609de4f601b8' "$RR_LIVE_TMP" | sha256sum -c -; then
    echo "STOP: Helper checksum did not match."
  else
    echo "0 = Read-only check"
    echo "1 = MQTT interruption: 6 seconds"
    echo "2 = MQTT interruption: 30 seconds"
    echo "3 = MQTT interruption: 60 seconds"
    echo "4 = HTTPS interruption: 30 seconds"
    read -r -p "Choose 0–4 (anything else cancels): " RR_LIVE_CHOICE
    case "$RR_LIVE_CHOICE" in
      0) sudo python3 "$RR_LIVE_TMP" check; RR_LIVE_STATUS=$? ;;
      1) sudo python3 "$RR_LIVE_TMP" mqtt 6; RR_LIVE_STATUS=$? ;;
      2) sudo python3 "$RR_LIVE_TMP" mqtt 30; RR_LIVE_STATUS=$? ;;
      3) sudo python3 "$RR_LIVE_TMP" mqtt 60; RR_LIVE_STATUS=$? ;;
      4) sudo python3 "$RR_LIVE_TMP" https 30; RR_LIVE_STATUS=$? ;;
      *) echo "Cancelled; no interruption requested."; RR_LIVE_STATUS=0 ;;
    esac
    echo "Helper exit status: $RR_LIVE_STATUS"
  fi
  if [ -n "$RR_LIVE_TMP" ] && [ -f "$RR_LIVE_TMP" ]; then
    rm -f -- "$RR_LIVE_TMP"
  fi
  echo "END COPY HERE — Roborock live check"
}
```

An exit status of zero says the helper completed, not that the plugin passed. Record what actually happened. The helper's discovery, refusal, cleanup, and command-selection paths were checked with eight automated tests; no firewall interruption or physical robot test was run on Pedro's host during preparation. `nft --check` validates the proposed rule on the host before it can be installed. Linux references: [nftables sets, timeouts and UID matching](https://www.netfilter.org/projects/nftables/manpage.html), [ss socket filtering and closure](https://man7.org/linux/man-pages/man8/ss.8.html).

## #37 — MQTT reconnect and timeout

Use the actual Matter vacuum tile for Matter commands. For HAP use the separate **Find** switch, which is easy to verify by hearing the robot. A normal successful Find before each case confirms the robot is available.

Do four separate runs:

| Case | Helper choice | Tap after `MQTT SOCKET CLOSED` and Roborock's disconnect log | Expected observation |
| --- | --- | --- | --- |
| Brief reconnect, Matter | `1` | Within about two seconds, press Start/Play on the Matter vacuum tile. | The request waits for MQTT recovery, is sent once after readiness, and the robot starts. |
| Brief reconnect, HAP | `1` | Within about two seconds, press the HAP Find switch once. | Home accepts/reset the press; the robot announces once after readiness returns. |
| Long outage, Matter | `2` | Within about two seconds, press Start/Play once. | The readiness wait expires without sending; the robot stays idle and does not start after recovery. |
| Long outage, HAP | `2` | Within about two seconds, press Find once. | The press can be accepted in Home, but the log reports it was not sent. There is no announcement after recovery. |

Before each run, wait until the previous interruption has ended and a fresh Find works. After each long-outage run, leave the robot untouched for 30 seconds after reconnection to check for delayed replay, then try a fresh Find to establish recovery.

Capture: helper block start/expiry, Roborock disconnect, tap, MQTT connection/subscription evidence if logged, actual send/response, and physical response. A connection log by itself does not prove the reply subscription was ready. For expiry, look for `MQTT reply subscription did not become ready within 10000ms; this command was not sent.` The ten seconds belongs to the readiness wait, so pre-dispatch work may add to the tap-to-error time.

The six-second block leaves time for reconnect, but does not guarantee subscription recovery before the ten-second request deadline. If recovery is late, report the actual timings and repeat the brief case; do not relabel a timeout as success. If there is no Roborock disconnect, or the tap happened after recovery, that run did not exercise the intended wait.

Optional LAN regression check: restore Cloud Only to OFF, enable Prefer Roborock Cloud for Matter Commands, establish a working LAN connection, then run choice `2` and press Matter Start. The command should use working LAN without waiting for MQTT. Confirm the route in logs. Restore both settings afterward. This is extra regression coverage, not an additional live-test demand from Mathias.

## #38 — ordinary schedule switches

Use a regular scheduled-clean ON/OFF switch, not Pause Until Tomorrow, Delay 1 Hour, or a momentary Routine action. Choose a schedule whose next run is well outside the test window. Record its original state.

### A. Successful confirmation

1. With the network healthy and no previous pending write, note the schedule state in both Apple Home and the Roborock app.
2. Toggle it once in Apple Home; note the tap time and immediate display change.
3. Wait for schedule reconciliation and a fresh read. Record elapsed time; reopen/refresh the schedule in the Roborock app to confirm its actual state. Typical confirmation is 5–8 seconds, but record your measurement.
4. Wait for that request to settle, toggle back, and confirm again. Save both intervals.

### B. Definite failure, visible rollback, and a retry during the cooldown

For a standard device timer, the successful baseline's logs contain `upd_server_timer`. That uses MQTT. A schedule identifier beginning `scene:` is a cloud Routine schedule and uses HTTPS; an MQTT-only outage does not test its write failure.

1. Use a device timer and establish a confirmed ON state. Wait for prior commands to settle.
2. Run helper choice `3` (60-second MQTT outage). Confirm the disconnect, then tap the schedule OFF once.
3. Watch Home show provisional OFF. Wait for `Schedule display rollback` naming the robot and switch, and record when Home returns to ON. The Roborock app should still show ON because this write was not sent.
4. Within five seconds after that rollback, tap OFF again. Record the display and `Schedule request suppressed after failure` log. During the 30-second cooldown the failed OFF request should not leave the tile falsely OFF.
5. After the block has ended, MQTT has recovered, and at least 35 seconds have elapsed since the failure, tap OFF again. It should now confirm normally. Restore the original schedule state when finished.

If this robot only has `scene:` schedules, try choice `4` while making the same toggle, and report the actual outcome. The cloud-scene path first reads current scene data; a failure may be classified as unknown instead of definite. **Only count this as the rollback case if the logs show a definite failure and rollback.** Otherwise mark definite rollback as not reproduced; the HTTP interruption itself is not proof.

If no command reaches the readiness gate during the timed block because account work is queued, this attempt did not establish a not-sent failure. Record that rather than assuming the condition was exercised.

### C. Another tap while pending

This is a separate run, after earlier cooldowns and writes have settled. Start confirmed OFF, run choice `2`, then tap ON, two seconds later OFF, and two seconds later ON. Record the screen and each tap time. Older failures must not clear the latest pending display; once the latest request itself succeeds or fails, its result determines the final state. With the connection blocked it may legitimately finish OFF. Logs such as `Earlier schedule request failed ... Keeping the newer requested display` distinguish an older failure from the final failure. If taps coalesce into one command, say so; that run does not demonstrate the older-failure case.

### Optional: pending-write restart

Mathias requested code and automated tests for this; a separate live reproduction is additional coverage. With a device timer confirmed ON, start choice `3`, tap OFF, then restart the Roborock child bridge from the Homebridge UI within a couple of seconds, before the request finishes. Keep the combined build installed.

Look for `Schedule request interrupted by ... outcome unknown`, then `Schedule display rollback ... interrupted request from before restart`, and later a fresh-read resolution. The provisional OFF must not be silently treated as confirmed. After connectivity returns, compare with the actual Roborock schedule. If the request had already completed before restart, mark the attempt invalid. Restore the schedule's original state.

### Optional: unknown outcome

A command blocked before sending is not an unknown outcome. It requires a write that may have reached Roborock followed by failed acknowledgement/verification. The simple timed commands do not reliably hit that precise race. Do not manufacture a result by calling every timeout unknown.

If it occurs during testing, capture `Schedule outcome unknown`, subsequent follow-up/fresh-read logs, the app's actual state, and any retap. The switch should not falsely claim definite failure or apply the definite-failure cooldown. A follow-up read may also fail while the network is unavailable; capture the later normal successful refresh too. Otherwise report **not reproduced live; automated coverage exists**. Ambiguous writes plus fallback can take over a minute, with additional account queueing.

## #39 — Find and one Routine

Use the separate **HAP Find switch**, not the Matter identify control. Pick one identifiable Routine and use the same one in both cases. Return the robot to idle between tests.

1. **Find success:** with connectivity healthy, tap Find once. Record immediate Home acknowledgement, the switch resetting after about 1.5 seconds, and the robot's announcement. Save the log interval.
2. **Routine success:** tap the chosen Routine once. Record acknowledgement/reset separately from the robot physically beginning the intended clean. The `Running Roborock routine` line shows the request began, not that cleaning succeeded. Stop/dock the robot afterward.
3. **Find failure:** with Cloud Only still ON, use helper choice `2`; after the disconnect, press Find. It should still acknowledge/reset in Home, then log the command failure and not announce. The combined code may log `Unable to locate ... from ... identify` with the readiness/not-sent reason; do not require an invented exact `Accepted Home action` line. Check again after recovery for no replay.
4. **Routine failure:** wait for MQTT, account work, and prior tests to settle. Run choice `4` (30-second HTTPS outage), then tap the same Routine once immediately after `HTTPS BLOCKED`. Expect immediate acknowledgement/reset, followed by `Accepted Home routine "..." for ... failed: ...`, and no physical cleaning. Save the interval through restored connectivity. If the request was queued until after the block and succeeded, report that; it did not exercise failure.

The failure method is a **simulated Homebridge-to-cloud network failure**. Say so; it is neither a robot-offline test nor a Roborock HTTP rejection. Merely powering off a robot does not reliably fail a Routine API request, because the cloud may accept it anyway.

Optional duplicate check: if a Routine request genuinely remains queued/in flight after its switch resets, tap it once more. Expect `Ignoring repeated Home routine ... still queued or awaiting a cloud response`, with only one execution request. The guard ends when the API request finishes; ongoing physical cleaning alone does not mean another tap should be ignored.

## What to send back

For each case, provide the installed package/version and known revision, robot model/name, switch name, settings changed for the test, date/time/timezone, tap time, Home response/reset/rollback time, actual robot/app outcome, and logs from before interruption through recovery. Include the helper's bounded timestamped output. Remove tokens, passwords, LAN keys and pairing codes before sharing raw debug logs.

| Case | Tap time + timezone | Home behavior and timing | Robot/app outcome | Relevant log interval | Result |
| --- | --- | --- | --- | --- | --- |
| #37 short / Matter | | | | | |
| #37 short / HAP | | | | | |
| #37 long / Matter | | | | | |
| #37 long / HAP | | | | | |
| #38 confirmed toggle | | | | | |
| #38 rollback + retap | | | | | |
| #38 retap while pending | | | | | |
| #39 Find success / failure | | | | | |
| #39 Routine success / failure | | | | | |

Use `observed as expected`, `unexpected result`, `not reproduced`, or `not attempted`. No live result has been recorded by preparing this guide. State the combined-build limitation in each PR's evidence; do not describe these observations as tests of the isolated PR head.

## Previous isolated install branches

The separate `test-pr37-v339`, `test-pr38-v339`, and `test-pr39-v339` builds remain available for independent environments. **Do not install them over this live combined build's accessory cache.** Their accessory cleanup does not recognize the native pause/delay controls and can unregister them. Those builds are not part of this chosen testing procedure.
