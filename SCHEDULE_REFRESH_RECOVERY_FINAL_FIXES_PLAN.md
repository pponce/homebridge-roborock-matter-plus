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

Mathias's new 2026-08-22 comment confirms that the final-fixes plan describes the **correct architecture** for the two substantive fixes. In particular, Fix 1's intended means is to reattach the schedule handlers so `onGet()` / `refreshIfNeeded()` can heal a restored accessory, rather than removing the accessory.

His comment does **not** introduce a new functional code requirement beyond the current Fix 1 / Fix 2 implementation. It does add two important release-process clarifications:

- The validation gate should invoke the **npm scripts**, not the underlying binaries directly. npm supplies `node_modules/.bin` to script processes.
- After the test suite is green, run `npm run sync:test-count` so the README's documented test total matches the actual suite count. The repository contains an explicit contract test for this.

He also confirmed:

- Fix 1 and Fix 2 describe the right changes and the current implementation direction is correct.
- The dependency problem that occurred earlier was an execution-environment / `PATH` issue, not a missing dependency. The repository already has `tsc`, `jest`, `prettier`, and `rimraf` in `node_modules/.bin` when dev dependencies are installed.
- `npm run typecheck` runs both TypeScript projects, including the JSDoc-checked `roborockLib/` tree.
- `npm run build` owns regeneration of `dist/`; it is `rimraf ./dist && tsc`.
- The parent-project main gate Mathias ran was **83 suites / 1,335 tests**. The final-fixes branch has additional regression suites/tests, so its current count of **86 suites / 1,377 tests** is expected and is not a disagreement with Mathias's result.
- The schedule accessory model correction to `Model: "Schedules"` is right because `Manufacturer` already supplies `Roborock` on every surface.

The substantive fixes reviewed by Mathias remain:

1. **Transient refresh failure can delete schedule accessories.**
2. **`verify()` can join a refresh that started before the user write.**

The smaller cleanups were:

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

This keeps the accessory information row consistent with Mathias's current convention and avoids repeating `Roborock` after the manufacturer field already supplies the brand.

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
- Prettier: **passed after formatting the active plan file with the repository-local Prettier**.
- The failed earlier build attempt using global TypeScript 7 was an environment/tool-version problem, not a project-source failure, and the tracked `dist/` output was restored before the real baseline.
- The successful baseline build regenerated `dist/matter_vacuum_accessory.js(.map)` and `dist/platform.js(.map)` from the v3.15.5 source merge. These generated changes need to be retained/committed as appropriate for the tested branch.

The baseline therefore shows **no functional/test/typecheck regression attributable to the final-fixes branch**.

### SSH / interactive-shell scripting lesson

For commands intended to run in the user's interactive SSH session, avoid using `set -e` as the primary error-control mechanism. A failing command under `set -e` can terminate the script immediately, and depending on how a script is invoked or sourced that can make the interactive SSH session appear to have been dropped. Prefer explicit exit-code capture, clear conditional continuation, and bounded diagnostic commands. The exact prior disconnect mechanism is not proven, so this is a precautionary workflow rule rather than a confirmed root cause.

### GitHub Actions / generated `dist` lessons

This repository has an automated GitHub Actions workflow that builds and commits generated `dist/` output. The following workflow should be treated as the standard procedure for future branches:

1. **Assume a push may race the build workflow.** A perfectly valid local push can be rejected as non-fast-forward because GitHub Actions has inserted a generated-build commit after the previous remote tip.

2. **Do not force-push.** On a rejection, fetch `origin` and inspect the new remote tip before doing anything else.

3. **Inspect the bot commit itself before rebasing.** Use `git show --stat` and targeted `git diff` commands. Do not infer the contents of a `Build dist from source` commit from the commit message alone.

4. **Rebase local work onto the remote build commit.** The normal sequence is:
   `git fetch origin` → inspect remote-only commit → `git rebase origin/<branch>` → verify the expected checkpoint survived → `git push`.

5. **Understand two-sided Git diffs correctly.** A command such as `git diff HEAD..origin/<branch>` compares two different tips. It can therefore show files as “reverted” relative to the local commit even when the remote bot commit itself changed only `dist/`. Inspect the bot commit with `git show` before concluding that automation overwrote source, tests, or plan content.

6. **Treat ignored/generated `dist/` as workflow-owned output.** A local build can modify tracked/generated files even though `dist/` is ignored by `.gitignore`; GitHub Actions can stage them explicitly. Before committing local build output, verify the diff is exactly the compiled form of the intended source change.

7. **Expect the local build to create a working-tree diff after a clean release gate.** That is not itself evidence of a source regression. Review the generated diff, then decide whether it belongs in the checkpoint and allow the repository workflow to produce the corresponding remote build commit.

8. **Do not repeatedly rerun the full release gate solely because a rebase changed commit SHAs.** When the rebase only inserts the expected generated-build commit and the tested source/test tree is unchanged, verify the final tree and checkpoint contents rather than treating the new SHA as a new code change.

9. **Keep documentation checkpoints in normal commits.** This makes it possible to rebase over generated-build commits while preserving the verified history of what was tested, which review items were completed, and which real-device checks remain.

10. **When a push race happens near a release checkpoint, separate code correctness from synchronization.** First establish that the code/test tree passed its gate. Then synchronize the Git history with the generated-build commit. Do not mix a history race with a functional code change.

## GitHub-first / local-second workflow

### GitHub completed

- [x] Confirmed `schedule-refresh-recovery-final-fixes` already exists.
- [x] Confirmed it starts from `schedule-refresh-recovery-fixes`.
- [x] Inspected both historical plan files.
- [x] Replaced the final-fixes handoff plan with this verified version.
- [x] Confirmed Mathias's current parent-project version is **v3.15.5**.
- [x] Confirmed upstream tip is `141beae88b01bcd2433dc142e89fc87465221f91`.
- [x] Recorded the user's preferred bash-output copy/paste boundary convention in this plan.
- [x] Reviewed Mathias's 2026-08-22 follow-up comment and confirmed it validates Fixes 1 and 2 rather than introducing another functional fix.
- [x] Updated this plan with the canonical npm-script release gate and `npm run sync:test-count` requirement.

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
- [x] Formatted the active plan file with repository Prettier and committed the formatting fix.
- [x] Committed the v3.15.5-generated `dist/` updates produced by the successful baseline build.
- [x] Applied Fix 1 and its tests.
- [x] Ran focused tests.
- [x] Applied Fix 2 and its race tests.
- [x] Ran focused tests.
- [x] Applied Fixes 3–5 and corresponding contract assertions.
- [x] Ran the full release gate for the final source/test branch: **86/86 suites, 1,377/1,377 tests passed; both typechecks, build, Prettier, and `git diff --check` passed**.
- [x] Pushed the exact tested branch to GitHub.
- [x] Compared the final branch against the pre-fix branch and the parent `main`.
- [x] Installed the exact pushed branch on the real Homebridge host with no installation error.
- [ ] Run `npm run sync:test-count` and verify the README test-count contract before the final release checkpoint. Mathias explicitly requires this after the test suite is green.
- [ ] Re-run the canonical npm-script release gate after the README count is synchronized.
- [ ] Push the synchronized README/plan checkpoint.
- [ ] Run controlled failure/recovery and write/verify tests on the real installation.
- [ ] Record final test counts and final synchronized commit SHA(s) here.

## Fix 1 checkpoint — 2026-08-22

Fix 1 is complete and committed as `8fc2531`.

### Behavior fixed

- A failed schedule refresh no longer unregisters an existing restored schedule accessory.
- A rejected refresh follows the same preservation rule.
- Restored HomeKit Switch services can be reconstructed into schedule child objects so their normal GET/SET handlers are reattached.
- Restoration state is treated as local recovery state, not as a trusted cloud snapshot.
- A successful authoritative empty snapshot can still remove stale schedule accessories.
- Restored `ConfiguredName` values are preserved during child rehydration.

### Verification

- Focused schedule cache/contract tests: **35/35 passed**.
- Full schedule test gate (`hap-schedule-api`, `hap-schedule-cache`, `schedule-settings-contract`): **37/37 passed**.
- Main TypeScript typecheck: **passed**.
- Changed source/test files: **Prettier passed**.

### Review correction caught during implementation

The first recovery implementation could have overwritten a user's restored `ConfiguredName` because it creates a fresh child object before calling `initialize()`. The child initialization path was corrected to preserve an existing custom `ConfiguredName`, matching the already-reviewed refresh behavior.

### Files changed

- `src/platform.ts`
- `src/hap_schedule_accessory.ts`
- `__tests__/hap-schedule-cache.test.js`
- `__tests__/schedule-settings-contract.test.js`

## Fix 2 checkpoint — 2026-08-22

Fix 2 is complete in the working tree.

### Behavior fixed

- Normal schedule refresh callers continue to coalesce onto one in-flight refresh.
- Verification can require a refresh whose start time is at or after the write timestamp.
- A verification request therefore cannot accept a refresh that started before the write.
- A newer refresh receives a newer generation and is authoritative over older in-flight refreshes.
- Older refreshes cannot overwrite a newer cached snapshot.
- Older refreshes cannot restore failure-backoff state after a newer refresh succeeds.
- The primary `upd_server_timer` write and `upd_timer` fallback each capture their own write-start timestamp.
- `verify()` no longer accepts the unused API parameter.
- Failure-backoff logging is debug-level rather than info-level.

### Verification

- Full schedule test gate: **41/41 passed**.
- Main TypeScript typecheck: **passed**.
- Roborock-library TypeScript typecheck: **passed**.
- Changed schedule source/tests: **Prettier passed**.
- `git diff --check`: **passed**.

### Regression coverage

The race test covers both important directions:

1. A verification refresh does not join a refresh that started before the write.
2. The older pre-write refresh cannot overwrite the newer post-write snapshot or reinstate failure-backoff state when it completes later.

## Minor cleanup checkpoint — 2026-08-22

The remaining smaller Mathias review items are complete.

- Failure-backoff logging is debug-level.
- `verify()` no longer carries the unused API parameter.
- Schedule accessory `Model` is `Schedules`, matching the parent-project convention.
- Schedule numbering behavior remains unchanged, as Mathias recommended.

Verification after the combined cleanup:

- Three schedule suites: **42/42 tests passed**.
- Both TypeScript typechecks: **passed**.
- Prettier: **passed**.
- `git diff --check`: **passed**.

## Final release-gate checkpoint — 2026-08-22

The final source/test branch passed the complete repository gate:

- Main TypeScript typecheck: **passed**.
- Roborock-library TypeScript typecheck: **passed**.
- Build: **passed**.
- Full Jest: **86/86 suites, 1,377/1,377 tests passed**.
- Prettier: **passed**.
- `git diff --check`: **passed**.
- Package version: **3.15.5**.

The local build regenerated only:

- `dist/hap_schedule_accessory.js`
- `dist/hap_schedule_accessory.js.map`

The generated JavaScript difference is exactly the final `Model: "Schedules"` cleanup and should be committed with this checkpoint.

### Final code-review disposition

All items from Mathias's latest review are addressed:

- transient refresh failure no longer unregisters restored schedule accessories;
- restored schedule handlers are reattached when cloud discovery fails;
- verification cannot consume a pre-write in-flight refresh;
- older refreshes cannot overwrite a newer snapshot;
- older refreshes cannot reintroduce failure-backoff state;
- failure-backoff logging is debug-level;
- unused `verify()` API parameter removed;
- schedule accessory Model is `Schedules`;
- deterministic schedule ordering and ConfiguredName preservation remain intact;
- schedule renumbering on deletion is intentionally unchanged.

## Release gate

The canonical repository gate is now the **npm-script gate Mathias recommended**. Do not call `tsc`, `jest`, `prettier`, or `rimraf` directly from an interactive shell and interpret a missing command as a dependency failure; those executables are exposed by npm to the duration of the scripts.

Run:

```bash
npm run lint && npm run typecheck && npm run build && npm test
```

Then, once the tests are green:

```bash
npm run sync:test-count
```

`npm run typecheck` intentionally checks both `tsconfig.json` and `tsconfig.roborockLib.json`. `npm run build` intentionally regenerates `dist/`. `npm run sync:test-count` updates the README's documented suite/test totals and must be run after the test suite is green and before the final push.

Definition of done also requires:

- No transient refresh failure can unregister an existing schedule accessory.
- Restored schedule Switch services have handlers after failed startup discovery.
- A pre-write refresh cannot satisfy post-write verification.
- An older superseded refresh cannot overwrite a newer refresh snapshot.
- Failure-backoff logging is debug-level.
- `verify()` has no unused API parameter.
- Model is `Schedules`.
- `dist/` reflects the tested source.
- README test counts match the real suite after `npm run sync:test-count`.
- The final canonical npm-script gate passes after test-count synchronization.
- Real-device recovery behavior is checked where practical.

### Operational workflow lessons captured

The final-fixes work also established a repeatable synchronization procedure for this repository's automated `dist` build workflow: inspect remote bot commits, rebase rather than force-push, verify generated output independently, and preserve plan checkpoints through generated-build rebases.

### Mathias follow-up release guidance — 2026-08-22

Mathias explicitly confirmed that the blocker seen earlier was **not a dependency problem**. The repository contains the dev tools in `node_modules/.bin`; npm scripts put that directory on `PATH` for the duration of each script. A normal interactive shell does not do so.

The operational implication for this project is:

- Use `npm run lint`, `npm run typecheck`, `npm run build`, and `npm test` for release validation.
- If those tools are genuinely absent from `node_modules/.bin`, check `NODE_ENV` before reinstalling. `NODE_ENV=production` causes npm to omit dev dependencies; `export NODE_ENV=development` and reinstall is the appropriate recovery.
- Do not treat Mathias's 83-suite/1,335-test result on parent `main` as the expected count for this branch. The final-fixes branch has its own additional regression coverage and currently totals 86 suites / 1,377 tests.
- Before the final push, run `npm run sync:test-count`; the README test count is protected by `__tests__/readme-test-count-is-not-invented.test.js` and should never be manually retyped.
- `npm run build` owns generated `dist/` regeneration; do not hand-edit generated files.

## Current status — 2026-08-22

**Branch state:** Mathias v3.15.5 has been merged cleanly into `schedule-refresh-recovery-final-fixes`. The baseline checkpoint is `1fb6e3d`; Fix 1 is pushed as `8fc2531`.

**Code state:** Fix 1, Fix 2, and the remaining minor review items are implemented and verified. The branch passed the final source/test gate at **86/86 suites and 1,377/1,377 tests**, with both typechecks, build, Prettier, and `git diff --check` passing. Mathias's follow-up comment confirms that the implementation direction is correct.

**Real Homebridge state:** The exact pushed branch has been installed on the live Homebridge host successfully. No installation problem remains.

**Remaining release work:** The code itself does not need another change based on Mathias's comment. The remaining work is release bookkeeping and real-device behavior validation: synchronize the README test count with the actual 1,377-test suite using `npm run sync:test-count`, rerun the canonical npm-script gate after that documentation change, push the synchronized checkpoint, and then perform the controlled schedule recovery and write/verify tests on the live Homebridge installation.

## Live-test lessons — 2026-08-22

### MQTT broker failover

A live failure test initially blocked the currently observed Roborock MQTT endpoint, but the Roborock client reconnected to a different MQTT broker endpoint. The test therefore did not actually isolate the cloud transport and could not be used to evaluate schedule-refresh recovery.

Required test behavior:

- Do not assume the currently observed MQTT broker endpoint remains fixed.
- During an induced MQTT failure test, continuously monitor the Roborock process for new MQTT connections.
- Block each newly discovered MQTT endpoint used by the Roborock process until the intended schedule-refresh failure is observed.
- Confirm the Homebridge log contains the expected `get_server_timer` timeout/failure before evaluating accessory recovery.
- Do not treat firewall counters alone as proof that the schedule transport was isolated; confirm the application-level failure in the Homebridge log.
- Keep the live test implementation generic and do not document environment-specific IP addresses, hostnames, device identifiers, credentials, tokens, or other unique setup details.

### Apple Home observation versus Homebridge state

A live cloud-failure test caused schedule groups to temporarily appear missing or `Not Supported` in Apple Home. After connectivity was restored and Homebridge performed a successful authoritative schedule refresh, the schedule switches returned.

This observation is **not by itself proof that the existing HomeKit accessory was unregistered**.

Before changing accessory identity or unregister/re-register behavior:

- Determine from Homebridge-side diagnostics whether the cached manager accessory still contains its restored Switch services.
- Record whether the restoration routine found the expected schedule Switch services and reattached handlers.
- Treat Apple Home presentation as a secondary observation rather than the authoritative indicator of Homebridge accessory lifecycle.

Do not delete and recreate an existing schedule manager accessory as a workaround for this behavior. Preserving the existing accessory identity is required to avoid unnecessary disruption to user automations, scenes, and other HomeKit references.

### Interactive SSH diagnostic safety

Commands intended to be pasted directly into an interactive SSH shell must not terminate the caller shell on an expected diagnostic failure.

Required practice:

- Do not use `exit 1` as the failure path of an inline diagnostic block intended for direct interactive-shell execution.
- Do not use `set -e` as a substitute for explicit error handling in such blocks.
- Use explicit status capture, conditional handling, or a child process when a non-zero exit status is expected.
- A child process may set its own exit status without terminating the user's interactive SSH shell.
- Every diagnostic block must leave the SSH session usable even when an individual probe fails.
- Keep the required `START COPY HERE` / `END COPY HERE` output boundaries.

This lesson was confirmed during the final-fixes live investigation: a malformed patch was correctly rejected, but an inline `exit 1` then terminated the interactive SSH session. The command itself made no repository changes.

### Live test runner safety

The MQTT failover-aware live test exposed another test-harness failure mode: an inline monitoring loop can fail to parse after the disruptive portion of a diagnostic has already changed network state.

Required practice for future live recovery tests:

- Keep disruptive setup and cleanup in the parent shell.
- Put non-trivial monitoring logic in a temporary child script.
- Run `bash -n` against the child script before creating the temporary firewall.
- Run the child script without allowing its failure to terminate the parent shell.
- The parent shell must always continue to cleanup logic after child-script failure.
- Do not rely on inline parser-heavy Bash loops for a test that changes network connectivity.
- Do not include environment-specific network addresses, credentials, tokens, device identifiers, or other sensitive setup details in this plan.

The test must therefore be structured so a monitor-script syntax error cannot leave the temporary firewall or debug configuration active.

## Final validation findings — 2026-08-22

### Startup recovery branch now has direct end-to-end test coverage

The live investigation identified that the existing tests covered the restoration method itself and the already-instantiated coordinator failure path, but did not directly execute the startup/new-coordinator failure branch in `syncHapSchedules()`.

A dedicated test was added in `__tests__/schedule-startup-recovery.test.js` covering this path:

- a cached HAP schedule manager accessory is present;
- no in-memory schedule coordinator exists yet;
- `syncHapSchedules()` creates the coordinator for the known device;
- initialization fails;
- `restoreScheduleHandlersFromAccessory()` is invoked;
- the coordinator remains retained;
- the cached accessory remains registered;
- no unregister operation is performed.

This closes the missing automated coverage for Fix 1's startup recovery path without requiring a live cloud or transport failure to reproduce it.

### Live transport-test findings

Several controlled live failure experiments demonstrated that Roborock transport selection can produce different failure modes depending on which network path is interrupted. In particular, blocking LAN connectivity can cause `get_server_timer` to be rejected before the request is sent, while MQTT interruption can also affect local/cloud transport startup behavior.

Therefore, live firewall tests are useful as supplemental validation but are not a reliable substitute for deterministic unit coverage of the schedule lifecycle branch.

The release decision for Fix 1 is therefore based on the implemented code plus direct automated coverage of the startup recovery path, with live testing used to validate preservation behavior and observe real Homebridge/HomeKit presentation.

No environment-specific network addresses, credentials, tokens, device identifiers, broker addresses, or other private setup details are recorded in this plan.
