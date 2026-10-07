# Home branch integration and remaining extras

This inventory compares `MQTT_ACCOUNT_SESSION_RECOVERY` with upstream v3.37.0 plus the submitted versions of PRs #30, #31, #32, #36, #37 and #38. It describes code, not a claim that every proposal has been approved or tested on physical robots. The reasons below describe the intended benefit from our home-branch work; they are not evidence that upstream needs every implementation detail.

## Integration baseline

| Included work                                                               | Reviewed commit                            | Scope                                                                                        |
| --------------------------------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------- |
| v3.37.0 / merged #29                                                        | `4d23bf0e812111758afbd46b68e26d1c9bd52e8c` | Passive diagnostics, real SUBACK observations, persistence flush after teardown              |
| [#30](https://github.com/mathiashornbek/homebridge-roborock-matter/pull/30) | `bb1777a32c98bcca35570023eddb6140aa7cbd59` | Strictly cross-robot breaker exemption                                                       |
| [#31](https://github.com/mathiashornbek/homebridge-roborock-matter/pull/31) | `a59ba5a96cdcfe3a7994b5d571237cfdf627ae66` | Experimental recreation, optional preventive refresh, recovery diagnostics                   |
| [#32](https://github.com/mathiashornbek/homebridge-roborock-matter/pull/32) | `3d1a03f3cc519defceaf0a1b8b6219881a967b8d` | Schedule-write reconciliation and duplicate-write suppression                                |
| [#36](https://github.com/mathiashornbek/homebridge-roborock-matter/pull/36) | `52a38d05701148667b510ce141cdbbf23725de5c` | Submitted discussion code for momentary actions and presence logging                         |
| [#37](https://github.com/mathiashornbek/homebridge-roborock-matter/pull/37) | `bc469f1cd770e3b4639f773d592a4e655d88d552` | Ordinary MQTT readiness gate, separate publication/response budgets, unsent-request handling |
| [#38](https://github.com/mathiashornbek/homebridge-roborock-matter/pull/38) | `91c4e05e87151588d5b8d558882fac320f620b8b` | Optimistic schedule display, explicit rollback and newer-intent protection                   |

The home branch before this integration was `544097fd5bc3b2a840321b3145c616ce3ddd6294`. It already contained v3.37.0 and the #30–32 changes. This integration adopts #38's schedule-switch implementation and #37's send/timing safeguards, adapting readiness to the existing home connector so its additional lifecycle capabilities remain available. A subsequent integration implements the #36 discussion split: #36 is presence-only, and a separate momentary-action branch covers the five action buttons and routines with prominent failures. Physical-robot validation remains pending.

## Active capabilities still specific to the home branch

### 1. Immediate shutdown teardown

`roborockLib/roborockAPI.js` clears timers synchronously and starts transport teardown without first yielding through an unnecessary `await`. The intended benefit is to stop transport activity as soon as shutdown starts. Persisted state is flushed after teardown, including its final diagnostics snapshot.

Only the same-turn ordering remains extra: the persistence-flush correction is already upstream. Mathias explicitly asked to park further shutdown changes until the other lifecycle work settles. Keep this in the home branch and discuss it separately; it is not a prerequisite for the submitted series.

### 2. A broader ordinary reconnect lifecycle

`roborockLib/lib/roborock_mqtt_connector.js` can create a fresh client with experimental recovery disabled. It coordinates concurrent recreation attempts, briefly drains pending work, retires requests belonging to the old session, bounds client teardown and readiness waits, and tracks reconnect failures/backoff. With experimental recovery enabled, the dedicated #31 lifecycle is used.

This was added to recover a wedged account session without restarting Homebridge and to avoid leaving old requests attached to a replacement connection. It goes beyond #37, which controls when an ordinary request may be sent. It changes how a reconnect happens, not just when a request waits.

Do not interpret this as an unconditional minimum interval on every ordinary reconnect: a forced reconnect bypasses the ordinary cooldown check. The upstream default silence rule still has its own 30-minute limit. A useful discussion would be whether the fresh-client lifecycle should eventually become shared infrastructure, with its ordinary-path effects reviewed explicitly.

### 3. More pending-request metadata

The queue and API retain device, transport, operation classification, client generation, creation time and publication time. Vacuum/schedule callers can identify reads, writes and map operations. This supports retiring the correct generation's requests and marking a retired write as potentially ambiguous instead of counting teardown as a robot response.

Some publication timing is now shared with #37. The extra classification/generation machinery mainly supports the broader reconnect lifecycle above. It is not a new user setting. Mathias has not explicitly rejected this machinery; its justification should be evaluated with the lifecycle that needs it.

### 4. Additional readiness controls

The home connector retains event-driven readiness waiters, optional `AbortSignal` cancellation, internal per-request `cloudGateTimeoutMs` overrides, and explicit subscription-attempt failure/deadline handling. It validates subscription grants and guards callbacks against retired clients/connection attempts.

The intended benefit is to stop waiting promptly when subscription is refused or the caller cancels, and to prevent stale callbacks from declaring a new session ready. The main user-facing readiness feature and separate response budget are covered by #37. These are supporting differences, not additional UI options. No current production caller was found supplying an abort signal or overriding the readiness budget; those hooks are available rather than independently active features.

### 5. Small lifecycle safeguards and diagnostic details

| Difference                                                         | Intended benefit and discussion scope                                                                                         |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Prevent duplicate recovery-handler installation on the same client | Avoid multiple reactions when home initialization paths revisit a client; no demonstrated upstream duplication bug is claimed |
| Clear the startup watchdog on experimental connection              | Avoid an obsolete initial-connect timeout after a successful connection                                                       |
| Log recreation start and reason                                    | Show that recovery began, even before its result is available                                                                 |
| Emit diagnostics when a general cooldown blocks recreation         | Make the reason for deferring an attempt visible                                                                              |
| Catch and warn on hourly health-check errors                       | Avoid an unexpected rejected health-check promise disappearing without useful context                                         |

These belong next to the lifecycle they protect if upstream needs them. They should not be bundled as unexplained behavior changes. Core recovery reason/result/failure/cooldown reporting is already in #31 and is not an extra.

### 6. Routine acknowledgement is now covered by the focused action proposal

Routine buttons now share the accepted-press/background-command policy with Start, Dock, Empty Bin, Pause and Find in `momentary-action-acknowledgement`. Failures name the routine or action, robot and reason at warning/error level. This capability is retained in the home branch but is no longer an unproposed extra. Physical-robot validation is still pending; see [the acknowledgement notes](momentary-action-acknowledgement.md).

## Supporting differences and cleanup candidates

These are not additional user-facing features. They are preserved so integration does not also become an unrelated cleanup.

| Item                                                                                | Purpose / present status                                                                                       |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Per-robot raw/decoded/correlated ages in the connector health snapshot              | Additional internal inspection data; no production consumer found beyond the existing diagnostic/test surfaces |
| `recoverMqttSession` API facade                                                     | Entry point for explicit recovery; no production caller found                                                  |
| `isRecoverableScheduleCloudFailure` helper                                          | Classifies schedule/cloud failures; retained helper/test coverage, not a separate current behavior             |
| Additional refresh-result `failedSources` / `error` fields                          | Carry partial-failure information; no production consumer found for the extra fields                           |
| `isPreventiveReconnectDue` helper                                                   | Retained helper/test surface; active preventive policy is already supplied by #31                              |
| Older maintenance/preventive constants and `silentCloudReadTimeouts` bookkeeping    | Leftovers from earlier iterations; do not represent a second active preventive or single-robot policy          |
| Home-specific regression tests, generated `dist/`, build workflow and working notes | Support the fork's installation and development process; not product capabilities proposed upstream            |

## Features that are no longer extras

- Single-robot silence recovery already exists in the upstream baseline. The former separate single-robot checkbox is not an extra to reintroduce. Breaker exemption remains strictly cross-robot.
- Recovery diagnostics and the nested preventive-refresh option are covered by #31.
- Schedule-write readback and duplicate suppression are covered by #32.
- Ordinary send readiness and a response budget that starts after publication are covered by #37.
- Optimistic schedule feedback and its tested rollback policy are covered by #38.
- Persistence flushing after transport teardown is already in v3.37.0.

## Suggested discussion

The home branch keeps the extras while adopting the submitted PR behavior wherever the features overlap. Which of the remaining pieces should become focused upstream follow-ups, and which should stay fork-specific? In particular, should the ordinary fresh-client lifecycle and the metadata it requires be reviewed together? Are the small lifecycle safeguards useful independently of that implementation? Immediate shutdown ordering can remain parked as requested.

The #36 split is implemented: presence-only logging remains in #36, and momentary actions are prepared independently in `momentary-action-acknowledgement`. Retained snapshots stay debug-only; each robot's first live presence is informational once per plugin lifetime. The focused code and integrated home branch have separate automated validation. Physical-robot acknowledgement/failure checks remain pending and must be reported as integration-branch observations when testing this home branch.
