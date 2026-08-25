# Schedule Switch Naming and Identity Fix Plan

## Purpose

This is the active implementation, validation, and handoff plan for the schedule-switch naming problem discovered after the schedule refresh and recovery work was merged into later upstream releases.

It also preserves the general operating procedures established while working interactively on the Homebridge host through SSH.

Historical recovery architecture and earlier review decisions remain documented in:

- `SCHEDULE_REFRESH_RECOVERY_PLAN.md`
- `SCHEDULE_REFRESH_RECOVERY_FIXES_PLAN.md`
- `SCHEDULE_REFRESH_RECOVERY_FINAL_FIXES_PLAN.md`

## Current branch and checkpoints

- Repository: `pponce/homebridge-roborock-matter-plus`
- Local repository: `~/devProjects/homebridge-roborock-matter-plus`
- Working branch: `schedule-refresh-recovery-live-install`
- Exact upstream version merged for this investigation: `v3.17.4`
- Upstream merge commit: `726811a49d34233d1c3bde7e212a279868dba732`
- Naming source/test commit: `8a146ebb71a33667ba907dd466714a66a3683553`
- Package version after merge: `3.17.4`
- The naming commit is intentionally self-contained so it can be cherry-picked into a later clean pull-request branch.
- Nothing from this checkpoint has been pushed yet.

## User-visible problem

Each vacuum publishes one grouped HAP accessory containing one Switch service for every Roborock schedule.

The observed failure has several related symptoms:

- On initial pairing, the individual services may first appear with unique but generic labels such as `Switch`, `Switch 1`, and `Switch 2`.
- At a later refresh or restart, every schedule in the grouped tile can receive the same name.
- The repeated child name appears to come from the grouped accessory name, such as `<vacuum> Schedules`.
- Manually renaming individual schedules in Apple Home appears to work temporarily.
- After Homebridge restarts, the manual names can be overwritten and the grouped tile can appear to have been recreated.
- The desired first-pairing recommendations are `<vacuum> Schedule 1`, `<vacuum> Schedule 2`, and so on.
- Generated schedule names must remain unique, and genuine user custom names must never be overwritten by refresh or restart.

## Root cause

The HAP schedule design uses one shared cached PlatformAccessory per vacuum and multiple Switch services beneath it. The implementation previously mixed accessory-level and service-level identity.

The problematic behaviors were:

- Each child schedule object could overwrite the shared `accessory.displayName`.
- Each child schedule object could place its schedule ID into the shared `accessory.context`.
- Custom-name detection compared a Switch `ConfiguredName` against the shared accessory display name instead of that Switch service previous `Name`.
- The service-level `displayName`, which is serialized separately from its characteristics, was not refreshed alongside `Name` and `ConfiguredName`.

This allowed one child schedule to change metadata shared by every schedule in the group and allowed serialized service metadata to disagree with the intended unique schedule name.

## Naming and identity invariants

- There is exactly one cached schedule manager accessory per vacuum.
- The manager accessory name is always `<vacuum> Schedules`.
- The manager context identifies the HAP extension and vacuum, never an individual schedule.
- Each individual schedule remains a Switch service beneath the manager accessory.
- Each Switch service identity is based on its stable Roborock timer ID encoded into the service subtype.
- A schedule rename must never change the manager accessory identity or service subtype.
- Generated display names are deterministic: `<vacuum> Schedule 1`, `<vacuum> Schedule 2`, and so on.
- Generated names may renumber after a real schedule deletion because the display order is deterministic.
- A genuine Home custom `ConfiguredName` survives refresh, renumbering, coordinator reconstruction, and Homebridge restart.
- Legacy generic names such as `Switch` and `Switch 1` are replaced with the unique schedule defaults.
- No schedule child may overwrite the grouped accessory display name or context.

## Implemented correction

The source/test fix is committed as `8a146eb` and makes the following changes:

- Removes the individual schedule ID from the shared manager context.
- Stops schedule children from assigning their names to `accessory.displayName`.
- Uses the Switch service previous `Name` when deciding whether `ConfiguredName` is generated or customized.
- Explicitly updates each Switch service `displayName` during initialization and identity refresh.
- Continues to update the Switch `Name` characteristic to the deterministic generated label.
- Updates `ConfiguredName` only when it is absent or still matches the service previous generated name.
- Keeps the stable timer-ID service subtype unchanged.

## Automated regression coverage

The naming regression suite verifies:

- Multiple schedules cannot overwrite their shared group identity.
- Initial schedule service display names and Name characteristics are unique.
- Restored generic `Switch` and `Switch 1` labels are repaired on restart synchronization.
- A custom Home name survives the same reconstruction and restart synchronization.
- Generated names follow deterministic renumbering.
- Custom names survive deterministic renumbering.
- Shared accessory context never contains a child schedule ID.

## First complete validation checkpoint

Validation against package version `3.17.4` completed successfully:

- Lint: passed.
- Both TypeScript projects: passed.
- Build and generated `dist`: passed.
- Full Jest gate: 92 of 92 suites passed.
- Full Jest gate: 1,510 of 1,510 tests passed.
- README test-count synchronization: updated 1,506 to 1,510 in two locations.
- Whitespace validation: passed.
- Generated files changed only in `dist/hap_schedule_accessory.js` and its source map.

## Working together through the local SSH checkout

The authoritative working tree is on the user Linux machine at `~/devProjects/homebridge-roborock-matter-plus`. The user runs supplied Bash commands through an interactive SSH session and returns bounded output.

General collaboration rules:

- Verify the repository path, branch, status, and important refs before modifying anything.
- Treat output from the local machine as authoritative for unpushed state.
- Use GitHub inspection for remote state without confusing it with the unpushed local branch.
- Make one bounded change at a time and validate it before proceeding.
- Never assume an interrupted command completed.
- Never overwrite or discard unrelated local work.
- Do not push, install, restart Homebridge, or alter network state unless that step is explicit.

## Bash command and output convention

Every command block must print literal `START COPY HERE` and `END COPY HERE` boundaries surrounded by separator lines and blank lines.

Use clear `===== SECTION =====` headings inside the output. The user should never have to guess where copied output starts or ends.

## Interactive SSH safety rules

- Do not use `set -e` or `errexit` in commands pasted into the interactive shell.
- Do not use inline `exit`, `logout`, or `exec` as an error path.
- Do not ask the user to source a diagnostic or editing script.
- Capture command statuses explicitly and handle them conditionally.
- Expected failures must not prevent later diagnostics or the final output marker.
- Avoid long heredocs and long multiline quoted commands that can leave Bash prompting for input.
- Put non-trivial logic into a temporary child script.
- Validate Bash child scripts with `bash -n` before execution.
- Validate Node child scripts with `node --check` before execution.
- Run child scripts normally; never source them into the interactive shell.
- Apply repository changes only after temporary-script validation succeeds.
- Preserve a failed temporary file long enough to inspect or recover it.
- Keep diagnostic output bounded with targeted `grep`, `sed`, `git diff`, and `git show` commands.
- Avoid shell-sensitive validation sentinels. Use plain text rather than `!` or HTML comments.

### Known host-tool limitations

- `rg` is not installed. Use standard `grep`, `find`, or Git path filtering.
- `apply_patch` is not installed. Do not invoke it as a shell command.
- Use guarded transformations, validated child scripts, or normal Git operations.
- Do not install system utilities solely for assistant convenience.

## Local Git workflow

Configured remotes:

- `origin`: `git@github.com:pponce/homebridge-roborock-matter-plus.git`
- `upstream`: `git@github.com:mathiashornbek/homebridge-roborock-matter.git`

Required practices:

- Begin and end meaningful operations with `git status --short --branch`.
- Fetch `origin`, `upstream`, and required tags before comparing releases.
- Resolve exact tags and commit SHAs rather than relying only on version text.
- Inspect conflicts and the complete staged result before making a merge commit.
- Stage explicit paths instead of casually using `git add .`.
- Keep the source/test fix separable from live-install artifacts and plans.
- Do not use destructive reset or checkout commands to discard changes.
- Never force-push.
- Do not push until the intended commits and working tree have been reviewed.

The current history intentionally separates the upstream merge, the source/test naming fix, and the generated live-install/documentation checkpoint.

A later clean pull-request branch should cherry-pick `8a146eb`, omit tracked live-install `dist`, omit working-plan Markdown files, synchronize the README test count, pass the complete gate, and then target Mathias upstream.

## Local toolchain rules

- The verified toolchain is Node `v24.19.0` and npm `11.17.0`.
- Do not upgrade, downgrade, or reinstall Node or npm without a demonstrated failure.
- Use repository npm scripts because npm supplies `node_modules/.bin` to script processes.
- If a tool appears absent, check the npm script, local dependencies, and `NODE_ENV` first.
- `NODE_ENV=production` can cause development dependencies to be omitted.
- Do not repeat a known dependency workaround unless the current environment reproduces the corresponding failure.

## Generated `dist` workflow

- `npm run build` owns `dist`; it removes the old directory and compiles TypeScript.
- Never hand-edit files under `dist`.
- This live-install branch intentionally tracks generated `dist` so `hb-service` can install the GitHub branch directly.
- After a successful build, inspect `git status --short -- dist` and the targeted generated diff.
- The current naming fix generates only `dist/hap_schedule_accessory.js` and `dist/hap_schedule_accessory.js.map` changes.
- Stage generated output explicitly with `git add -f -A -- dist` only after verifying it corresponds to the tested source.
- The later clean upstream pull-request branch must omit `dist` unless Mathias explicitly requests it.

## GitHub Actions generated-build workflow

- Assume a push can race a GitHub Actions commit that rebuilds `dist`.
- A non-fast-forward rejection is a synchronization event, not permission to force-push.
- Fetch `origin` and inspect the remote-only commit with `git show --stat` and targeted diffs.
- Confirm whether the automation commit changed only generated output.
- Rebase local work onto the verified remote build commit, recheck the final tree, and push normally.
- Do not infer a bot commit contents solely from its subject.
- Remember that `git diff HEAD..origin/<branch>` compares tips and can look like a source reversion even when the bot changed only `dist`.
- Do not rerun the complete release gate merely because an expected generated-only rebase changed commit SHAs; verify whether the tested source tree changed.

## Canonical validation gate

Use the repository npm scripts:

```bash
npm run lint
npm run typecheck
npm run build
npm test
```

After the complete test suite passes:

```bash
npm run sync:test-count
```

Then rerun the canonical gate against the synchronized README and final documentation state. Finish with `git diff --check`.

## `hb-service` live-install workflow

The GitHub branch must be pushed before installation because `hb-service add` installs remote GitHub content, not the unpushed local checkout.

The user-confirmed local branch installation sequence is:

```bash
sudo hb-service stop
sudo hb-service add https://github.com/pponce/homebridge-roborock-matter-plus.git#schedule-refresh-recovery-live-install
sudo hb-service start
```

Operational requirements:

- Run stop, installation, verification, and start as explicit phases with status capture.
- If installation fails, preserve the full error and still leave a clear path to restart Homebridge.
- Do not combine installation with unrelated Git mutations.
- Verify the installed package under `/var/lib/homebridge/node_modules/homebridge-roborock-matter`.
- Homebridge is installed under `/opt/homebridge` and its data and logs are under `/var/lib/homebridge`.
- Inspect `/var/lib/homebridge/homebridge.log` after startup.
- Confirm the startup log identifies the expected plugin version and contains no schedule initialization error.
- Do not change the Homebridge npm version unless an actual installation failure demonstrates the need.
- A historical npm override/workspace failure used npm `10.8.2` under the Homebridge service account as a fallback, but that is not a default step.

## Live HomeKit naming validation

Start with the existing paired bridge. Removing and re-pairing a bridge can destroy HomeKit references and must be treated as a separate explicitly approved test.

For each vacuum:

1. Record the grouped schedule tile name and every individual schedule name.
2. Confirm the generated defaults are unique and follow `<vacuum> Schedule N`.
3. Give at least two schedules distinct custom names in Apple Home.
4. Trigger an ordinary schedule refresh and confirm the custom names remain.
5. Restart Homebridge and confirm the same grouped tile and child names remain.
6. Confirm schedules still control the intended Roborock timers after restart.
7. Delete or reorder a schedule only when safe, then verify generated names renumber deterministically while custom names remain.
8. Record whether any failure occurs on the first rename, every rename, refresh, or restart.
9. Record whether Apple Home merely redraws the tile or Homebridge actually unregisters and recreates the accessory.
10. Confirm existing scenes and automations remain associated with the same schedule services.

If a clean pairing test is later authorized, verify that the first recommended labels are vacuum-specific rather than generic `Switch` labels. Do not remove the working bridge merely to perform this optional test.

## Live findings from the first paired build

The first pushed build was installed from commit `d169933` and tested with a freshly removed and re-paired HAP child bridge.

- Initial Home pairing suggested generic names such as `Switch`, `Switch 2`, and `Switch 3`.
- Waiting and reopening Home did not immediately change those generic names.
- After a Homebridge restart, Home displayed every schedule switch with the shared schedule-group name.
- The grouped tiles reordered, but cache inspection showed stable manager UUIDs, so reordering was not evidence that the manager accessories were recreated.
- The Homebridge cache contained unique service `displayName` and `Name` values such as `Downtown Rock Schedule 1`.
- Every optional `ConfiguredName` value was an empty string.
- HAP therefore treated an empty optional characteristic differently from a missing or null characteristic, and the first naming correction did not initialize it.
- Follow-up commit `dc54094` treats a null, empty, or whitespace-only `ConfiguredName` as uninitialized and writes the deterministic generated schedule name.
- A non-empty Home custom name remains protected and is not replaced by refresh or restart synchronization.

The Downtown Rock 5-enabled and 2-disabled observation was investigated separately. Homebridge logs contained two explicit HomeKit schedule-enable commands, each followed by a successful authoritative schedule refresh. This was not passive state drift and does not justify additional polling.

## Conservative schedule-cloud request constraints

The naming correction is HAP metadata handling only. It must not change schedule refresh cadence or add cloud traffic.

- Do not add a permanent schedule-specific polling loop.
- Do not add an independent reachability polling loop or an exponential-backoff timer that acts as polling.
- Retain one cached schedule snapshot and at most one ordinary in-flight refresh per vacuum.
- HomeKit GET returns cached state immediately and may asynchronously refresh only when the shared snapshot is stale.
- Concurrent refresh triggers must coalesce into one cloud request.
- Failed or untrusted refreshes preserve the prior snapshot and use the existing failure backoff.
- User-initiated writes may retain their delayed verification read through the shared coordinator.
- If an existing general Roborock poll already obtains schedule data, a future change may feed that result into the coordinator, but it must not create another schedule timer.

## Reliable multiline pasting through SSH

Long assistant-provided Bash blocks should be enclosed in `{ ...; }`. Bash parses the complete compound command before executing its first child command. This prevents the remainder of a paste from being delivered to Jest, npm, or another foreground process.

The iTerm2 option `Wait for shell prompt before pasting each line` was confirmed disabled, so it was not the cause of the observed paste behavior. Compound-command grouping remains the standard defensive format for future commands.

## Second complete validation checkpoint

Follow-up source/test commit: `dc54094` (`Initialize empty schedule configured names`).

- Focused schedule tests: 4 of 4 suites passed.
- Focused schedule tests: 45 of 45 tests passed.
- TypeScript checks: passed.
- Prettier checks: passed.
- Full Jest gate: 92 of 92 suites passed.
- Full Jest gate: 1,510 of 1,510 tests passed.
- README test-count synchronization: already stated 1,510 in both locations.
- Whitespace validation: passed.
- The build changed only `dist/hap_schedule_accessory.js` and its source map.
- The generated JavaScript contains exactly the two empty or whitespace-only `ConfiguredName` checks compiled from the TypeScript source.

## Server-timer payload correction

### Confirmed naming result

- After force-closing and reopening Apple Home, all 15 schedule services displayed unique vacuum-specific names.
- The Homebridge cache contained a non-empty deterministic `ConfiguredName` for all 15 services.
- After a Homebridge restart, the unique schedule names remained intact.
- The schedule manager UUID hashes remained stable across restart.
- The schedule naming and identity correction is therefore confirmed in live HomeKit use.

### Separate Downtown schedule-state defect

Downtown Rock exposed seven schedules. The Roborock app showed three enabled and four disabled, while `get_server_timer` and Home showed five enabled and two disabled.

- Schedule 2, ID `1652749234966`, could be disabled and enabled from Home and changed correctly in the Roborock app.
- Schedule 6, ID `1652975049275`, did not change in the Roborock app when controlled from Home.
- The authoritative verification endpoint itself contained the five-enabled snapshot, so repeated startup or stale-cache refreshes could only reproduce that state.
- Additional polling would not repair a divergence already present in the endpoint response.

### Evidence from the original working implementation

The earlier `homebridge-roborock-vacuum2` branch `fix-schedule-functionality` established the successful Roborock server-timer command shape through live testing.

- The accessory retained the complete timer tuple locally.
- The API extracted only the timer ID.
- `upd_server_timer` received one nested minimal tuple: `[[timerId, "on"|"off"]]`.
- The third field remained local schedule metadata and was not transmitted.
- A successful user write was followed by one authoritative `get_server_timer` verification read.
- The final original implementation did not contain a permanent schedule-specific polling timer.

### Retracted full-tuple hypothesis

Commits `b1aaa0d` and `1aae52e` tested the hypothesis that `upd_server_timer` required the complete returned tuple. Live testing disproved that hypothesis.

- The installed build sent a tuple whose reported length was three.
- The previously nonworking Downtown schedule still did not change in the Roborock app.
- The primary verification failed and the existing `upd_timer` fallback also failed to confirm the requested state.
- The earlier plan language claiming that the complete tuple was required is superseded by this section.

### Implemented correction

Source and regression-test commit: `d517891a124970246064f8c498fbf54ab88bab23` (`Restore minimal server timer payloads`).

- `updateServerTimer` accepts either an ID or stored timer tuple but extracts the ID for transmission.
- The Roborock wire payload is exactly `[[timerId, "on"|"off"]]`.
- Extra server-timer metadata, including the observed third field, is not sent.
- The supplied cached timer tuple is not mutated.
- HAP-level coverage proves the successful path performs exactly one `upd_server_timer` command and one delayed coordinator verification read.
- Mathias's reviewed `upd_timer` fallback remains intact and is reached only after a user-initiated primary write fails verification.
- No polling, refresh cadence, cache lifetime, failure backoff, coalescing, or cloud-call frequency was changed.

### Fourth complete validation checkpoint

- Source and regression-test commit: `d517891`.
- Focused schedule gate: 5 of 5 suites passed.
- Focused schedule gate: 49 of 49 tests passed.
- Prettier checks: passed.
- Both TypeScript projects: passed.
- Build and generated `dist`: passed.
- Full Jest gate: 92 of 92 suites passed.
- Full Jest gate: 1,512 of 1,512 tests passed.
- README already stated 1,512 tests in both protected locations.
- Whitespace validation: passed.
- Generated changes are limited to `dist/hap_schedule_accessory.js`, `dist/hap_schedule_api.js`, and their source maps.

## Remaining work

- Commit this corrected plan and generated `dist` separately from source/test commit `d517891`.
- Push without force and inspect any GitHub Actions generated-build commit.
- Reinstall the exact pushed `schedule-refresh-recovery-live-install` branch using `hb-service`.
- Confirm the installed JavaScript sends the nested minimal server-timer payload.
- Identify the two Downtown schedules whose Roborock-app state differs from `get_server_timer`.
- Use the Roborock app to deliberately toggle each mismatched schedule and confirm the raw server snapshot returns to the intended three-enabled and four-disabled state.
- Allow one legitimate coordinator refresh, then confirm Home matches the repaired server snapshot.
- Test one previously nonworking Downtown schedule from Home.
- Confirm the successful command is followed by one verification read and does not reach the fallback.
- Restore Downtown Rock to its intended three-enabled and four-disabled state.
- Restart Homebridge and confirm Home remains synchronized.
- Confirm all schedule names remain unique after installation and restart.
- Rename one schedule through Home, restart Homebridge, and confirm the custom name survives.
- Update this plan with the pushed SHA and final live-test results.
- Later create a clean upstream pull-request branch without tracked `dist` or working-plan Markdown files.
