# Optional MQTT recovery in the home build

This home build is based on **3.40.1 stable**. Upstream already creates a fresh
client with a random ID on reconnection. The optional recovery layer supplies
additional triggers and request draining; the connector owns client creation,
teardown and retry backoff. It does not run a second replacement loop.

`enableMqttSessionRecovery` defaults to false. When enabled, correlated silent
reads across multiple robots can request a replacement. Upstream's existing
three-consecutive-V1-timeout recovery remains active, including for one robot.
Both failure policies share the same thirty-minute silence cooldown. Local
failures and idle time alone do not count as correlated cloud silence.

Cloud sends wait for the broker's actual reply-subscription acknowledgement.
Their normal readiness deadline is ten seconds; the native pause/delay controls
allow thirty seconds for the initial reconnect backoff and subscription handshake.
A request that expires before publication fails as not sent and is never replayed
later. Once published, it receives its separate ten-second response deadline.
Existing explicit total budgets for LAN-to-cloud retries still apply. Local
requests bypass the cloud readiness gate.

## Preventive refresh and minutes setting

`enableMqttPreventiveRefresh` is separate and defaults to false. It requires
experimental session recovery to be enabled. The indented **Refresh interval
(minutes)** field below its checkbox sets `mqttPreventiveRefreshMinutes`.
The default is **240 minutes (4 hours)**; accepted values are positive whole
minutes. Invalid saved values fall back to 240. Restart the child bridge after
changing these settings.

A once-per-minute check compares the age of the ready session with that interval.
The age starts after connection and successful SUBACK, and resets after every
ordinary or requested reconnection. The interval is therefore a minimum age,
not a promise to reconnect at an exact wall-clock minute.

Refresh defers while cloud requests or B01 map reads are outstanding. It also
checks queued schedule batches and whole native pause/delay operations, including
the gaps between their individual cloud calls. This check happens before closing
the send gate. Commands can still use the ready session during deferral. A second
check before replacement handles work that appeared while the refresh started.

A preventive refresh does not consume the thirty-minute failure-recovery budget.
It uses the short trigger cooldown and waits for the next idle check when busy.

## Replacement and failure behavior

Concurrent optional triggers share one operation. Reactive requests pause
new cloud sends and allow up to 500 ms for outstanding requests to finish.
Preventive requests defer instead of deliberately interrupting active work.
Retired cloud requests and B01 map reads reject with `MQTT_SESSION_REPLACED`;
writes are marked as potentially ambiguous. Nothing is replayed. LAN requests
remain attached to their own transport. Schedule reconciliation handles uncertain
write outcomes independently.

The old MQTT client is retired and force-closed through the connector's normal
path. Stale callbacks cannot restore readiness or process messages. A fresh
client opens after upstream's initial **10-second backoff**, growing by 1.5 for
unsuccessful connections up to ten minutes. Connection resets the reconnect
backoff, and actual SUBACK opens the send gate.

The optional layer observes readiness for at most thirty seconds, allowing the
initial backoff plus connection and subscription time. If that observation fails,
the replacement remains under ordinary connector management. No extra retry timer
is started. The send-readiness change can request recovery after repeated
connected-but-unsubscribed gate expiries. A later successful SUBACK records
recovery. Optional trigger failures use a one-to-fifteen-minute cooldown; ordinary
upstream reconnect attempts are not blocked by that optional trigger cooldown.
Shutdown cancels waits and prevents further replacements.

## Diagnostics and validation

The persisted recovery snapshot includes the enabled flags, configured minutes,
remaining age, waiting-for-idle state, current attempt, reason/result, failure
count and the separate trigger/silence cooldowns. Saved remaining durations are
snapshots, not live countdowns. Logs include reason, generation and timing;
they do not include credentials or request payloads.

Results are `never`, `in-progress`, `succeeded`, `failed`, `recovered`, `deferred`
or `stopped`. With the option disabled, recovery diagnostics report
`{ enabled: false }`; upstream's default recovery remains active.
Historical `lastEligibleRead` preserves its generation across replacement, while
current correlation evidence is cleared. Upstream's hourly transport summaries
remain available. Unused manual recovery hooks, per-request abort arguments and
the extra per-robot activity-age snapshot have been removed. Shutdown still
cancels readiness waiters.

The extra recovery triggers remain experimental; their benefit over upstream
3.40.1 has not been established. With both options off, upstream recovery remains
active and native pause/delay controls continue to work.

Automated regression tests cover real queue timeouts, replacement timing,
request retirement, late SUBACK, shutdown, shared cooldowns, configured age and
pending schedule batches. These do not replace tests on a physical Homebridge
installation. This adapted home implementation does not imply that the parked
PR #31 has been approved or that isolated-branch field evidence was collected.
