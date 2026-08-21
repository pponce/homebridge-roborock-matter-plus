# Schedule Refresh & Recovery Plan

## Current repository strategy — 2026-08-21

- Repository: `pponce/homebridge-roborock-matter-plus`
- `main` must remain a clean copy of Mathias's upstream release, with no fork-specific changes.
- Mathias upstream is currently **3.15.3**, commit `02cdd263aa55b703dd45da1ed4967d43b927b896`.
- `main` has been reset to that exact upstream commit.
- `schedule-refresh-recovery-clean` remains the reviewed/validated first-phase branch based on Mathias 3.15.0 and contains the completed schedule cache/coalescing/recovery work.
- `schedule-refresh-recovery-fixes` is the next working branch. It is based on `schedule-refresh-recovery-clean` and is where Mathias's requested follow-up fixes will be implemented.

## First-phase work already completed

Mathias reviewed `schedule-refresh-recovery-clean` and said the caching design, coalescer, and scoped `roborockLib` change were the right shape. The branch has:

- No permanent three-minute schedule polling timer.
- One cached schedule snapshot per vacuum with approximately 60-second freshness.
- One in-flight refresh promise per vacuum to coalesce concurrent requests.
- HomeKit reads refresh stale snapshots from Roborock cloud.
- One successful snapshot synchronizes all schedule switches for that vacuum.
- Failed/untrusted schedule retrieval preserves existing schedules rather than treating failure as zero schedules.
- Schedule discovery is independent of local vacuum reachability.
- Existing schedule writes and delayed verification remain intact.
- Stable schedule-ID reconciliation is preserved.
- Real Homebridge/HomeKit testing confirmed that opening Home causes a stale snapshot to refresh from Roborock, while leaving Home closed does not create continuous schedule polling.

## Mathias follow-up — required fixes

Mathias's 2026-08-21 review identified one blocker and four additional fixes, in priority order.

### Blocker

**HomeKit GET must not wait for the Roborock cloud.**

Current pattern:

```js
.onGet(async () => {
  await this.coordinator.refreshIfNeeded();
  return this.schedule.enabled;
});
```

Required direction:

```js
.onGet(() => {
  void this.coordinator.refreshIfNeeded();
  return this.schedule.enabled;
});
```

The read should return the cached value immediately; the asynchronous refresh should update the characteristic when the fresh snapshot arrives. This prevents HAP's approximately 3-second warning / approximately 9-second hard read timeout from being exceeded by the existing 10-second cloud request timeout.

Also add failure timestamp/backoff behavior so repeated HomeKit reads during a cloud outage do not each initiate another 10-second request.

### Additional fixes

1. **Failed first refresh:** avoid restoring apparently-live schedule accessories that have no working handlers when initial discovery fails. Mathias prefers a visibly dead accessory over one that appears functional but silently does nothing.
2. **Disable setting:** turning HAP schedules off must actually dispose/remove previously created schedule accessories, including after restart. Do not rely only on the in-memory `hapScheduleAccessories` map populated later by sync.
3. **`upd_timer` fallback:** the fallback currently reaches `startCommand` but `upd_timer` is not in `SIMPLE_VACUUM_COMMANDS`, so it warns and resolves without sending. Use the existing `updateServerTimer` command path/order instead.
4. **Parser safety:** a non-empty Roborock response that the parser cannot understand must not be interpreted as an authoritative empty schedule list. `raw.length > 0 && parsed.length === 0` is an untrusted response and should preserve the current schedule state.

### Smaller follow-ups (only if appropriate after the above)

- Avoid resetting HomeKit ConfiguredName on every successful refresh.
- Consider deterministic schedule ordering rather than relying on cloud-array order.
- Ensure `verify()` uses the coalescer correctly.
- Ensure disposed coordinators cannot sync into a tearing-down bridge after an in-flight refresh completes.
- Route the coordinator timer through the shared timer utility.
- Keep routine schedule payload logging at debug rather than info.
- Add a comment explaining the Q7 `get_server_timer` adapter behavior that returns a neutral empty list.

## Upstream integration plan

Mathias has released **3.15.1, 3.15.2, and 3.15.3** since the previous 3.15.0 baseline. The latest upstream `main` is 3.15.3 (`02cdd263`).

Before implementing the follow-up fixes:

1. Update local `main` from `origin/main` so it exactly matches upstream 3.15.3.
2. Fetch Mathias's upstream remote.
3. On `schedule-refresh-recovery-fixes`, merge Mathias upstream `main` into the branch.
4. Resolve any conflicts while preserving the schedule-refresh-recovery-clean behavior.
5. Run the full local gate before pushing.
6. Push the fixes branch to GitHub.
7. Install the pushed branch on the real Homebridge instance for validation.

The branch must retain `schedule-refresh-recovery-clean` as its functional base; upstream changes are integrated on top before the new fixes are made.

## Development / validation workflow

Work locally first. Do not use GitHub as the development environment.

Typical sequence:

```bash
cd ~/devProjects/homebridge-roborock-matter-plus

git status --short
git branch --show-current
npm test -- --runInBand
npm run build
npx prettier --check .
```

Keep command output short when collecting diagnostics. Prefer targeted `grep`, `tail`, `git log -n`, and individual test commands rather than dumping large logs or full files.

After local changes pass:

```bash
git push origin schedule-refresh-recovery-fixes
```

Then install the pushed branch on the real Homebridge host:

```bash
sudo hb-service stop
sudo hb-service add https://github.com/pponce/homebridge-roborock-matter-plus.git#schedule-refresh-recovery-fixes
sudo hb-service start
```

Use the real Apple Home app and Roborock app for end-to-end validation. Do not treat a local test run as proof of HomeKit/HAP timing behavior.

## Real Homebridge environment

Homebridge is running as an `hb-service` installation. The primary Homebridge log is:

```text
/var/lib/homebridge/homebridge.log
```

Useful live log command:

```bash
sudo tail -F /var/lib/homebridge/homebridge.log | grep --line-buffered -E "Schedule (discovery|parser|sync|command|refresh)|Roborock"
```

The user's real setup includes two Roborock vacuums, with DUIDs observed during validation:

- `66xmjtyk5YgGyXD9epni7Y`
- `5QNhUVywYYnWc2pPBk3URp`

Other Homebridge plugins are active, including deCONZ, homebridge-http-webhooks, UniFi Protect, and Virtual Accessories. Their unrelated log traffic can be very noisy, so targeted Roborock/Schedule filtering is preferred.

## Cloud-request observations

Overnight testing on 2026-08-21 showed repeated `get_server_timer` 10-second timeouts:

```text
Unable to refresh Roborock schedules ... Cloud request ... get_server_timer timed out after 10 seconds. MQTT connection state: true. Preserving existing schedules.
```

These occurred for both vacuums and sometimes repeated within seconds. A separate `get_prop` request also timed out. This strongly suggests the schedule refresh path can encounter Roborock cloud/MQTT request pressure or transient cloud failure; it is **not evidence by itself of a HomeKit bug or proof of a formal Roborock rate cap**. The failure-backoff work above is therefore important to avoid amplifying a cloud problem.

## Important architectural constraint

Do **not** reintroduce a permanent schedule-specific polling loop merely to work around HomeKit reads. Mathias explicitly preferred the cached/coalesced design and did not want a dedicated periodic schedule poll. The desired model is:

```text
Roborock cloud
      |
      v
per-vacuum coordinator/cache
      |
      +--> HomeKit reads return cached state immediately
      |
      +--> stale read triggers one async refresh
      |
      +--> fresh snapshot synchronizes every schedule switch
```

The existing broader Roborock polling infrastructure may be reused only where it already exists and where doing so does not create a new schedule-specific polling loop.

## Definition of done for this phase

- [ ] Local `main` exactly matches Mathias 3.15.3.
- [ ] `schedule-refresh-recovery-fixes` contains clean + upstream 3.15.3 integration.
- [ ] HomeKit GET no longer waits on the cloud.
- [ ] Failed refreshes receive negative-cache/backoff treatment.
- [ ] Failed initial discovery cannot leave silently nonfunctional restored accessories.
- [ ] Disabling HAP schedules removes/disposes existing schedule accessories, including after restart.
- [ ] `upd_timer` fallback actually sends the intended command.
- [ ] Parser rejects non-empty-but-unparseable responses as authoritative empties.
- [ ] Mathias's existing clean gate passes, apart from the known sandbox-only `ui-server-local-probe` failure if reproduced there.
- [ ] Real Homebridge/HomeKit validation passes.
- [ ] No permanent schedule polling timer is introduced.

## Continuity

This file is the handoff document for the next development chat. Before changing code, re-read it and inspect the current GitHub branch/commit state. Preserve the distinction between:

- `main` = clean Mathias upstream.
- `schedule-refresh-recovery-clean` = completed first-phase schedule refresh/recovery work.
- `schedule-refresh-recovery-fixes` = follow-up work requested by Mathias.
