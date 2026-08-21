# Schedule Refresh & Recovery Plan

## Purpose

This is the working plan and continuity record for the clean implementation of schedule-switch refresh/recovery work on `homebridge-roborock-matter-plus`.

The implementation started fresh from `hap-schedules-scenes` and was then updated to Mathias's upstream 3.15.0 state. The older `schedule-coordinator-refresh-recovery` branch remains reference material only.

## Repository / Branch Context

- Repository: `pponce/homebridge-roborock-matter-plus`
- Starting point: `hap-schedules-scenes`
- Current working branch: `schedule-refresh-recovery-clean`
- Current upstream base incorporated: `v3.15.0` / `b850c17`
- GitHub branch: `https://github.com/pponce/homebridge-roborock-matter-plus/tree/schedule-refresh-recovery-clean`

## Scope

### Required from Mathias's comment

1. Make the release gate clean, including Prettier.
2. Remove the permanent three-minute schedule polling timer.
3. Use a per-vacuum cached schedule snapshot with an approximately 60-second lifetime.
4. Refresh schedules on HomeKit reads when the cache is stale.
5. Coalesce concurrent refreshes so simultaneous triggers result in one schedule cloud request.
6. One successful schedule snapshot synchronizes all schedule switches for that vacuum.
7. Preserve existing schedule write and approximately 3-second verification behavior.
8. Preserve stable schedule-ID identity and reconciliation behavior.

### Additional user requirement

Schedule switches are not gated on local/device reachability. If a known vacuum is unreachable but the Roborock cloud successfully returns valid schedules, those schedules can create/update the HAP switches. Failed/untrusted retrieval must not be treated as an empty schedule list, and must not remove existing schedule accessories.

## North Star Architecture

```text
Roborock cloud -> per-vacuum schedule coordinator -> cached snapshot (~60s)
                                             |
                              +--------------+--------------+
                              |              |              |
                         Schedule 1     Schedule 2     Schedule 3
                          HAP switch     HAP switch     HAP switch
```

Refresh triggers are:

1. Initial schedule discovery for a known/configured vacuum.
2. HomeKit GET when the cached snapshot is stale.
3. A user schedule write followed by the existing verification flow.
4. Other narrowly justified refresh requests that use the same coalescing coordinator.

There is **no permanent background three-minute schedule timer** and no independent reachability polling loop.

## Implementation Status

### Phase 0 — Clean baseline

- [x] Created `schedule-refresh-recovery-clean` from the HAP schedule-switch work.
- [x] Established GitHub branch as the source of truth.
- [x] Ran the baseline release gate.

### Phase 1 — Release gate

- [x] Lint/format cleanup.
- [x] Typecheck passes.
- [x] Build passes.
- [x] Full Jest suite passes.
- [x] Prettier check passes.
- [x] Generated `dist/` rebuilt and committed.

### Phase 2 — Cached refresh

- [x] Removed `SCHEDULE_POLL_INTERVAL_MS` and the permanent `setInterval` schedule poll.
- [x] One cached schedule snapshot per vacuum.
- [x] Approximately 60-second cache lifetime.
- [x] One in-flight refresh guard/promise per vacuum.
- [x] Stale HomeKit reads perform one `getServerTimers` / `get_server_timer` request.
- [x] One successful snapshot synchronizes all switches for that vacuum.
- [x] Fresh reads within the cache lifetime avoid another cloud request.

### Phase 3 — Reachability independence

- [x] Schedule discovery is not gated on local/device reachability.
- [x] Cloud schedule discovery remains usable for an unreachable known vacuum.
- [x] Successful cloud snapshots create/update schedule switches regardless of local reachability.
- [x] Failed initial discovery does not create a broken/empty schedule group.
- [x] No reachability polling loop was added.

### Phase 4 — Recovery/preservation

- [x] Existing schedule groups survive temporary vacuum unreachability.
- [x] Existing child switches survive failed schedule retrieval.
- [x] Failed retrieval never means “zero schedules.”
- [x] Successful empty snapshots may reconcile stale switches away.
- [x] Successful non-empty snapshots reconcile additions, updates, and deletions by stable schedule ID.

### Phase 5 — Command verification

- [x] Existing schedule write behavior preserved.
- [x] Existing delayed verification read preserved.
- [x] Verification cloud traffic is intentionally retained and is not background polling.

### Phase 6 — Tests

- [x] Fresh cache -> no additional cloud call.
- [x] Expired cache -> one cloud call.
- [x] Concurrent refreshes -> one in-flight cloud call.
- [x] One snapshot updates all switches.
- [x] Failed refreshes preserve existing schedule state.
- [x] Successful empty snapshots are distinguished from failed snapshots.
- [x] Stable schedule IDs preserve accessory identity.
- [x] Existing schedule write/verification tests pass.
- [x] Existing settings/UI contract tests pass.

### Phase 7 — Final release gate

- [x] Full typecheck.
- [x] Full build.
- [x] Full Jest suite.
- [x] Prettier.
- [x] No permanent schedule polling loop.
- [x] No independent reachability polling loop.
- [x] Failed schedule queries preserve existing accessories.
- [x] Generated `dist/` matches tested source.
- [x] Real Homebridge/HomeKit validation completed.

## Real-World Validation — 2026-08-20

The branch was installed on the real Homebridge instance and tested against the Roborock cloud and Apple Home.

Observed:

- Roborock schedule discovery returned authoritative arrays for both configured vacuums.
- Each successful snapshot was parsed and synchronized as one operation for that vacuum.
- A schedule switch was successfully disabled and re-enabled through HomeKit, producing the expected `upd_server_timer` commands.
- A later authoritative snapshot showed the changed state: schedule `1652749234966` was reported `off` after the disable test.
- Opening the Home app caused the stale schedule snapshot to refresh from Roborock and the updated schedule state to appear in HomeKit.
- Leaving the Home app closed did not produce continuous schedule refreshes. This confirms the removed permanent poll was not replaced by another periodic schedule poll.
- The observed refresh therefore matches the intended architecture: HomeKit reads trigger a refresh when the cache is stale; Roborock is authoritative; the returned snapshot synchronizes all switches.

Representative log sequence:

```text
22:17:29 Schedule command: disabling .../1652749234966
22:17:41 Schedule command: enabling .../1652749234966
...
22:35:29 Schedule discovery ... 1652749234966 ... "off"
22:35:29 Schedule sync ... received 7 parsed schedule(s)
```

## Upstream 3.15.0 Integration

The branch was updated to Mathias's latest 3.15.0 state and rebuilt.

Relevant commits:

- `b850c17` — Mathias upstream `v3.15.0`
- `c8c4d32` — merge upstream/main into `schedule-refresh-recovery-clean`
- `f072332` — rebuild committed `dist/` after the upstream merge

GitHub was verified at:

```text
f072332 (schedule-refresh-recovery-clean, origin/schedule-refresh-recovery-clean)
```

The fork's `main` branch is separately synchronized to Mathias 3.15.0:

```text
b850c17 (main, tag: v3.15.0, upstream/main, origin/main)
```

Thus:

- `main` = Mathias's latest 3.15.0 upstream state.
- `schedule-refresh-recovery-clean` = Mathias 3.15.0 + the HAP schedule-switch additions + our schedule refresh/recovery changes.

## What We Explicitly Did Not Do

- No permanent three-minute schedule polling.
- No substitute backoff timer.
- No independent reachability polling.
- No requirement for local reachability before cloud schedule discovery.
- No removal of schedule accessories solely because a vacuum is unreachable.
- No interpretation of failed cloud retrieval as an authoritative empty list.
- No unrelated Matter or shared-library redesign.
- No redesign of schedule command verification.

## Definition of Done

**Complete — 2026-08-20.**

The branch satisfies the intended Mathias schedule-refresh requirements and the explicit unreachable-vacuum requirement. The behavior was validated in the real Homebridge/HomeKit environment, and the branch contains Mathias's 3.15.0 changes on top of the HAP schedule-switch work.

No pull request is being created as part of this work. The branch is intentionally maintained as a directly installable/testable fork branch.

## Continuity Rule

Before making further functional changes, re-read this file and verify that the proposed change addresses a requirement above. If the requested behavior is already covered, prefer validation or a focused bug fix over adding another refresh mechanism.

### Final status

- Branch: `schedule-refresh-recovery-clean`
- Upstream baseline: `v3.15.0` (`b850c17`)
- Current branch tip: `f072332`
- Status: **Complete / ready for continued real-world testing**
