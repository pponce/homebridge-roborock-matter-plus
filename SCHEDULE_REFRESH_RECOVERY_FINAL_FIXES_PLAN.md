# Schedule Refresh & Recovery — Final Fixes Plan

## Purpose

This is the active plan for the final round of schedule-refresh/recovery fixes after Mathias's latest review of `schedule-refresh-recovery-fixes`.

The goal is to fix **all** issues he raised, including the smaller convention/style items, while preserving the architecture that already passed the larger recovery review.

This file is the active plan for this branch. The earlier plan files remain historical records:

- `SCHEDULE_REFRESH_RECOVERY_PLAN.md` — historical first-phase architecture and implementation record.
- `SCHEDULE_REFRESH_RECOVERY_FIXES_PLAN.md` — historical follow-up implementation record through `schedule-refresh-recovery-fixes`.
- This file supersedes neither of those files; it is the focused final-fixes handoff.

## Review source

Mathias's latest review is on:

- Upstream issue: `https://github.com/mathiashornbek/homebridge-roborock-matter/issues/3`
- Latest review comment: `issuecomment-5377853659`

Mathias explicitly said that the prior branch fixed nine of the eleven larger items correctly, and that the remaining work is:

1. A regression in the failure/removal path that deletes schedule accessories after transient cloud failures.
2. A real verify/refresh race caused by joining an in-flight refresh that started before a user write.
3. Three smaller cleanup items: failure-backoff logging level, removal of the unused `verify()` API parameter, and the `Model` value convention.

He also explicitly said the existing deterministic ordering is good enough and should be left alone.

## Branch and upstream baseline

- Repository: `pponce/homebridge-roborock-matter-plus`
- Starting branch: `schedule-refresh-recovery-fixes`
- New branch: `schedule-refresh-recovery-final-fixes`
- Current starting commit: `3e68ba7dd0126e01960503edee4a274575c77076`
- Fork `main` baseline: Mathias `v3.15.3`, commit `02cdd263aa55b703dd45da1ed4967d43b927b896`
- Upstream Mathias `main`: commit `141beae88b01bcd2433dc142e89fc87465221f91` (`v3.15.4`)

### Required upstream sync

The new branch must include the latest upstream changes from Mathias before functional work continues.

The upstream `v3.15.4` commit is a documentation/test-only change to the parent project, including the revised Apple Home troubleshooting ladder and the updated automated-test count. It should be brought into this branch rather than allowing the final fixes to land on the older `v3.15.3` baseline.

The cleanest approach is to do the actual Git merge locally after fetching:

```bash
git fetch upstream
```

Then merge Mathias's current `upstream/main` into this branch, resolve only genuine conflicts, run the release gate, and push the merge result back to GitHub.

Do not copy unrelated parent-project behavior changes by hand when a normal merge can preserve provenance.

## Historical lessons from the previous two plans

The previous plans establish several practices that should continue here.

### Architecture rules

- There is one cached schedule snapshot per vacuum.
- There is at most one in-flight schedule refresh per vacuum; concurrent refresh requests coalesce.
- HomeKit reads must return the current cached value immediately.
- Stale reads may trigger an asynchronous refresh.
- A successful schedule snapshot synchronizes all schedule switches for that vacuum.
- A successful empty schedule snapshot is authoritative.
- A failed or untrusted response is **not** an empty schedule list.
- Temporary cloud/API/reachability failures must preserve existing schedule accessories.
- User schedule writes still use the existing write + approximately 3-second verification behavior.
- There must be no permanent schedule-specific polling loop.
- Local vacuum reachability and cloud schedule discovery remain separate concerns.

### Review discipline

- Treat GitHub as the source of truth for branch history.
- Keep each functional change narrowly scoped and reviewable.
- Before changing code, inspect the current implementation and the historical plan rather than assuming the old failure mode still exists.
- Prefer the smallest fix that directly establishes the invariant Mathias is asking for.
- Add regression coverage for every changed behavior that could regress again.
- Do not weaken tests simply to make the gate green.
- Do not rely on one aggregate full-suite result; run focused tests for the modified behavior first.
- Finish with the full repository gate: typecheck, build, Jest, and Prettier.
- Rebuild and commit `dist/` when repository conventions require it.
- Test the exact pushed branch on the real Homebridge installation only after the source and generated output are green.

## Important shell / SSH lesson

During the first implementation phase, a diagnostic script caused the SSH session to terminate after a command failed. The exact historical command sequence should be verified locally before making a stronger claim, but the important lesson is:

### Do not run state-changing scripts by sourcing them into the current SSH shell

A script containing `set -e` / `errexit` is safe when run as a child process with:

```bash
bash ./script.sh
```

but it is risky when run with:

```bash
source ./script.sh
# or
. ./script.sh
```

because `set -e` then changes the **current interactive shell's** error behavior. An unhandled non-zero command can therefore terminate the controlling shell in situations where the same script, run as a child process, would simply exit the script.

Also avoid putting `exit`, `exec`, `logout`, or SSH-session management commands inside reusable diagnostic scripts unless they are explicitly intended to terminate the caller.

For scripts used over SSH:

- Prefer `bash ./script.sh` over `source ./script.sh`.
- Treat `set -e` as a deliberate control-flow choice, not harmless boilerplate.
- For expected probe failures, use explicit handling such as `if ! command; then ... fi` rather than letting `errexit` decide what happens.
- If a command is expected to fail while diagnostics continue, capture its status explicitly.
- Avoid changing shell-wide options in a script that might be sourced.
- Before running a large remote script, make it fail-safe: print the failing command, preserve the SSH connection, and return a non-zero status from the script rather than terminating the parent shell.

Important nuance: **`set -e` by itself should not normally log out an SSH session when the script is executed as `bash ./script.sh`**. If SSH was actually disconnected, investigate whether the script was sourced or contained an explicit shell/session termination path. We should record the verified cause rather than attributing every disconnect to `set -e`.

## Final-fix objectives

### Fix 1 — Never unregister schedule accessories on a transient refresh failure

**Problem**

`platform.ts` currently treats a failed refresh as if it were an authoritative empty result in the failure/removal path. The problematic shape is effectively:

```ts
.then((result) => {
  if (result.success && result.hasSchedules) {
    return;
  }

  this.removeHapScheduleAccessory(duid, accessory);
})
```

This is wrong because `success: false` is explicitly used by the coordinator for failed cloud/API reads, and the coordinator's failure result is intended to preserve existing schedules.

Calling `removeHapScheduleAccessory()` unregisters the accessory from HomeKit. That destroys user-facing HomeKit state such as room assignment, custom naming, scenes, and automations.

**Required invariant**

- Failed refresh -> preserve existing schedule accessories.
- Untrusted refresh -> preserve existing schedule accessories.
- Successful empty snapshot -> removal/reconciliation is allowed.
- Successful non-empty snapshot -> reconcile by stable schedule ID.

The platform must therefore distinguish **failure** from **authoritative empty**.

**Implementation direction**

Restore the semantic guard so removal happens only for trustworthy empty results. The exact condition should be derived from the current code rather than copied blindly from the review comment, but the key property is:

```text
success == false  -> never unregister existing schedule accessories
```

The `.catch()` path must obey the same rule.

Do not change `removeHapScheduleAccessory()` itself unless testing demonstrates a separate defect. Mathias explicitly reviewed that helper and found its disposal/unregister ordering correct.

**Tests**

Add or update regressions proving:

- Existing schedule group survives a transient cloud failure.
- Existing child schedule switches survive a transient cloud failure.
- `.catch()` failure also preserves them.
- A successful empty snapshot still removes stale schedule accessories.
- A successful non-empty snapshot still reconciles additions/updates/deletions.

### Fix 2 — Prevent `verify()` from joining a refresh that started before the write

**Problem**

The shared coordinator is correctly used by normal refreshes and by verification, but the coalescer currently returns the existing in-flight promise unconditionally:

```ts
if (this.refreshInProgress) {
  return this.refreshInProgress;
}
```

That is unsafe for write verification.

Sequence:

```text
HomeKit write
    |
    v
Roborock upd_server_timer write
    |
    v
wait ~3 seconds
    |
    v
verify()
    |
    +--> refresh already started BEFORE the write
             |
             v
         old snapshot satisfies verify
             |
             v
         verify may report failure and revert a write that actually succeeded
```

This is a real race when the cache is stale and the Home app generates a refresh immediately before the user toggles a schedule.

**Required invariant**

A verification refresh must not be satisfied by a refresh that began before the user write.

**Preferred implementation direction**

Track the start time of the in-flight refresh, for example:

```ts
refreshStartedAt: number | undefined
```

and compare it with the write time recorded by `setSchedule`.

Possible API shapes:

- Add a `force`/`minStartedAt` option to `refreshDetailed()`.
- Or make `refreshAndGetSchedule` explicitly decline an in-flight refresh that predates the write.

Do **not** simply remove coalescing and return to an independent direct cloud request. The goal is to preserve coalescing for normal refreshes while preventing stale pre-write refreshes from satisfying post-write verification.

**Required behavior**

- Normal concurrent reads still coalesce.
- A verification refresh that began after the write may be joined.
- A verification refresh that began before the write must not satisfy the verification.
- Verification should still read the complete fresh snapshot for the vacuum.
- The cache timestamp must represent the snapshot that was actually obtained after the write.

**Tests**

Add explicit race coverage for:

1. stale cache -> refresh starts;
2. schedule write occurs while that refresh is in flight;
3. verification delay expires;
4. verification must not accept the pre-write refresh;
5. a fresh post-write refresh resolves verification correctly.

Also retain the existing tests proving normal concurrent refresh coalescing.

### Fix 3 — Failure-backoff logging should be debug, not info

**Problem**

`refreshIfNeeded()` logs the failure-backoff path at `info`. During an outage, every HomeKit read can therefore produce another normal log line for the same condition.

**Required change**

Move the repeated `FAILURE BACKOFF` branch to `debug`, or otherwise throttle it. The preferred simple fix is `debug` if no operational signal is lost.

**Tests**

Update the focused logging contract so routine backoff behavior is not asserted at `info`.

### Fix 4 — Remove the unused parameter from `verify()`

**Problem**

`verify(_api, enabled)` no longer uses its first parameter.

**Required change**

Remove the unused parameter and update the call site(s).

Do not preserve a dead API parameter merely for historical symmetry.

**Tests**

The TypeScript compiler should catch missed call sites. Add a focused test only if the signature participates in mocked/public behavior where the typecheck is insufficient.

### Fix 5 — Match the parent project's `Model` convention

**Problem**

`initialize()` currently publishes:

```ts
Manufacturer: "Roborock"
Model: "Roborock Schedules"
```

Mathias has changed the parent plugin convention so the row reads `"Schedules"` rather than duplicating the manufacturer name.

**Required change**

Use:

```ts
Model: "Schedules"
```

This is a convention/alignment change, not a functional redesign.

**Tests**

Add/update the accessory identity assertion so the expected model is explicit.

## Explicit non-work from this review

The following are already correct and should not be reopened without evidence:

- The `removeHapScheduleAccessory` helper's disposal-before-unregister ordering.
- The guard that avoids double unregistering an accessory not present in `this.accessories`.
- `upd_timer` ordering.
- The non-empty + zero-parsed-schedule untrusted-response check.
- The Q7 `b01Q7Adapter` comment.
- Deterministic schedule ordering.
- `ConfiguredName` preservation.
- Shared timer usage.
- The existing coalescing design for normal refreshes.

The deletion/renumbering behavior of display names may still renumber `Schedule ${i + 1}` after a real schedule deletion. Mathias explicitly said to leave this: deterministic ordering plus preserved `ConfiguredName` is the important guarantee.

## GitHub-first / local-second workflow for this phase

### GitHub actions already completed

- [x] Created `schedule-refresh-recovery-final-fixes` from `schedule-refresh-recovery-fixes`.
- [x] Added this plan to the new branch.
- [ ] Bring upstream Mathias `main` (`141beae...`, v3.15.4) into the branch with a true Git merge locally.

### Local work sequence

1. Fetch the repository and upstream refs.
2. Check out `schedule-refresh-recovery-final-fixes`.
3. Verify the working tree is clean before any merge.
4. Merge `upstream/main` into the new branch.
5. Resolve only real conflicts; do not rewrite unrelated upstream changes.
6. Run the baseline release gate after the merge.
7. Implement each final fix as a focused commit.
8. Run targeted tests after each behavior change.
9. Run the full gate before pushing.
10. Push the branch to GitHub.
11. Compare the pushed branch against both the pre-fix branch and upstream `main`.
12. Install the exact pushed branch on the real Homebridge host only after the source/gate is green.
13. Run controlled recovery tests without changing unrelated Homebridge configuration.
14. Record exact test counts and important observations back into this plan.

## Suggested focused commit sequence

1. `Merge upstream v3.15.4`
2. `Preserve schedule accessories on refresh failure`
3. `Prevent pre-write refresh from satisfying schedule verification`
4. `Clean up schedule recovery logging and verify API`
5. `Match upstream schedule accessory identity convention`
6. `Add regression coverage for final schedule fixes`

The actual grouping can differ if tests or conflicts make a better review boundary, but every commit should remain understandable on its own.

## Release gate

The final branch is not done until all of these are green:

```bash
tsc --noEmit -p tsconfig.json
tsc -p tsconfig.roborockLib.json
rimraf ./dist && tsc
jest
prettier --check .
```

If the repository wraps these commands in an existing gate script, use the canonical repository command instead.

Also confirm:

- `dist/` matches the tested source.
- No permanent schedule-specific polling loop exists.
- A transient cloud failure cannot unregister existing schedule accessories.
- A pre-write in-flight refresh cannot satisfy post-write verification.
- No routine backoff message is emitted at `info`.
- `verify()` has no unused first parameter.
- Schedule accessory model is `Schedules`.

## Real-device validation

After the local gate is green and the exact branch is pushed:

- Validate that an existing schedule tile survives a controlled cloud/transport failure.
- Validate that a recovered cloud snapshot restores/synchronizes the schedule state.
- Validate that a schedule write followed by verification succeeds when another refresh was already in flight before the write.
- Validate that HomeKit reads remain responsive even if the cloud request is slow, since GET now returns the cached state immediately.
- Do not use destructive re-pairing as a routine test method.
- Preserve user HomeKit room/name/automation state throughout the test.

## Definition of done

This phase is complete when:

- [ ] Upstream `v3.15.4` is merged into the branch.
- [ ] The transient failure/removal regression is fixed and covered by tests.
- [ ] The pre-write verification race is fixed and covered by tests.
- [ ] Failure-backoff logging is at the correct level.
- [ ] The unused `verify()` parameter is removed.
- [ ] `Model` matches the parent convention (`Schedules`).
- [ ] The full release gate passes.
- [ ] Real-device recovery/verification behavior is checked where practical.
- [ ] `dist/` is current.
- [ ] The final commit SHAs and test counts are recorded here.

## Current status

**As of 2026-08-22:** branch created on GitHub; plan committed. No functional fixes have been applied on this final-fixes branch yet.

Next action: synchronize the local checkout to `schedule-refresh-recovery-final-fixes`, merge Mathias's latest upstream `main`, verify the post-merge baseline, and then implement Fix 1 first because it prevents destructive accessory loss.