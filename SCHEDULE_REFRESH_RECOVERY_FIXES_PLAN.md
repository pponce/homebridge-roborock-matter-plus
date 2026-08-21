# Schedule Refresh & Recovery Fixes Plan

## Progress update — 2026-08-21

### Verified implementation and real-device results

The first recovery phase is now implemented and validated locally and on the real Homebridge installation.

- **HomeKit GET is non-blocking.** The schedule switch GET starts `refreshIfNeeded()` asynchronously and immediately returns the cached schedule state.
- **One cached snapshot + one in-flight refresh per vacuum.** Real HomeKit testing produced many simultaneous schedule GETs, but the coordinator coalesced them into one refresh/cloud request per vacuum and synchronized all schedule switches from the resulting snapshot.
- **Successful refreshes update the shared schedule snapshot and synchronize all HAP schedule switches.**
- **Failed refreshes preserve the existing cached schedule/accessories.**
- **Failure backoff / negative caching is active at 30 seconds.** During a real Roborock MQTT/cloud timeout, repeated HomeKit reads returned the preserved cached state and entered `FAILURE BACKOFF` rather than issuing additional cloud requests.
- **Real-device failure test passed.** Both vacuums experienced `get_server_timer` cloud timeouts, preserved their existing schedule state, and suppressed repeated refreshes during the backoff window.
- **Schedule-switch disable/restart validation passed.** With `enableHomeKitScheduleSwitches=false`, Homebridge restarted successfully without rediscovering/restoring schedule switches.
- **Targeted schedule tests:** 21/21 passed.
- **Full test suite:** 86/86 suites passed, 1,337/1,337 tests passed.
- **Build/typecheck:** passed.

### Remaining recovery items

The following plan items remain intentionally open and have not yet been marked complete:

- Failed first discovery must not leave dead/nonfunctional restored schedule accessories.
- `upd_timer` fallback must actually send the command.
- Non-empty but unparsable schedule responses must be treated as untrusted and must preserve the cached snapshot.
- Final end-to-end validation of recovery after the failure/backoff window expires is still pending on real hardware.


This is the **active handoff plan** for the follow-up work requested by Mathias after his review of `schedule-refresh-recovery-clean`.

The historical first-phase record is `SCHEDULE_REFRESH_RECOVERY_PLAN.md`. Do not use that file as the active follow-up plan.

## Current repository state

- Repository: `pponce/homebridge-roborock-matter-plus`
- Clean upstream baseline: `main` = Mathias `v3.15.3` (`02cdd263`)
- Completed first phase: `schedule-refresh-recovery-clean`
- Active follow-up branch: `schedule-refresh-recovery-fixes`
- Follow-up branch is based on `schedule-refresh-recovery-clean` with Mathias 3.15.3 merged on top.
- Current branch tip after plan cleanup: `cbf6ff3`
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

## Smaller review items

Mathias listed these as take-or-leave rather than blockers. Do not expand scope unless needed:

- Avoid resetting HomeKit `ConfiguredName` on every refresh.
- Consider deterministic schedule ordering.
- Ensure `verify()` uses the coalescer correctly.
- Prevent disposed coordinators from syncing after teardown.
- Route the coordinator timer through the shared timer utility.
- Keep routine schedule payload logging at debug rather than info.
- Comment the Q7 adapter's neutral `get_server_timer` response.

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

## Definition of done

- [x] HomeKit GET never waits for Roborock cloud.
- [x] Failed refreshes acquire negative-cache/backoff state.
- [ ] Failed first discovery cannot leave silently nonfunctional restored accessories.
- [x] Disabling schedules reliably removes schedule accessories, including after restart.
- [ ] `upd_timer` fallback actually sends the command.
- [ ] Non-empty/unparsable responses never erase the cached schedule set.
- [ ] Successful empty responses remain authoritative.
- [ ] Targeted regression tests pass.
- [ ] Full typecheck/build/test/lint gate passes.
- [ ] Generated `dist/` matches the tested source.
- [ ] Tested branch is pushed before real-device installation.
- [ ] Real Homebridge/HomeKit validation passes.
- [ ] No permanent schedule polling is introduced.

## Next-chat continuity

Start by reading this file, then inspect the current branch state. Do not redo the first-phase schedule architecture.

The three important branches remain:

- `main` = clean Mathias 3.15.3.
- `schedule-refresh-recovery-clean` = completed first-phase work.
- `schedule-refresh-recovery-fixes` = current follow-up work.

Begin implementation with Mathias's blocker: fire-and-forget HomeKit GET plus failure backoff. Keep changes local, tests local, pushes deliberate, and real-device testing only after the tested branch is on GitHub.
