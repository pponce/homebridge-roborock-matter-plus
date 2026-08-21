# Schedule Refresh & Recovery Fixes Plan

## Purpose

This is the continuity plan for the follow-up work requested by Mathias after his review of `schedule-refresh-recovery-clean`.

The implementation branch for this work is:

- Repository: `pponce/homebridge-roborock-matter-plus`
- Base branch: `schedule-refresh-recovery-clean`
- Base commit: `17639204fc481207e11afea84f3a6dbc0846389f`
- New branch: `schedule-refresh-recovery-fixes`

The existing `SCHEDULE_REFRESH_RECOVERY_PLAN.md` remains the record of the completed first phase. This file records only the follow-up fixes.

## Important upstream finding: Mathias moved past 3.15.0

The `schedule-refresh-recovery-clean` branch was based on Mathias's `v3.15.0` commit `b850c17`. Mathias has since made six commits on upstream `main`, including releases 3.15.1, 3.15.2, and 3.15.3. The current upstream tip is `02cdd263` (3.15.3).

Relevant release commits:

- `e00e36a` — 3.15.1: fixes whole-home clean progress reporting when the run starts outside HomeKit.
- `1d7a19e` — 3.15.2: extends that fix to runs started from the Roborock app, schedules, robot buttons, or voice assistants.
- `9dcf85b` — README test-count maintenance.
- `8ab4299` — makes README test-count synchronization command-driven.
- `02cdd263` — 3.15.3: prevents a false empty-water-tank block during vacuum-only runs and updates the related 3.15.0 changelog note.
- `23befb9` — documentation correction about Matter phase rendering.

The exact upstream comparison shows `b850c17` is the merge base and current `main` is six commits ahead. Therefore this follow-up should not silently remain on the old 3.15.0 code.

### Baseline integration rule

Before functional fixes are implemented:

1. Merge or otherwise integrate Mathias's current upstream `main` / 3.15.3 into `schedule-refresh-recovery-fixes`.
2. Resolve conflicts by preserving the schedule-refresh/recovery behavior from `schedule-refresh-recovery-clean` while taking Mathias's post-3.15.0 changes where they touch the same files.
3. Run the release gate after the upstream integration before making schedule-specific fixes.
4. Keep the upstream integration separately identifiable from the functional schedule fixes.

Do **not** replace the new branch's base with upstream `main`: the requested schedule work must remain based on `schedule-refresh-recovery-clean`.

## Mathias's blocker

### 1. HomeKit GET must not wait for Roborock cloud

Current shape:

```ts
.onGet(async () => {
  await this.coordinator.refreshIfNeeded();
  return this.schedule.enabled;
});
```

Mathias identified the problem precisely: the HomeKit read waits through the coordinator to the Roborock cloud request. HAP-NodeJS warns at roughly 3 seconds and hard-fails the read around 9 seconds, while the schedule request has a 10-second timeout.

Required change:

```ts
.onGet(() => {
  void this.coordinator.refreshIfNeeded();
  return this.schedule.enabled;
});
```

The read returns the cached value immediately. The refresh happens asynchronously and the coordinator's existing synchronization path updates the characteristic when the authoritative snapshot arrives.

### 2. Prevent failed refreshes from immediately retrying on every read

Current failure behavior leaves `lastScheduleRefreshAt` unchanged. A failed cloud request therefore leaves the snapshot stale and allows the next HomeKit read to start another full cloud request.

This matches the overnight evidence from 2026-08-21: repeated `get_server_timer` 10-second timeouts occurred for both vacuums, sometimes only seconds apart, with the same failure logged repeatedly.

Required behavior:

- A failed/untrusted refresh must not change the cached schedule snapshot.
- It must not remove existing switches.
- It must record enough failure state to suppress immediate repeated cloud attempts.
- The exact failure-backoff implementation should be chosen during coding, following Mathias's suggestion of either stamping the existing refresh timestamp or maintaining a separate `lastFailedRefreshAt` with a short backoff.
- The backoff must not become a permanent schedule timer or background poll.
- A later legitimate HomeKit read should be able to retry after the backoff expires.

## Follow-up fixes Mathias listed, in priority order

### 3. Failed first discovery must not leave dead restored accessories

Mathias identified a startup edge case:

- Homebridge can restore schedule services from disk.
- `platform.ts` currently deletes the coordinator when initialization fails.
- `discoverDevices()` has no later retry path for that failed initialization.
- The restored accessory can therefore appear alive while its GET/SET handlers are never attached.

Plan:

- Trace the startup/discovery failure path in `platform.ts` and the coordinator construction path.
- Ensure a failed first refresh does not create a misleading half-initialized schedule accessory.
- Preserve the existing rule that transient schedule retrieval failure does not mean zero schedules.
- Add a focused regression test covering startup with a failed initial schedule retrieval and restored HAP state.
- Prefer a visibly unavailable/absent schedule accessory over a dead-looking accessory that accepts writes but cannot send them, as Mathias requested.

### 4. Disabling the schedule feature must remove schedule accessories correctly

Mathias found that `platform.ts:596-602` iterates `this.hapScheduleAccessories`, but the map is empty at startup because `syncHapSchedules` populates it later. The legacy sweep now correctly skips schedule-owned accessories, so the schedule accessories can survive an untick-plus-restart indefinitely.

Plan:

- Trace the startup config-disable path and the persisted HAP accessory inventory.
- Use the same authoritative accessory set used by `syncActionSwitches` rather than relying on the in-memory map being populated.
- Ensure disabling the feature removes schedule-owned accessories both during the current process and after restart.
- Add regression coverage for the disable/restart scenario.

### 5. Fix the `upd_timer` fallback path

Mathias found that `hap_schedule_api.ts` checks `api.startCommand` first, but `upd_timer` is not in `SIMPLE_VACUUM_COMMANDS`. The fallback therefore logs that the command is not found and resolves without actually sending it.

Plan:

- Update the fallback ordering/selection so `upd_timer` reaches the existing `updateServerTimer` path.
- Preserve the existing `throwOnError` behavior for the command path.
- Add/adjust a focused test proving the fallback actually invokes `updateServerTimer` and does not silently resolve without sending anything.
- Keep the existing approximately 3-second post-write verification behavior intact.

### 6. Treat parser-unreadable non-empty responses as untrusted, not as zero schedules

Mathias identified two separate questions in `performRefresh`:

- `Array.isArray(raw)` determines whether the response is structurally an array.
- `parseServerTimers(raw).length` determines how many tuples the parser understood.

A response can therefore be a non-empty array that the parser cannot understand. Treating that as an empty authoritative schedule list would delete all schedule switches.

Plan:

- Preserve the distinction between successful empty response and malformed/untrusted response.
- If `raw` is non-empty but parsing yields zero schedules, treat the response as untrusted unless the API contract proves it is genuinely empty.
- Preserve the existing schedule snapshot and HAP switches on such a response.
- Add regression tests using a plausible alternate response shape such as object entries instead of `[id, on/off, ...]` tuples.
- Keep genuinely successful `[]` responses authoritative and able to reconcile all schedules away.

## Smaller items from Mathias's review

These were explicitly described as "smaller, take or leave" and are **not required for the next review pass unless implementation reveals a direct reason to include them**:

- Avoid resetting HomeKit ConfiguredName on every successful refresh.
- Address index-based display names if stable user-visible naming across deletion matters.
- Route `verify()` through the coalescer if appropriate.
- Prevent `dispose()` from allowing an in-flight refresh to call `sync()` after teardown.
- Route the pending timer through the shared timer helper.
- Reduce unconditional schedule info logging for users who never enabled schedules and avoid logging full payloads at info level.

Do not expand scope into these items without a concrete regression or a direct need for the merge blocker.

## Cloud request / overnight log interpretation

The overnight logs show:

- `get_status` timing out for one robot at 05:29:46.
- `get_server_timer` timing out for both robots at 06:04:01.
- Repeated `get_server_timer` timeouts for both robots from 07:12 onward, including retries only seconds apart.

This is strong evidence of a refresh retry storm during a period when the Roborock cloud/MQTT path was not responding. It is **not by itself proof of a Roborock rate limit**. The more immediate code-level problem is exactly the one Mathias identified: failed refreshes do not currently acquire negative-cache/backoff state, so each new HomeKit read can pay for another 10-second request.

The new implementation should therefore be measured by request behavior, not by assuming a specific Roborock cap:

- no cloud request on an immediate repeated HomeKit read after a failed refresh;
- at most one in-flight `get_server_timer` per vacuum;
- no permanent schedule polling;
- retry only after the defined failure backoff or another explicitly legitimate trigger;
- successful snapshots remain authoritative and synchronize all schedule switches.

## Test plan

### Targeted coordinator/HAP tests

- HomeKit GET returns immediately without awaiting cloud refresh.
- Stale GET starts one asynchronous refresh.
- Multiple simultaneous GETs share one refresh promise.
- Successful async refresh updates every schedule switch.
- Failed refresh preserves the previous snapshot.
- Failed refresh records failure/backoff state.
- Repeated GETs during failure backoff do not issue another cloud request.
- Refresh retries after the failure backoff expires.
- Successful empty snapshot remains authoritative.
- Non-empty but unparsable snapshot is rejected/preserved.

### Startup/config tests

- Failed first discovery cannot leave a restored-but-dead schedule accessory.
- Disabling schedule switches removes persisted schedule-owned accessories after restart.

### Command tests

- `upd_timer` fallback actually sends the update.
- Existing command verification remains intact.

### Full gate

Run after upstream integration and again after all functional changes:

```text
npm run typecheck
tsc -p tsconfig.roborockLib.json
npm run build
npm test
npm run lint
```

Also verify `dist/` matches the final source build.

## Real-world validation

After the code and tests are green, validate on the real Homebridge installation:

1. Change a schedule in the Roborock app.
2. Do not open Home for a controlled interval and confirm there is no schedule-specific cloud polling.
3. Open Home and confirm the stale cached state causes one authoritative refresh and the switch updates.
4. Temporarily induce/observe a cloud timeout and perform repeated Home reads; confirm the reads return immediately and do not generate a request storm.
5. Confirm a later successful refresh updates all switches from one snapshot.
6. Confirm schedule enable/disable commands and their verification still work.
7. Confirm no schedule switches disappear on a transient refresh failure.
8. Confirm disabling the feature removes schedule accessories correctly.

## Definition of Done

- [ ] New branch remains based on `schedule-refresh-recovery-clean`.
- [ ] Mathias upstream 3.15.1–3.15.3 changes are integrated without losing the schedule work.
- [ ] HomeKit GET never waits for the Roborock cloud.
- [ ] Failed refreshes acquire a negative-cache/backoff timestamp.
- [ ] No repeated cloud request storm during a failure.
- [ ] Failed first discovery cannot leave dead restored schedule accessories.
- [ ] Disabling the schedule feature removes schedule accessories reliably.
- [ ] `upd_timer` fallback actually sends the command.
- [ ] Unreadable non-empty schedule responses never erase the cached schedule set.
- [ ] Successful empty responses remain authoritative.
- [ ] Targeted regression tests pass.
- [ ] Full typecheck/build/test/lint gate passes.
- [ ] Real Homebridge/HomeKit validation passes.

## Continuity for the next chat

The next chat should begin by reading this file and the existing `SCHEDULE_REFRESH_RECOVERY_PLAN.md`. The working branch is `schedule-refresh-recovery-fixes` and its intended parent is `schedule-refresh-recovery-clean` at `17639204`.

Do not start by re-implementing the original schedule-refresh architecture. That work is already complete. The next task is to integrate Mathias's post-3.15.0 upstream changes and address the review findings above with focused tests and minimal changes.
