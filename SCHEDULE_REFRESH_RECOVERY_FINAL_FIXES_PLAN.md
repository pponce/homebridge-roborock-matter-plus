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
- The parent-project merge was completed locally on 2026-08-22 as merge commit `3b2dffd`, then rebased onto the updated GitHub plan checkpoint as `72cf81c` and pushed to `origin/schedule-refresh-recovery-final-fixes`.
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
verify(_api, enabled);
```

to a signature that only accepts the data it actually needs for verification, including the write timestamp needed by Fix 2.

Update every call site. Let TypeScript catch any missed call.

### Fix 5 — Match the parent project's accessory model convention

Change:

```ts
Model: "Roborock Schedules";
```

to:

```ts
Model: "Schedules";
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

## Bash command / output-collection convention

For every shell command block provided to the user in this project, use a consistent copy/paste boundary so it is obvious exactly what output should be returned.

Required pattern:

```bash

echo "============================================================"
echo "START COPY HERE"
echo "============================================================"

# commands and diagnostics

echo
echo "============================================================"
echo "END COPY HERE"
echo "============================================================"
```

Do not make the user guess where to start or stop copying. Include a blank line before the start marker and another blank line before the end marker.

Prefer grouped diagnostic sections with clear `echo "===== SECTION NAME ====="` headings. Avoid `set -e` in interactive diagnostic commands unless there is a specific reason and the failure semantics are explicitly intended. When a command may legitimately fail, handle that status explicitly so the user can still return the complete diagnostic output.

This convention applies both to short one-off commands and to longer multi-step scripts.

## Baseline checkpoint — 2026-08-22

The post-v3.15.5-merge baseline is now established using the repository's pinned local toolchain (`TypeScript 5.5.3`, `Jest 30.4.2`, `Prettier 3.3.2`, `Rimraf 6.0.1`).

Results:

- Main TypeScript typecheck: **passed** (`0`).
- Roborock library TypeScript typecheck: **passed** (`0`).
- Jest: **86/86 suites passed; 1,370/1,370 tests passed**.
- Build: **passed** (`0`).
- Prettier: **failed only because this active plan file itself was not yet formatted**.
- The failed earlier build attempt using global TypeScript 7 was an environment/tool-version problem, not a project-source failure, and the tracked `dist/` output was restored before the real baseline.
- The successful baseline build regenerated `dist/matter_vacuum_accessory.js(.map)` and `dist/platform.js(.map)` from the v3.15.5 source merge. These generated changes need to be retained/committed as appropriate for the tested branch.

The baseline therefore shows **no functional/test/typecheck regression attributable to the final-fixes branch**.

## GitHub-first / local-second workflow

### GitHub completed

- [x] Confirmed `schedule-refresh-recovery-final-fixes` already exists.
- [x] Confirmed it starts from `schedule-refresh-recovery-fixes`.
- [x] Inspected both historical plan files.
- [x] Replaced the final-fixes handoff plan with this verified version.
- [x] Confirmed Mathias's current parent-project version is **v3.15.5**.
- [x] Confirmed upstream tip is `141beae88b01bcd2433dc142e89fc87465221f91`.
- [x] Recorded the user's preferred bash-output copy/paste boundary convention in this plan.

### Local completed

- [x] Fetched `origin` and `upstream`.
- [x] Checked out `schedule-refresh-recovery-final-fixes`.
- [x] Merged Mathias `upstream/main` / v3.15.5 locally.
- [x] Merge completed cleanly with no conflicts.
- [x] Rebased the local merge onto the updated GitHub plan checkpoint.
- [x] Pushed synchronized v3.15.5 branch to GitHub as `72cf81c`.
- [x] Verified repository-local toolchain versions.
- [x] Restored tracked `dist/` after the intentionally failed global-tool build attempt.
- [x] Ran the real baseline typechecks, Jest suite, Prettier check, and build using repository-local tools.
- [ ] Format the active plan file with repository Prettier and commit the formatting fix.
- [ ] Commit the v3.15.5-generated `dist/` updates produced by the successful baseline build.
- [ ] Apply Fix 1 and its tests.
- [ ] Run focused tests.
- [ ] Apply Fix 2 and its race tests.
- [ ] Run focused tests.
- [ ] Apply Fixes 3–5 and corresponding contract assertions.
- [ ] Run the full release gate.
- [ ] Push the exact tested branch to GitHub.
- [ ] Compare the final branch against the pre-fix branch and the parent `main`.
- [ ] Install the exact pushed branch on the real Homebridge host.
- [ ] Run controlled failure/recovery and write/verify tests on the real installation.
- [ ] Record final test counts and commit SHAs here.

## Release gate

Use the repository's canonical commands, including all of:

```bash
./node_modules/.bin/tsc --noEmit -p tsconfig.json
./node_modules/.bin/tsc --noEmit -p tsconfig.roborockLib.json
./node_modules/.bin/rimraf ./dist && ./node_modules/.bin/tsc
npm test
./node_modules/.bin/prettier --check .
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

**Branch state:** Mathias v3.15.5 has been merged cleanly into `schedule-refresh-recovery-final-fixes` and pushed to GitHub as `72cf81c`.

**Baseline:** **86/86 suites and 1,370/1,370 tests pass; both typechecks and build pass.** Prettier currently fails only because this active plan file itself needs formatting.

**Next concrete action:** format the plan with the repository-local Prettier and commit the generated v3.15.5 `dist/` changes from the successful baseline build. Then start Fix 1 and its focused regression tests. Fix 1 must address both halves of the review: never unregister an existing schedule accessory on transient failure, and reattach handlers to restored schedule Switch services when initial cloud discovery fails. Update this plan after each checkpoint.
