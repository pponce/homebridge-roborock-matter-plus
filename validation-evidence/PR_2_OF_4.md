# [2/4] Exclude correlated MQTT session silence from method breaker counts

Second of four changes requested in #27. **Depends on #29 (PR 1/4, passive instrumentation).** Target upstream `main` after #29 is merged. If #29 changes during review, update this branch to match before submission.

## Why

A cloud connection can report connected while replies stop across the account. Counting those timeouts against each robot/method can open otherwise healthy methods for six hours. PR 1 records the evidence; this change feeds that measured signal into the breaker.

## Change

- Tag the actual cloud timeout with `accountSessionWasSilent` only when both cross-robot correlation and that particular read's evidence qualify at rejection time.
- Make the breaker ignore that tagged failure using the boolean field, not a regex over log text.
- Keep rejecting the timed-out request normally. No errors are swallowed or converted to successful responses.
- Preserve previous counts and already-open breakers. Suppression is prospective; evidence must exist before a failure can be excluded.
- Preserve ordinary counting for isolated robot failures, local timeouts, missing instrumentation, writes, and requests that crossed generations or received MQTT traffic while pending.
- Keep PR 1's observation criteria unchanged. Its existing breaker assertion is updated for the intentional policy change, and new production-path regression tests cover the exclusion boundaries.

No session recreation, retries, request gating, schedule handling changes, or new settings are included.

## Validation

The same 15 new tests were run against both baselines and the completed change, using actual production MQTT callbacks, request timeouts, and breaker code:

| Baseline | Passed | Failed | Runtime/loading errors |
| --- | ---: | ---: | ---: |
| v3.33.0 | 6 | 9 | 0 |
| PR 1 instrumentation only (`42e070a`) | 10 | 5 | 0 |
| This change | 15 | 0 | 0 |

The five failures against PR 1 isolate this PR's behavior: false breaker opening, suppression at the sixth strike, structured classification independent of prose, preserved timeout rejection without counting, and preserving an existing breaker's state instead of extending it.

Full validation on Node 22: **137 suites / 2,088 tests pass**, plus formatting, both TypeScript configurations, and build.

- [Validation run](https://github.com/pponce/homebridge-roborock-matter-plus/actions/runs/35817143405)
- [Failing PR 1 baseline](https://github.com/pponce/homebridge-roborock-matter-plus/blob/26344e27e113804c2cc393045aaf4127f688e2a5/validation-evidence/instrumentation.json)
- [Failing v3.33.0 baseline](https://github.com/pponce/homebridge-roborock-matter-plus/blob/26344e27e113804c2cc393045aaf4127f688e2a5/validation-evidence/release.json)
- [Passing new tests](https://github.com/pponce/homebridge-roborock-matter-plus/blob/26344e27e113804c2cc393045aaf4127f688e2a5/validation-evidence/green.json)
- [Passing full suite](https://github.com/pponce/homebridge-roborock-matter-plus/blob/26344e27e113804c2cc393045aaf4127f688e2a5/validation-evidence/full.json)

Broker/decode boundaries are mocked and timers use a fake clock; no live account was used. Temporary validation workflow/evidence files are excluded from the source branch.

## Four-part series

1. Passive session instrumentation and diagnostics — #29.
2. **Use correlated silence to suppress incorrect breaker counts — this change.**
3. Opt-in bounded, single-flight session recreation; preventive refresh separately switchable.
4. Read-before-retry reconciliation for ambiguous schedule writes; independently reviewable.

[PR 2-only comparison](https://github.com/pponce/homebridge-roborock-matter-plus/compare/mqtt-session-instrumentation...mqtt-session-breaker)
