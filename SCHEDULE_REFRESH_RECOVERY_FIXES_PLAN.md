# Schedule Refresh & Recovery Fixes Plan

## Progress update — 2026-08-21

### Verified implementation and real-device results

The first recovery phase is now implemented and validated locally and on the real Homebridge installation.

- **HomeKit GET is non-blocking.** The schedule switch GET starts `refreshIfNeeded()` asynchronously and immediately returns the cached schedule state.
- **One cached snapshot + one in-flight refresh per vacuum.** Real Home testing produced many simultaneous schedule GETs, but the coordinator coalesced them into one refresh/cloud request per vacuum and synchronized all schedule switches from the resulting snapshot.
- **Successful refreshes update the shared schedule snapshot and synchronize all HAP schedule switches.**
- **Failed refreshes preserve the existing cached schedule/accessories.**
- **Failure backoff / negative caching is active at 30 seconds.** During a real Roborock MQTT/cloud timeout, repeated HomeKit reads returned the preserved cached state and entered `FAILURE BACKOFF` rather than issuing additional cloud requests.
- **Real-device failure test passed.** Both vacuums experienced `get_server_timer` cloud timeouts, preserved their existing schedule state, and suppressed repeated refreshes during the backoff window.
- **Schedule-switch disable/restart validation passed.** With `enableHomeKitScheduleSwitches=false`, Homebridge restarted successfully without rediscovering/restoring schedule switches.
- **Targeted schedule tests:** 21/21 passed for the first recovery phase.
- **Full test suite:** 86/86 suites passed, 1,337/1,337 tests passed for the first recovery phase.
- **Build/typecheck:** passed.

### Real-device validation — failed first discovery

On the real Homebridge installation, Roborock MQTT was deliberately unavailable during a Homebridge restart. Both restored schedule coordinators failed their initial `get_server_timer` refresh with:

`No local connection ... so the get_server_timer request was not sent.`

The resulting restored schedule groups for **Downtown Rock** and **Uptown Rock** disappeared from Apple Home, confirming that failed initial discovery no longer leaves restored schedule accessories registered without working handlers.

### Progress update — `upd_timer` fallback

The `upd_timer` fallback is now fixed and regression-tested.

- `updateTimer()` now prefers the underlying `vacuum.command()` path before `startCommand()`. This avoids the `SIMPLE_VACUUM_COMMANDS` allow-list behavior that could previously let `startCommand()` resolve without sending `upd_timer`.
- Added focused regression coverage that provides both `vacuum.command()` and `startCommand()` and verifies that `upd_timer` is sent through `vacuum.command()` with the expected parameters and request options.
- Targeted schedule/API tests after the change: **24/24 passed**.
- Full repository test suite after the change: **86/86 suites, 1,339/1,339 tests passed**.
- Typecheck: **passed**.
- Build: **passed**.
- Changed-file formatting: **passed**. The repository still has the previously established baseline Prettier failures in `__tests__/hap-schedule-cache.test.js` and `src/hap_schedule_accessory.ts`; neither file was changed for this fix.
- Tested commit pushed to `schedule-refresh-recovery-fixes`: `c7212cb`.
- The exact pushed branch was installed on the real Homebridge host at `c7212cb`.
- A normal real-device schedule write was not relied upon as proof of fallback execution because the fallback only runs after `upd_server_timer` verification fails. The regression test directly covers the faulty path Mathias identified.

### Progress update — non-empty/unparsable schedule responses

This recovery item is now implemented, regression-tested, and pushed.

- A successful `[]` response remains authoritative and can remove schedule switches when the cloud explicitly reports no schedules.
- A **non-empty raw response that parses to zero schedules is now treated as untrusted**.
- The coordinator records a failed refresh/backoff timestamp and preserves the existing cached schedule snapshot and HomeKit switches.
- Added focused regression coverage for the untrusted-response contract.
- Targeted schedule tests after the change: **23/23 passed**.
- Full repository test suite after the change: **86/86 suites, 1,340/1,340 tests passed**.
- Typecheck: **passed**.
- Build: **passed**.
- Changed-file formatting: **passed**.
- Tested commit pushed to `schedule-refresh-recovery-fixes`: `61ff89a`.

### Remaining recovery items

The following items remain intentionally open and have not yet been marked complete:

- Final end-to-end validation of recovery after the failure/backoff window expires is still pending on real hardware.
- Preserve HomeKit `ConfiguredName` across unchanged schedule refreshes.
- Make schedule ordering deterministic.
- Make `verify()` participate correctly in the coordinator refresh/coalescing model.
- Prevent disposed coordinators from syncing after teardown.
- Route coordinator timers through the shared timer utility.
- Move routine schedule payload logging from `info` to `debug`.
- Document the Q7 neutral `get_server_timer` response.

This is the **active handoff plan** for the follow-up work requested by Mathias after his review of `schedule-refresh-recovery-clean`.

The historical first-phase record is `SCHEDULE_REFRESH_RECOVERY_PLAN.md`. Do not use that file as the active follow-up plan.

## Current repository state

- Repository: `pponce/homebridge-roborock-matter-plus`
- Clean upstream baseline: `main` = Mathias `v3.15.3` (`02cdd263`)
- Completed first phase: `schedule-refresh-recovery-clean`
- Active follow-up branch: `schedule-refresh-recovery-fixes`
- Follow-up branch is based on `schedule-refresh-recovery-clean` with Mathias 3.15.3 merged on top.
- Current branch tip: `61ff89a`
- Pre-fix functional baseline: merge `9a7cd13`, with 86 suites / 1336 tests passing.

## Mathias's required fixes

### 1. Blocker: HomeKit GET must not wait for Roborock cloud

Current shape:

```ts
.onGet(async () => {
  await this.coordinator.refreshIfNeeded();
  return this.schedule.enabled;
});
```

Required direction:

```ts
.onGet(() => {
  void this.coordinator.refreshIfNeeded();
  return this.schedule.enabled;
});
```

HomeKit must return the cached value immediately. The refresh happens asynchronously and the coordinator updates the characteristic when the fresh snapshot arrives.

Also add failure timestamp/backoff behavior so repeated reads during a cloud outage do not repeatedly issue 10-second cloud requests.

### 2. Failed first discovery must not leave dead restored accessories

Trace `platform.ts` startup/discovery failure handling. A restored schedule accessory must not appear functional when its coordinator/handlers were never successfully initialized.

Prefer the visibly unavailable/dead accessory behavior Mathias requested over an accessory that accepts writes but silently does nothing.

Add focused regression coverage.

### 3. Disabling schedules must remove schedule accessories

Fix the startup/restart case where `hapScheduleAccessories` is empty before synchronization and the legacy sweep correctly skips schedule-owned accessories.

Use the authoritative accessory set already available from the platform rather than relying on the later-populated in-memory map.

Add regression coverage for disable plus restart.

### 4. Fix the `upd_timer` fallback

`upd_timer` is not in `SIMPLE_VACUUM_COMMANDS`, so the current fallback can warn and resolve without sending anything.

Route it through the existing `updateServerTimer` path/order and add a test proving the command is actually sent.

### 5. Treat non-empty but unparsable responses as untrusted

A non-empty raw array whose parser produces zero schedules must not be treated as an authoritative empty schedule list.

- `[]` from a successful response remains authoritative.
- Non-empty + zero parsed schedules is untrusted.
- Preserve the cached snapshot and existing switches on the untrusted response.

Add regression coverage for a plausible alternate response shape.

## Additional fixes from Mathias's review — now in scope

Mathias originally described these as “smaller, take or leave” items. They are now deliberately **in scope for this follow-up** and should be implemented and regression-tested where behavior changes.

### 6. Do not reset HomeKit `ConfiguredName` on every refresh

`updateIdentity()` should avoid rewriting an unchanged `ConfiguredName` on every successful schedule refresh. Preserve a HomeKit-side rename when the displayed schedule identity has not actually changed, following the early-return pattern used by the action-switch implementation.

Add focused regression coverage proving repeated refreshes do not continually overwrite an unchanged HomeKit name.

### 7. Make schedule ordering deterministic

Displayed names currently use `Schedule ${i + 1}` based on the raw cloud array order. Make the ordering deterministic so deleting or reordering schedules in Roborock does not unpredictably renumber the remaining HomeKit switches.

Choose a stable ordering based on the schedule data already available to the coordinator, document the choice, and add regression coverage.

### 8. Ensure `verify()` participates in the schedule refresh/coalescing model

The delayed write verification currently performs its own `getServerTimers()` call. Review the interaction with the coordinator's in-flight refresh and cache so verification does not create an unnecessary parallel cloud request or incorrectly extend the whole-vacuum cache TTL from a single schedule result.

Add focused regression coverage for verification/coalescing and snapshot freshness.

### 9. Prevent disposed coordinators from syncing after teardown

`dispose()` currently clears `refreshInProgress` without necessarily stopping an already-running refresh. Guard the completion path so an in-flight refresh cannot call `sync()` into a coordinator/accessory set that has already been disposed or is being torn down.

Add a regression test that simulates disposal while a refresh is in flight.

### 10. Use the shared timer utility for coordinator timers

The coordinator's `setTimeout` usage should be routed through `src/timers.ts`, which exists so pending timers are tracked and cannot be the reason Homebridge fails to shut down cleanly.

Add or update regression coverage as appropriate for timer disposal/shutdown behavior.

### 11. Reduce routine schedule payload logging to debug

Routine schedule discovery currently logs the full schedule payload at `info` level. Match the logging convention used by comparable paths: normal payload diagnostics belong at debug level, while warnings/errors remain visible at info/warn as appropriate.

Preserve focused operational logs needed to diagnose schedule recovery without logging the full schedule payload every refresh at normal info level.

Add/update a focused logging contract test if needed.

### 12. Document the Q7 neutral `get_server_timer` response

`b01Q7Adapter.js` intentionally maps `get_server_timer` to a neutral `[]` response for Q7/B01 handling. Add a concise comment in the relevant schedule-refresh path so future maintainers understand that this empty response is synthesized by the adapter rather than proof that the robot's cloud schedule set was queried and found empty.

No behavior change is required unless testing reveals one is needed.

## Optional architectural follow-up

Mathias also pointed out an existing non-schedule-specific polling path that could keep the schedule snapshot warm without introducing a new schedule timer: `roborockAPI.updateDataMinimumData` already runs per robot at the existing `updateInterval` and calls `pollParameter(duid, vacuum, "get_server_timer", isB01)`.

This is **not a required blocker for the current follow-up**. If pursued later, feed the existing result into the schedule coordinator/cache rather than adding a permanent schedule-specific polling loop.

## Architectural constraints

Do **not** reintroduce a permanent schedule-specific polling loop.

The first-phase design Mathias approved is:

```text
Roborock cloud
      |
      v
per-vacuum schedule coordinator/cache
      |
      +--> HomeKit read returns cached state immediately
      |
      +--> stale read triggers one async refresh
      |
      +--> fresh snapshot synchronizes all schedule switches
```

There should be one cached snapshot and one in-flight refresh per vacuum. A successful snapshot synchronizes all schedule switches. Failed/untrusted retrieval preserves existing schedules.

The overnight logs showed repeated `get_server_timer` 10-second timeouts for both vacuums, sometimes seconds apart. This is evidence of transient cloud/MQTT request pressure or failure, but **not proof of a formal Roborock rate cap**. The important fix is to prevent failed reads from amplifying the problem with repeated requests.

## Development workflow learned from the first phase

Work in the local checkout first:

```text
~/devProjects/homebridge-roborock-matter-plus
```

Normal workflow:

1. Work on `schedule-refresh-recovery-fixes` locally.
2. Make one focused change at a time.
3. Run targeted tests locally.
4. Run the full typecheck/build/test/lint gate locally.
5. Push the tested branch to GitHub.
6. Install that exact pushed branch on the real Homebridge host.
7. Test with Apple Home and the Roborock app.
8. Bring back only the focused logs needed for diagnosis.

Real-device installation:

```bash
sudo hb-service stop
sudo hb-service add https://github.com/pponce/homebridge-roborock-matter-plus.git#schedule-refresh-recovery-fixes
sudo hb-service start
```

Do not casually uninstall/re-pair the existing Matter installation or change unrelated Homebridge configuration.

### Keep terminal output short

This is an explicit workflow constraint. The user pastes command output into ChatGPT and large output can hit text caps.

Prefer:

- `git status --short`
- `git log -n N`
- targeted tests
- narrow `grep`
- bounded `tail`

Do not ask for whole logs, recursive directory dumps, or large files unless specifically necessary.

## Real Homebridge environment

Homebridge is managed by `hb-service`.

Primary log:

```text
/var/lib/homebridge/homebridge.log
```

Homebridge data root:

```text
/var/lib/homebridge
```

Installed plugin location:

```text
/var/lib/homebridge/node_modules/homebridge-roborock-matter
```

`hb-service`:

```text
/usr/local/bin/hb-service
```

Focused schedule/Roborock log inspection:

```bash
sudo tail -F /var/lib/homebridge/homebridge.log | grep --line-buffered -E "Schedule (discovery|parser|sync|command|refresh)|Roborock"
```

Real validation setup includes two Roborock vacuums:

- `66xmjtyk5YgGyXD9epni7Y`
- `5QNhUVywYYnWc2pPBk3URp`

Other active plugins produce substantial unrelated log traffic, so focused filtering is preferred.

## Tests

### Targeted

- HomeKit GET returns immediately.
- Stale read starts one async refresh.
- Concurrent reads coalesce to one refresh.
- Successful refresh updates all schedule switches.
- Failed refresh preserves the previous snapshot.
- Failed refresh applies backoff/negative caching.
- Reads during backoff do not issue another cloud request.
- Refresh retries after backoff.
- Successful `[]` remains authoritative.
- Non-empty/unparsable response preserves state.
- Failed first discovery cannot leave dead restored accessories.
- Disabling schedules removes persisted schedule accessories.
- `upd_timer` fallback actually sends the command.
- Repeated refreshes do not overwrite an unchanged HomeKit `ConfiguredName`.
- Schedule ordering remains deterministic.
- `verify()` coalesces correctly and does not incorrectly age the full snapshot from a single entry.
- Disposed coordinators cannot sync after teardown.
- Shared timer utility is used for coordinator timers and is safely disposed.
- Routine schedule payload logging is not emitted at info level.
- Q7 neutral `get_server_timer` behavior is documented by a regression/contract check where appropriate.

### Full gate

Run after the changes:

```text
npm run typecheck
tsc -p tsconfig.roborockLib.json
npm run build
npm test
npm run lint
```

Also verify generated `dist/` matches the tested source.

## Real-device validation

After the local gate passes and the branch is pushed:

1. Change a schedule in the Roborock app.
2. Leave Home closed and confirm there is no permanent schedule polling.
3. Open Home and confirm the stale snapshot refreshes asynchronously.
4. Confirm all schedule switches synchronize from one successful snapshot.
5. During a cloud timeout, perform repeated Home reads and confirm reads return immediately without a request storm.
6. Confirm a later successful refresh recovers the cached schedule state.
7. Test schedule writes and the existing delayed verification.
8. Test disabling the schedule feature and restarting Homebridge.
9. Verify a HomeKit rename persists across repeated successful schedule refreshes.
10. Verify schedule switch numbering/order remains stable when the cloud schedule list changes.
11. Verify a write/verification does not create an unnecessary parallel schedule refresh.
12. Exercise teardown/restart while a schedule refresh is in flight and confirm no post-dispose sync occurs.

## Definition of done

- [x] HomeKit GET never waits for Roborock cloud.
- [x] Failed refreshes acquire negative-cache/backoff state.
- [x] Failed first discovery cannot leave silently nonfunctional restored accessories.
- [x] Disabling schedules reliably removes schedule accessories, including after restart.
- [x] `upd_timer` fallback actually sends the command.
- [x] Non-empty/unparsable responses never erase the cached schedule set.
- [x] Successful empty responses remain authoritative.
- [x] Concurrent reads coalesce to one in-flight refresh per vacuum.
- [ ] ConfiguredName is not repeatedly overwritten by unchanged schedule refreshes.
- [ ] Schedule ordering is deterministic.
- [ ] `verify()` participates correctly in the coordinator/coalescing model.
- [ ] Disposed coordinators cannot sync after teardown.
- [ ] Coordinator timers use the shared timer utility.
- [ ] Routine schedule payload logging is debug-level rather than info-level.
- [ ] Q7 neutral `get_server_timer` behavior is documented.
- [ ] Targeted regression tests pass for the completed follow-up scope.
- [ ] Full typecheck/build/test/lint gate passes.
- [ ] Generated `dist/` matches the tested source.
- [ ] Tested branch is pushed before real-device installation.
- [ ] Real Homebridge/HomeKit validation passes for the completed follow-up scope.
- [ ] No permanent schedule polling is introduced.

## Next-chat continuity

Start by reading this file, then inspect the current branch state. Do not redo the first-phase schedule architecture.

The three important branches remain:

- `main` = clean Mathias 3.15.3.
- `schedule-refresh-recovery-clean` = completed first-phase work.
- `schedule-refresh-recovery-fixes` = current follow-up work.

The next implementation work should proceed one focused item at a time, starting with **non-empty but unparsable schedule responses**. Keep changes local, tests local, pushes deliberate, and real-device testing only after the tested branch is on GitHub.
