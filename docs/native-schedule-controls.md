# Native schedule controls: requirements and open decisions

Status: design discussion. These controls are not implemented by this document.

## Confirmed requirements

- Implement inside `homebridge-roborock-matter-plus`, using the existing account
  connection and native schedule controls. Runtime must not depend on Script2,
  external scripts, cron, or the separate pause project's systemd timers.
- Preserve the behavior of `pponce/roborockPauseSchedules` for individual pause,
  Pause All, and the global Pause Until Tomorrow preference.
- Add one momentary Pause for 1 Hour switch per vacuum and one momentary
  Pause All for 1 Hour switch. Repeated presses add another hour.
- The one-hour action must stop a cleaning vacuum and return it to its dock,
  as the existing ordinary pause does. Postpone the interrupted scheduled run
  along with the other affected schedules for that vacuum on that day.
- Calculate the new time from the original scheduled time plus accumulated
  one-hour increments, rather than automatically using one hour from the press.
- Affect schedules that run on the current day only. Schedules with no occurrence
  that day must not have their times changed.
- A vacuum with an active ordinary pause must be skipped by the one-hour action.
  The all-vacuum action evaluates each vacuum separately, so a paused vacuum
  does not prevent an eligible vacuum from being postponed.
- Only schedules that were active are eligible. Already-disabled schedules must
  remain disabled. The cloud job's enabled field alone does not establish this:
  Uptown's enabled cloud definitions were observed alongside disabled robot timers.
- Preserve original schedule times and return to normal timing the next day.

## Existing behavior to retain

Reviewed the current `master` README and controller sources in
[roborockPauseSchedules](https://github.com/pponce/roborockPauseSchedules).

- Individual Pause ON saves per-schedule enabled states, then disables schedules.
  Once schedules are observed off, a cleaning vacuum receives one return-to-dock
  request. A robot already docked or not cleaning needs no docking action.
- Individual Pause OFF restores states owned by that pause and preserves detected
  manual changes. It does not automatically restart the interrupted cleaning job.
- Pause All ON pauses the configured vacuums. OFF restores all active pauses,
  including those started individually. Its displayed state is ON if any vacuum
  has an active pause display.
- Pause Until Tomorrow is a persistent preference, defaulting to ON in the old
  controller when no preference has been saved. It does not initiate a pause.
  The old optional timer restores active pauses at 00:05 in the host's local
  timezone when this preference is ON. OFF leaves them paused until resumed.
- Saved state and bounded reconciliation survive process restarts. Preserve
  user-visible behavior without copying the old polling-via-Homebridge approach.

The plugin already exposes routine actions as momentary HAP Switch services.
Use that interaction pattern for the new one-hour actions. HAP's programmable
switch event is a read/notify event from an accessory; the normal On
characteristic supports controller writes.

## Decisions to settle before implementing postponement

1. What if the proposed time has already passed? Example: a 09:00 scheduled run
   is still cleaning at 10:30, so adding one hour produces 10:00 in the past.
   Choose whether to advance by enough whole-hour increments to make it future,
   use a different restart deadline, or skip the affected occurrence. Do not
   silently write a past recurring time and claim that the run will restart.
2. What happens across midnight? A 23:30 run shifted one hour would fall at 00:30.
   Choose whether it carries into tomorrow or is skipped for this day, with
   tomorrow's normal schedule retained. Carrying it forward requires coordinating
   restoration with the deferred occurrence and tomorrow's scheduled work.
3. What if the current cleaning job was started manually? The user requires
   stopping/docking active cleaning, but a manual job has no original scheduled
   time. Proposed behavior: postpone the day's eligible schedules and do not
   invent a new scheduled occurrence for the manual job. Confirm this behavior.

The scope and active-cleaning questions from the first discussion were answered:
all affected runs for that day shift, and active cleaning is stopped and docked.
The new cloud trigger may start the interrupted schedule again from its beginning;
resuming exactly where it left off has not been verified. Reliable identification
of the currently running schedule also needs investigation. Do not infer task
identity solely from whichever schedule most recently became due.

## Proposed defaults, subject to the design discussion

- No remaining eligible runs: do nothing; do not pre-delay tomorrow's schedules.
- Accumulate deliberate presses, including global then individual presses,
  without applying retries as additional increments.
- Ordinary Pause ON takes precedence: cancel remaining postponement, restore
  original times while schedules remain paused, and retain the original enabled
  states for the eventual unpause. The global tomorrow preference does not gate
  the separate requirement to restore postponed times the next day.
- Detected manual edits take precedence. Do not overwrite changed definitions or
  recreate deleted schedules. New schedules are not silently added to an earlier
  postponement. Stop managing conflicting records and make the conflict visible.
- Proposed completed-run rule: leave finished runs alone; only the interrupted
  run and not-yet-started runs should be postponed. Do not repeat completed or
  missed occurrences as a side effect of restoration. Guard against due-time
  races and verify how completed/interrupted runs can be identified.
- Serialize overlapping controls per vacuum and use the existing account queue.
  Persist the original and intended result before each cloud mutation; verify
  changes and restoration against fresh reads.
- Handle global actions per vacuum and expose partial failures. A completed
  momentary tile reset alone is not proof that every cloud write succeeded.
- On restart, recover saved operations and overdue restorations before accepting
  further postponement. Use bounded retries and report unresolved changes.

## Operational limitation

Cloud edits are persistent. The plugin cannot restore a cloud schedule at the
intended reset time while Homebridge is stopped or the cloud is unreachable.
Recovery should restore it when connectivity returns, but exact-time restoration
during an outage is not guaranteed. This needs to be clear in the implementation
and user documentation. Use each schedule's timezone for postponement/date math;
the existing global pause-expiration preference uses the host's local timezone.

## Migration

Keep the old setup active during development. Before enabling native controls:

1. Inspect and preserve the old controller's original enabled-state snapshots.
   Resolve active pauses or explicitly transfer their originals; currently-off
   switches do not reveal which schedules should later be restored.
2. Stop the old reconciliation and optional midnight timers and allow active
   workers to finish. Check for any separately configured cron or automation
   entries that invoke the old controller.
3. Disable only the old Roborock Script2 accessories and their invocations.
   Other Script2 uses should continue working.
4. Enable and verify the native controls, then update Home automations that
   reference the replaced accessories. Keep old state available through cutover.

Provide the migration as one SSH-safe Bash block with START/STOP output markers.
Any plugin installation must retain compiled dist files on GitHub and use
`sudo hb-service stop`, `sudo hb-service add`, then `sudo hb-service start`.
