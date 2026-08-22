# Schedule Refresh & Recovery — Final Fixes Plan

## Purpose

This is the active plan for the final fixes after Mathias's latest review of `schedule-refresh-recovery-fixes`.

The goal is to fix **every remaining issue he raised**, including the smaller convention/style items, while preserving the recovery architecture that has already been reviewed and tested.

Historical records remain in:

- `SCHEDULE_REFRESH_RECOVERY_PLAN.md` — first-phase architecture and implementation record.
- `SCHEDULE_REFRESH_RECOVERY_FIXES_PLAN.md` — follow-up recovery implementation record through `schedule-refresh-recovery-fixes`.

This file is the active handoff for the final-fixes branch.

## Verified branch state

Repository: `pponce/homebridge-roborock-matter-plus`

- Base follow-up branch: `schedule-refresh-recovery-fixes`
- Final-fixes branch: `schedule-refresh-recovery-final-fixes`
- Final-fixes branch was created from commit `3e68ba7dd0126e01960503edee4a274575c77076`.
- The fork's `main` remains Mathias `v3.15.3`, commit `02cdd263aa55b703dd45da1ed4967d43b927b896`.
- Mathias's parent-project `upstream/main` is now **v3.15.5**, commit `141beae88b01bcd2433dc142e89fc87465221f91`.
- The parent-project merge was completed locally on 2026-08-22 as merge commit `3b2dffd`.
- The merge completed cleanly with the `ort` strategy; no manual conflict resolution was required.
- The merge brought 13 upstream files into the final-fixes branch, including the v3.15.5 version bump, CHANGELOG/README/test updates, and current parent-project library/accessory changes.

### Parent-project upstream check

Mathias's current parent-project `main` is **v3.15.5**, not v3.15.4.

The current upstream tip is `141beae88b01bcd2433dc142e89fc87465221f91`, and `package.json` reports version `3.15.5`.

The prior assumption that v3.15.4 was current was stale. The v3.15.5 upstream changes were therefore merged **before final schedule-fix implementation**, as required.

Do not manually copy unrelated parent-project changes when a normal Git merge can preserve provenance.

## Mathias's latest review — verified remaining work

Mathias said nine of the eleven larger items were already fixed correctly. The remaining substantive issues are:

1. **Transient refresh failure can delete schedule accessories.**
2. **`verify()` can join a refresh that started before the user write.**

He also requested three smaller cleanups:

3. **Failure-backoff logging should be `debug`, not `info`.**
4. **Remove the unused first `verify()` parameter.**
5. **Use `Model: "Schedules"` rather than `Model: "Roborock Schedules"`.**

He explicitly said the following are already correct and should remain unchanged:

- `removeHapScheduleAccessory()` disposal-before-unregister ordering.
- The double-unregister guard.
- `upd_timer` ordering.
- The non-empty/unparsable response safety check.
- The Q7 `get_server_timer` documentation comment.
- Deterministic schedule ordering.
- `ConfiguredName` preservation.
- Shared timer utility usage.
- Normal refresh coalescing.
- Display-name renumbering after a real deletion should be left alone.

## Architectural invariants

These must survive the final fixes:

- One cached schedule snapshot per vacuum.
- At most one normal in-flight schedule refresh per vacuum.
- HomeKit GET returns cached state immediately and refreshes asynchronously when stale.
- A successful snapshot synchronizes all schedule switches for that vacuum.
- A successful empty snapshot is authoritative and may remove stale schedules.
- A failed or untrusted snapshot is **never** interpreted as zero schedules.
- Temporary cloud/API failures preserve existing schedule accessories and HomeKit configuration.
- User schedule writes continue to use `upd_server_timer` followed by approximately three seconds of verification.
- Verification must use the coordinator's full-vacuum snapshot.
- No permanent schedule-specific polling loop.
- Local vacuum reachability and cloud schedule discovery remain separate concerns.

## Final fixes

### Fix 1 — Never unregister schedule accessories on refresh failure

Current regression in `src/platform.ts`:

```ts
.then((result) => {
  if (result.success && result.hasSchedules) {
    return;
  }
  this.removeHapScheduleAccessory(duid, accessory);
})
```

This treats `success: false` as if it were authoritative empty state. The coordinator explicitly returns failure while preserving existing schedules.

Required behavior:

```text
success: false -> preserve existing schedule accessory
success: true + schedules -> reconcile
success: true + no schedules -> authoritative empty; removal/reconciliation allowed
```

The `.catch()` path must obey the same preservation rule.

For an already-restored cached manager accessory whose child Switch services exist but whose coordinator map is empty, the failure path must also **reattach the schedule handlers** rather than leaving Homebridge serving the restored stored values without `onGet`/`onSet` handlers.

Preferred implementation direction:

- During coordinator initialization, when the refresh fails and the manager accessory already contains restored schedule Switch services, reconstruct the schedule IDs and current enabled values from those services and pass them through the normal `sync()` path.
- `sync()` then recreates the coordinator's child objects and attaches the normal GET/SET handlers.
- Do not unregister the restored accessory.
- Do not invent an empty cloud snapshot.
- A first-time accessory with no restored Switch services should remain unregistered until a later successful non-empty refresh.

### Fix 2 — Prevent a pre-write refresh from satisfying verification

Current race:

```text
stale cache
  -> refresh starts
  -> user writes schedule
  -> wait ~3 seconds
  -> verify joins the old refresh
  -> old pre-write snapshot can make a real successful write look like failure
```

Required behavior:

- Normal concurrent reads continue to coalesce.
- Verification may join an in-flight refresh only if that refresh started at or after the write.
- Verification must decline to join a refresh that started before the write.
- Verification still reads the complete schedule snapshot.
- A superseded older refresh must not overwrite a newer post-write refresh result.

Preferred implementation:

- Track the start time of the current in-flight refresh.
- Track the most recent refresh start time so an older refresh completion can be ignored once a newer refresh has started.
- Let `refreshAndGetSchedule(scheduleId, minimumRefreshStartedAt)` require a refresh whose start time is at least the supplied threshold.
- In `setSchedule`, capture the timestamp immediately before each actual schedule write and pass it to the corresponding verification call.
- Keep the approximately 3-second verification delay.

Do not restore the old direct `getServerTimers()` verification path; the coordinator remains the single schedule-refresh abstraction.

### Fix 3 — Failure-backoff logging to debug

Change the repeated `FAILURE BACKOFF` log in `refreshIfNeeded()` from `info` to `debug`.

Reason: during an outage every HomeKit read can hit the backoff branch, so `info` produces noise rather than useful operational signal.

### Fix 4 — Remove the unused `verify()` parameter

Change:

```ts
verify(_api, enabled)
```

to a signature that only accepts the data it actually needs for verification, including the write timestamp needed by Fix 2.

Update every call site. Let TypeScript catch any missed call.

### Fix 5 — Match the parent project's accessory model convention

Change:

```ts
Model: "Roborock Schedules"
```

to:

```ts
Model: "Schedules"
```

This keeps the accessory information row consistent with Mathias's current convention.

## Regression coverage

Focused tests must cover:

### Failure preservation

- Existing schedule manager + child switches survive a transient cloud failure.
- Existing schedule manager + child switches survive a rejected refresh path.
- Successful empty snapshot still permits normal stale-schedule removal.
- A first-time failed discovery does not register a broken/empty schedule accessory.
- A restored manager accessory with existing Switch services gets its GET/SET handlers reattached after failed initial cloud discovery.

### Verification race

- Start a stale refresh.
- Record a later write timestamp.
- Ask verification for the schedule after the three-second delay.
- Confirm verification starts a new refresh rather than joining the pre-write refresh.
- Resolve the newer refresh with the post-write state and confirm verification succeeds.
- Resolve the old pre-write refresh afterward and confirm it cannot overwrite the newer cached snapshot.
- Retain the existing normal coalescing test for concurrent non-write refreshes.

### Smaller fixes

- `FAILURE BACKOFF` is no longer logged at `info`.
- `verify()` no longer accepts an unused API parameter.
- Accessory model is `Schedules`.

## Shell / SSH lesson from the prior implementation

A previous remote diagnostic script caused the SSH session to terminate when a command failed. The exact historical command sequence should be verified before asserting a single root cause, but the operational lesson is clear:

- Prefer `bash ./script.sh` over `source ./script.sh` for diagnostic scripts.
- Treat `set -e` / `errexit` as a deliberate control-flow option, not harmless boilerplate.
- If a script is sourced into the interactive shell, `set -e` changes the **current shell's** failure behavior; an unhandled non-zero command can therefore terminate that shell.
- `set -e` by itself should **not normally log out an SSH session when the script is executed as a child process** (`bash ./script.sh`).
- Before blaming `set -e`, check whether the script was sourced or contained `exit`, `exec`, `logout`, SSH/session management, or another explicit termination path.
- For expected probe failures, use explicit handling such as `if ! command; then ... fi` or capture the status and continue.
- Avoid changing shell-wide options in reusable scripts that might be sourced.
- Large remote diagnostics should print the failing command, preserve the SSH connection, and return a non-zero script status instead of terminating the caller.

The final plan should record verified evidence about a future SSH disconnect rather than automatically attributing it to `set -e`.

## GitHub-first / local-second workflow

### GitHub completed

- [x] Confirmed `schedule-refresh-recovery-final-fixes` already exists.
- [x] Confirmed it starts from `schedule-refresh-recovery-fixes`.
- [x] Inspected both historical plan files.
- [x] Replaced the final-fixes handoff plan with this verified version.
- [x] Confirmed Mathias's current parent-project version is **v3.15.5**.
- [x] Confirmed upstream tip is `141beae88b01bcd2433dc142e89fc87465221f91`.

### Local completed

- [x] Fetched `origin` and `upstream`.
- [x] Checked out `schedule-refresh-recovery-final-fixes`.
- [x] Merged Mathias `upstream/main` / v3.15.5 locally.
- [x] Merge completed cleanly with no conflicts.
- [x] Merge commit is `3b2dffd`.
- [ ] Push the v3.15.5 merge commit to the GitHub final-fixes branch.
- [ ] Run the baseline release gate after the merge.
- [ ] Apply Fix 1 and its tests.
- [ ] Run focused tests.
- [ ] Apply Fix 2 and its race tests.
- [ ] Run focused tests.
- [ ] Apply Fixes 3–5 and corresponding contract assertions.
- [ ] Run the full release gate.
- [ ] Rebuild/commit `dist/` according to repository conventions.
- [ ] Push the exact tested branch to GitHub.
- [ ] Compare the final branch against the pre-fix branch and the parent `main`.
- [ ] Install the exact pushed branch on the real Homebridge host.
- [ ] Run controlled failure/recovery and write/verify tests on the real installation.
- [ ] Record final test counts and commit SHAs here.

## Release gate

Use the repository's canonical commands, including all of:

```bash
tsc --noEmit -p tsconfig.json
tsc -p tsconfig.roborockLib.json
rimraf ./dist && tsc
jest
prettier --check .
```

Definition of done also requires:

- No transient refresh failure can unregister an existing schedule accessory.
- Restored schedule Switch services have handlers after failed startup discovery.
- A pre-write refresh cannot satisfy post-write verification.
- An older superseded refresh cannot overwrite a newer refresh snapshot.
- Failure-backoff logging is debug-level.
- `verify()` has no unused API parameter.
- Model is `Schedules`.
- `dist/` reflects the tested source.
- Real-device recovery behavior is checked where practical.

## Current status — 2026-08-22

**Branch state:** Mathias v3.15.5 has now been merged cleanly into `schedule-refresh-recovery-final-fixes` locally as `3b2dffd`.

**Functional final fixes:** not yet applied.

**Next concrete action:** push the clean v3.15.5 merge to GitHub, then run the baseline release gate before changing schedule code. After the baseline is recorded, implement Fix 1 first because it protects existing HomeKit configuration from destructive failure handling. Then implement Fix 2, followed by the three minor cleanups and their focused tests. Update this plan after each checkpoint.
