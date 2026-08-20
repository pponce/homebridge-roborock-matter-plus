# Schedule Refresh & Recovery Plan

## Purpose

This is the working plan and continuity record for the clean implementation of schedule-switch refresh/recovery work on `homebridge-roborock-matter-plus`.

The implementation starts **fresh from `hap-schedules-scenes`** and does not carry forward source changes from the previous `schedule-coordinator-refresh-recovery` branch. That older branch is reference material only.

## Repository / Branch Context

- Repository: `pponce/homebridge-roborock-matter-plus`
- Starting point: `hap-schedules-scenes`
- Current working branch: `schedule-refresh-recovery-clean`
- Base commit: `20ae39d6d7f0fbf5fb7619d1a40b42413df803cc`
- GitHub branch: `https://github.com/pponce/homebridge-roborock-matter-plus/tree/schedule-refresh-recovery-clean`

The purpose of this branch is to make the smallest, reviewable changes needed to address Mathias's comment while adding one narrowly defined user requirement.

## Source of Truth / Development Workflow

GitHub is the source of truth for the branch.

Recommended workflow:

1. Keep the local checkout synchronized with `origin/schedule-refresh-recovery-clean` before local work.
2. Make one focused functional change at a time.
3. Run targeted tests after each functional change.
4. Push the tested source change to the branch.
5. Let the repository's existing workflow regenerate and commit `dist/` where appropriate.
6. Re-read this plan before the next functional step.
7. Keep commits small enough that each one has one understandable purpose.

Do not use the previous `schedule-coordinator-refresh-recovery` implementation as a base. Inspect it only when it provides useful evidence about a prior failure or design idea.

## Scope

### Required from Mathias's comment

1. Make the release gate clean, including Prettier.
2. Remove the permanent three-minute schedule polling timer.
3. Use a per-vacuum cached schedule snapshot with an approximately 60-second lifetime.
4. Refresh schedules on HomeKit reads when the cache is stale.
5. Coalesce concurrent refreshes so multiple simultaneous refresh triggers result in one schedule cloud request.
6. One successful schedule snapshot must synchronize all schedule switches for that vacuum.
7. Preserve the existing schedule write and verification behavior. A user-initiated write followed by the approximately 3-second verification is legitimate cloud traffic and is not the background polling being removed.
8. Preserve stable schedule-ID identity and existing reconciliation behavior wherever possible.

### Additional user requirement

The schedule switches should **not be gated on local/device reachability**.

The desired behavior is:

> If a configured/known vacuum is currently unreachable but the Roborock cloud can successfully return its schedules, create the schedule switches from that successful cloud snapshot anyway.

Therefore:

- **Do create** schedule switches for a currently unreachable vacuum when `get_server_timer` / `getServerTimers` succeeds and returns valid schedules.
- **Do not require** a local reachable state before attempting schedule discovery.
- If schedule discovery fails because the cloud/API request fails or cannot be trusted, do not invent an empty schedule set and do not create a broken schedule group solely from the failure.
- If switches already exist, keep them when the vacuum becomes unreachable.
- A temporary reachability problem must never by itself remove an existing schedule group or child schedule switches.
- Only a **successful** schedule snapshot should drive removal of a schedule switch, and only when that snapshot proves the schedule ID no longer exists.

This replaces the earlier idea of waiting for an `unavailable -> reachable` transition before creating a first-time schedule group. We should not add a reachability transition hook solely for initial schedule creation unless investigation shows that cloud schedule discovery genuinely cannot work for an unreachable vacuum.

## North Star Architecture

```text
                 Roborock cloud
                       |
                       | getServerTimers (cloud preferred)
                       v
              +--------------------+
              | Schedule Coordinator|
              |     per vacuum      |
              +----------+----------+
                         |
                  cached snapshot
                    (~60 seconds)
                         |
             +-----------+-----------+
             |           |           |
             v           v           v
         Schedule 1  Schedule 2  Schedule 3
          HAP switch  HAP switch  HAP switch
```

Refresh triggers are:

1. Initial schedule discovery for a known/configured vacuum.
2. HomeKit GET when the cached snapshot is stale.
3. A user schedule write followed by the existing verification flow.
4. Any other narrowly justified refresh request that can coalesce through the same coordinator.

There is **no permanent background three-minute schedule timer**.

Reachability is not itself a prerequisite for cloud schedule discovery.

## Desired State Semantics

The implementation must distinguish three fundamentally different states:

### 1. Successful non-empty schedule snapshot

```text
SUCCESS + schedules = [...]
```

Use it to create/update/reconcile schedule switches.

### 2. Successful empty schedule snapshot

```text
SUCCESS + schedules = []
```

This is trustworthy information. It means the cloud successfully told us that the vacuum currently has no schedules. Existing schedule switches may therefore be reconciled away as appropriate.

### 3. Failed/untrusted schedule retrieval

```text
FAILED / timeout / malformed / unavailable
```

Do **not** interpret this as zero schedules.

Preserve existing schedule accessories and switches.

This distinction is important because the Roborock cloud itself can be the flaky component.

## Important Cloud-vs-Reachability Principle

Local reachability and cloud schedule availability are separate concepts.

The schedule-discovery rule is:

```text
Known/configured vacuum
        |
        v
Attempt cloud schedule snapshot
        |
        +---- success ----> synchronize/create switches
        |
        +---- failure ----> preserve existing state / retry on a later legitimate refresh
```

Not:

```text
Vacuum unreachable -> never query cloud
```

The HAP schedule switch only needs the schedule ID, enabled state, and timer data. It does not need a local vacuum connection merely to exist in HomeKit.

## Existing Behavior to Preserve

Do not unnecessarily redesign or modify:

- existing Matter vacuum behavior;
- existing `roborockLib` behavior;
- existing UI/config behavior;
- existing command suppression behavior;
- existing schedule write/verification behavior;
- existing stable schedule-ID identity/reconciliation behavior;
- the opt-in nature of HAP schedule switches;
- the committed `dist/` package output arrangement.

## Implementation Phases

### Phase 0 — Clean baseline

- [x] Create `schedule-refresh-recovery-clean` from the exact `hap-schedules-scenes` commit.
- [x] Record the starting commit in this plan.
- [x] Verify local checkout is clean and synchronized with the new branch.
- [x] Run the baseline release gate before functional changes.

### Phase 1 — Make the release gate clean

Before or during the first implementation pass:

- [x] Run `npm run lint:fix`.
- [x] Verify typecheck:
      `tsc --noEmit -p tsconfig.json && tsc -p tsconfig.roborockLib.json`
- [x] Verify build:
      `rimraf ./dist && tsc`
- [x] Verify tests:
      `jest`
- [x] Verify formatting:
      `prettier --check .`
- [ ] Keep `dist/` committed and generated from source.

Do not treat a green Jest run as sufficient. Mathias's release gate is the definition of done.

### Phase 2 — Replace permanent polling with cached refresh

Implement the smallest coordinator-level change that achieves:

- [ ] Remove `SCHEDULE_POLL_INTERVAL_MS` and the permanent `setInterval` polling loop.
- [ ] Maintain one cached schedule snapshot per vacuum/coordinator.
- [ ] Maintain a timestamp for the cached snapshot.
- [ ] Use approximately 60 seconds as the cache lifetime.
- [ ] Add/retain a single in-flight refresh guard/promise so concurrent callers coalesce into one cloud request.
- [ ] On a stale HomeKit GET, perform one `getServerTimers` / `get_server_timer` request and synchronize all switches from that snapshot.
- [ ] Fresh reads within the cache lifetime must not make another schedule cloud request.
- [ ] Do not create one cache per individual schedule switch.

### Phase 3 — Make schedule discovery independent of local reachability

Inspect the existing startup/discovery lifecycle and adjust it so that:

- [ ] Known/configured vacuums are eligible for schedule discovery even when their local/device state is currently unreachable.
- [ ] The schedule API continues to prefer cloud for this operation.
- [ ] If the cloud returns a successful valid schedule snapshot, create/update the schedule group and child switches regardless of local reachability.
- [ ] If the first schedule query fails, do not create a broken/empty schedule group merely because the vacuum is known.
- [ ] A later legitimate refresh can create the schedule group without requiring a Homebridge restart if the cloud becomes available.

Do **not** introduce a periodic reachability poll just to accomplish this.

### Phase 4 — Preserve accessories across connectivity loss

Make the lifecycle explicit and test it:

- [ ] Existing schedule groups remain registered when a vacuum becomes unreachable.
- [ ] Existing child schedule switches remain registered when a vacuum becomes unreachable.
- [ ] Failed schedule queries never cause an existing group to be removed.
- [ ] Failed schedule queries never cause existing switches to be interpreted as deleted schedules.
- [ ] A successful empty schedule snapshot may legitimately remove stale schedule switches because it is trustworthy.
- [ ] A successful non-empty snapshot reconciles additions, updates, and deletions by stable schedule ID.

### Phase 5 — Preserve command verification

Leave the existing user-command flow intact unless a test demonstrates that the new coordinator requires a narrowly scoped change:

```text
HomeKit schedule switch write
        |
        v
upd_server_timer
        |
        v
wait ~3 seconds
        |
        v
getServerTimers verification
        |
        v
update local schedule snapshot/state
```

The verification cloud read is intentionally retained. It is not background polling.

### Phase 6 — Tests

Add or update tests for the actual requirements:

#### Refresh/cache

- [ ] Fresh cache -> no additional schedule cloud call.
- [ ] Expired cache -> exactly one schedule cloud call.
- [ ] Multiple simultaneous refresh requests -> one in-flight schedule cloud call.
- [ ] One successful snapshot updates all switches.

#### Unreachable vacuum

- [ ] Known/configured vacuum is unreachable but cloud schedule query succeeds -> switches are created.
- [ ] Known/configured vacuum is unreachable and schedule query fails -> no broken/empty schedule group is created.
- [ ] Existing schedule group + vacuum becomes unreachable -> group remains.
- [ ] Existing switches + schedule request failure -> switches remain.
- [ ] Later successful schedule refresh after a previous failure -> missing schedule group/switches can be created without reboot.

#### Reconciliation

- [ ] Successful snapshot adds a new schedule -> new switch created.
- [ ] Successful snapshot updates an existing schedule -> existing switch identity preserved by schedule ID.
- [ ] Successful snapshot removes a schedule -> corresponding switch removed.
- [ ] Successful empty snapshot -> existing schedule switches reconciled appropriately.
- [ ] Failed/malformed snapshot -> no schedule switches removed.
- [ ] Reordering schedules -> stable schedule IDs retain their accessory identity.

#### Existing behavior

- [ ] Existing schedule write + verification behavior remains passing.
- [ ] Existing schedule settings/UI contract tests remain passing.

### Phase 7 — Release gate and review artifact

- [ ] Full typecheck passes.
- [ ] Full build passes.
- [ ] Full Jest suite passes.
- [ ] Prettier check passes.
- [ ] Review the complete diff against `hap-schedules-scenes`.
- [ ] Confirm there is no permanent schedule polling loop.
- [ ] Confirm there is no new independent reachability polling loop.
- [ ] Confirm failed schedule queries preserve existing accessories.
- [ ] Confirm the only functional scope is schedule refresh/reconciliation and the explicit unreachable-vacuum creation/persistence requirement.
- [ ] Ensure generated `dist/` matches the tested source.
- [ ] Record final test counts and relevant commit SHAs in this plan.

## Commit Strategy

Use small focused commits, preferably along these lines:

1. `Fix schedule branch formatting`
2. `Replace permanent schedule polling with cached refresh`
3. `Add schedule refresh/cache tests`
4. `Allow cloud schedule discovery independent of local reachability`
5. `Preserve schedule accessories across transient connectivity failures`
6. `Add/finish regression tests and release-gate cleanup`

Do not combine unrelated refactors into these commits.

## What We Are Explicitly Not Doing

- No permanent three-minute schedule polling.
- No exponential-backoff timer as a substitute for polling.
- No independent polling loop whose sole purpose is to detect vacuum reachability.
- No requirement that the vacuum be locally reachable before querying cloud schedules.
- No removal of existing schedule accessories solely because a vacuum is unreachable.
- No treating a failed schedule cloud request as an authoritative empty schedule list.
- No unrelated changes to Matter behavior or the shared Roborock library.
- No redesign of the existing schedule command verification unless required by a failing regression test.

## Continuity Rule

Before each new functional change, re-read this file and verify that the proposed change advances one of the checked/unchecked requirements above.

If a proposed change does not clearly map to this plan, stop and explain why it is necessary before adding it.

## Current Status

### Last update

2026-08-20

### Current branch

`schedule-refresh-recovery-clean`

### Current implementation phase

**Phase 1 baseline complete.** The clean branch has passed the full baseline release gate before functional changes:

- 75 test suites passed
- 1,120 tests passed
- typecheck passed
- build passed
- Prettier passed
- `npm run lint:fix` completed successfully

No functional schedule changes have been made yet.

### Next step

Synchronize the local checkout to `schedule-refresh-recovery-clean`, run the baseline release gate, and then inspect the current schedule discovery/refresh code to identify the smallest implementation for Phase 2 without importing the previous recovery branch's source changes.
