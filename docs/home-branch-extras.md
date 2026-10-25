# Home branch additions on 3.40.1

This inventory describes the current `SCHEDULE_PAUSE_DELAY` build, based on
upstream **3.40.1 stable**. Earlier inventories mixed active features with
historical proposals and unused helper APIs. The previous inventory remains in
[Git history](https://github.com/pponce/homebridge-roborock-matter-plus/blob/d42eb597dd79960e3cd4f78319e985ad68c40708/docs/home-branch-extras.md).
Personal working-plan documents remain in the repository for historical context.

## Branch roles

- `SCHEDULE_PAUSE_DELAY`: stable upstream, the four remaining open PRs, native pause/delay,
  and the limited home additions described here.
- `upstream_plus_SCHEDULE_PAUSE_DELAY`: stable upstream plus native pause/delay
  only. It retains upstream's transport and shutdown policies.

Both use the existing plugin package identity. Native accessory IDs, configuration
keys and the saved schedule journal are preserved, so switching builds does not
require replacing the native pause/delay controls. Choose one build at a time.

## Native pause and delay

Pause Active, Pause Until Tomorrow, stacked delay presses, Delay Active restoration,
per-vacuum/all-vacuum selections, configurable delay minutes and daily restoration
remain available. See [schedule controls](schedule-controls.md).

In the combined build, native MQTT readiness allows thirty seconds for the initial
10-second reconnect delay and the connect/SUBACK handshake. The normal ten-second
robot-response timeout begins after publication. Existing explicit total budgets
for LAN-to-cloud retries remain bounded as before. Native HomeKit handlers already
acknowledge presses immediately; the work happens in the background. A request
whose readiness deadline expires is not sent or replayed later.

## Optional recovery retained for comparison

The extra correlated-silence trigger and preventive age refresh remain experimental
and **off by default**. Keeping them available does not establish a reliability
benefit over 3.40.1. The upstream PR #31 proposal remains parked pending evidence.

Preventive refresh retains its indented minutes field, default 240. It requires
both recovery options. It uses upstream's fresh-client factory and reconnect
backoff, resets age after successful subscription, and defers while cloud requests,
map reads, queued schedule writes or complete native schedule operations are busy.
There is no second client factory or retry timer. Failure recovery shares the
upstream thirty-minute silence cooldown; age refresh does not consume it.
See [MQTT recovery behavior](mqtt-session-recovery.md).

Small protections retained alongside that integration:

- A retired client cannot change readiness or process replies during reconnect
  backoff, and repeated initialization does not install duplicate handlers.
- Pending requests carry their transport, session generation and operation type.
  Interrupted cloud writes are marked as potentially ambiguous and never replayed.
- Shutdown still cancels readiness waiters. Its teardown ordering now matches
  upstream again.

## Changes already covered by upstream or an open PR

Upstream supplies fresh clients with random IDs, growing reconnect backoff,
V1-only silence counting, LAN keep-alives/cloud fallback, transport summaries,
shutdown/persistence fixes, basic optimistic schedule feedback, #30's correlated
silence breaker exemption and #42's probe-test correction.

3.40.1 includes #32 (schedule reconciliation), #36 (retained presence logging)
and #46 (historical eligible-read evidence). The remaining PR additions are:

| PR  | Remaining scope                                                                  |
| --- | -------------------------------------------------------------------------------- |
| #31 | Optional recovery triggers and diagnostics, adapted here to upstream's lifecycle |
| #32 | Reconcile uncertain schedule writes and share duplicate pending requests         |
| #36 | Distinguish retained presence snapshots from live changes                        |
| #37 | Wait for reply readiness without blocking a working LAN route                    |
| #38 | Persist confirmed schedule state and handle unknown write outcomes               |
| #39 | Acknowledge Find/Routine presses promptly and suppress duplicate runs            |
| #46 | Preserve historical eligible-read evidence across sessions                       |

The remaining PRs are rebased onto 3.40.1. This integration includes #37's caller-budget/LAN-error fixes and #38's early HAP refusal handling.

## Removed supporting code

The unused manual recovery facade, cancellable-wait argument, extra per-robot
activity-age map/snapshot, and request creation/publication timestamps have been
removed. The ordinary readiness gate and its shutdown cancellation remain.
The extra immediate-shutdown ordering has been reverted to upstream. Passive
session diagnostics and upstream's per-robot transport summaries remain available.

## Explicit schedule investigation

The schedule inspection and controlled time-trial tools remain developer tools.
Enabling plugin debug logging no longer runs the three extra cloud-job OPTIONS
probes. Existing upstream debug discovery remains intact.

Run the existing `scripts/inspect-schedule-preflight.cjs` diagnostic with
`--probe-methods` only when method discovery is wanted. It reads the current job
list, then probes the collection, the selected existing job and an intentionally
absent subresource. Each OPTIONS request has a ten-second timeout. The default
preflight remains GET-only; the probe mode cannot issue writes or probe other
jobs. See [schedule investigation](schedule-time-investigation.md).

Automated tests verify readiness across reconnects, separate response timing,
expiry without later publication, schedule-busy refresh deferral and explicit
probe scope. Physical robot/Homebridge observations remain separate evidence.
