# Opt-in MQTT session recreation (PR 3 of 4)

`enableMqttSessionRecovery` defaults to false. Enable it in advanced plugin
settings or config.json and restart the child bridge to participate in this
experimental release. Leaving it absent preserves the existing reconnect path.

With recovery enabled, the measured multi-robot silence from PRs 1 and 2 can
recreate the account's MQTT client. A single silent robot does not trigger reactive recreation unless the separate
single-robot option below is enabled. Idle time, local timeouts, and writes
alone never trigger reactive recreation.

Cloud sends pause until the broker acknowledges the reply subscription. During
recreation, new cloud requests fail as not sent; requests already building a
payload recheck the gate before publication. Local requests keep operating.
Existing cloud requests get up to 500 ms to finish. Remaining requests, including
B01 map reads, reject with an unknown outcome and are never replayed. This does
not reconcile ambiguous schedule writes; that belongs to PR 4.

Recreation is single-flight. Forced client teardown is bounded at two seconds;
connection plus subscription readiness is bounded at twenty seconds. Successful
attempts have a one-minute cooldown; failures back off from one to fifteen
minutes. There is no tight retry loop: subsequent qualifying evidence or the
existing hourly connection check can retry after that cooldown. Shutdown cancels
waits and prevents another client from being created. Retired client callbacks
cannot change readiness or process messages.

## Preventive refresh: separate and off by default

`enableMqttPreventiveRefresh` defaults to false and lives in the collapsible
Advanced troubleshooting section of the plugin config UI for now. The maintainer
can choose another presentation later. It is a configuration option, not a HomeKit
accessory. It requires experimental session recovery to be enabled, and a child
bridge restart after changing it.

When enabled, a once-per-minute check refreshes sessions that have been ready for
at least four hours. Refresh defers if any cloud request is
still outstanding after the drain window, including a write or B01 map request.
It does not coordinate entire multi-command schedule transactions.

Lifecycle logs contain reasons, generations, timing and cooldowns, not credentials
or request payloads. The regression tests drive real connector callbacks and
request-queue timeouts; the same tests are run against PR 2 as a red baseline.


## Optional repeated single-robot silence (home branch)

`enableMqttSingleRobotRecovery` is separately off by default and sits beside
preventive refresh in Advanced troubleshooting. It requires
`enableMqttSessionRecovery: true`. When enabled, three unanswered `get_*` cloud
reads from the same robot within 15 minutes can trigger recreation. Each read
must span no raw MQTT messages and remain on the same connected, acknowledged
connection. Any raw MQTT callback or connection change clears accumulated
evidence. Evidence is bounded to three timestamps per robot and 128 robots.

This is an explicitly more aggressive recovery policy: a quiet or unavailable
robot can produce it on a healthy MQTT session. It does not broaden PR 2's
breaker exemption; isolated failures still count against their methods.

Both reactive policies and preventive refresh share the one-minute cooldown
after successful recreation. Failures back off. Logs identify the reason as
`repeated-single-robot-silence`, `correlated-silence`, or `preventive`.
Copy diagnostics includes the observed count, threshold, window, enabled
policies, last recovery reason/result, and cooldown remaining at `capturedAt`.
No robot identifiers are added to that snapshot.

### Upgrading the home branch

The old unconditional reactive and preventive policies are replaced by explicit
settings. To retain both and single-robot recovery, enable all three options in
Advanced troubleshooting and restart the child bridge. Until enabled, MQTT's
ordinary reconnect behavior remains available, but these experimental session
recreations are off. No existing Homebridge configuration is changed by a Git
branch update.
