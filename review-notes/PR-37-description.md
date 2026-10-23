# PR #37: replacement first-post description

Replace the PR description with the text below. Keep the title. This supplies the explicit ten-second no-LAN/no-MQTT behavior Mathias requested and replaces the outdated 3.39 base and validation details. The GitHub connection available for this task cannot edit PR descriptions, so this text has not been applied.

---

Cloud requests can arrive before the MQTT reply subscription is ready. This change waits up to ten seconds before publishing, without allocating a pending RPC or consuming the robot-response budget during that initial wait. An unsent failure does not count against the method breaker.

A working LAN route remains available. With neither LAN nor MQTT available, a request now waits up to ten seconds before failing as not sent. Methods that require MQTT also use the bounded readiness wait. A caller-supplied timeout remains shared across a LAN attempt, readiness wait and cloud retry.

Readiness follows 3.40.0-beta.2's new-client lifecycle, guarded listeners and retired-client handling. Shutdown cancels waiters. The request frame is built after the wait, and the robot-response timer is armed after publication.

To avoid leaving a connected but unsubscribed client stuck forever, three consecutive readiness expiries in that state request a health restart using the same 30-minute cooldown as cloud-silence recovery. Disconnected expiries do not count. A successful subscription or connection reset clears the streak.

Based directly on 3.40.0-beta.2. The broader optional lifecycle remains parked in #31; this PR does not require it.

Live validation remains pending before leaving draft: a brief reconnect and an outage over ten seconds, each tested through a Matter command and a HAP switch, with Apple Home observations and timestamps. Automated results do not establish visible Apple Home behavior. The currently available personal test setup is a combined build; any evidence from it must identify that limitation.

Validation at `5d022abfc98ac431181da49b5d7103a799b6c2d1`: formatting, type checks, build and all 2,556 tests in 240 suites pass on Node 22. [Validation job](https://github.com/pponce/homebridge-roborock-matter-plus/actions/runs/39981679083/job/120510291957).
