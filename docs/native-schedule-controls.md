# Native schedule controls: requirements and open decisions

Status: the ten-minute occurrence selector is implemented and unit-tested.
The native Home controls and persistent controller are not implemented yet.

## Confirmed requirements

- Implement inside `homebridge-roborock-matter-plus`, using the existing account
  connection and native schedule controls. Runtime must not depend on Script2,
  external scripts, cron, or the separate pause project's systemd timers.
- Preserve the saved-state restore and docking behavior of
  `pponce/roborockPauseSchedules` for individual pause and Pause All. The latest
  requested native UI exposes Pause Until Tomorrow as an optional feature with
  individual and aggregate controls; see the layout below.
- Add one momentary timed-pause switch per vacuum and one momentary timed-pause
  switch for all vacuums. One shared configurable interval applies to every
  timed-pause switch; default 60 minutes, with values such as 15 or 30 minutes
  supported. Do not expose several independently configured duration switches.
  Repeated presses re-evaluate eligibility using the current delayed times and
  add one configured interval to each qualifying occurrence.
- The timed-pause action must stop a cleaning vacuum and return it to its dock,
  as the existing ordinary pause does. Postpone occurrences selected by the
  ten-minute rule below for that vacuum on that day.
- Docking applies whether cleaning was started manually or by a schedule.
  Use the owner's ten-minute rule below to choose whether a recent scheduled
  occurrence is included alongside the remaining future occurrences.
- Manual runs started in the Roborock app or Home app remain independent of
  schedule management. Do not create, shift, automatically resume or replay a
  manual cleaning job. An explicit Pause ON or delay command still docks any
  active cleaning, regardless of origin. Manual runs started afterward are
  allowed to proceed; pause state is not a continuous ban on cleaning.
- Calculate the new time from the original scheduled time plus accumulated
  configured intervals, rather than automatically using that interval from the
  time of the press.
- Affect schedules that run on the current day only. Schedules with no occurrence
  that day must not have their times changed.
- A vacuum with an active ordinary pause receives no additional schedule delay.
  The all-vacuum action evaluates each vacuum separately, so a paused vacuum
  does not prevent an eligible vacuum from being postponed. The latest explicit
  docking rule is separate: a pause/delay command still sends active cleaning
  home, while already-paused schedules remain unchanged.
- Only schedules that were active are eligible. Already-disabled schedules must
  remain disabled. The cloud job's enabled field alone does not establish this:
  Uptown's enabled cloud definitions were observed alongside disabled robot timers.
- Preserve original schedule times and return to normal timing at the daily
  reset. Make the reset time configurable in plugin settings, default `00:05`.
  Use this same setting for ordinary Pause Until Tomorrow expiration and
  restoration of temporary time shifts.
- Add stateful Delay Active controls per vacuum and for all vacuums with the
  Delay feature. These replace the initially requested momentary Reset Schedule
  Times controls. ON reflects an applied schedule-time delay. OFF restores saved
  original times and cancels accumulated delay. Preserve pause/enable states;
  restoring times does not dock, start or resume cleaning and does not cancel a
  separate pause-until-reset expiry. Automatic restoration clears this state too.
- The all-vacuum Delay Active switch is ON if any vacuum has a delay. OFF restores
  all active delays, including those started individually. Keep the momentary
  Delay for X switches as the explicit way to add or extend a delay.
- If another interval would move an affected occurrence past the next reset time,
  convert that vacuum to a pause until the reset instead of extending the delay.

## Configuration UI and Home controls

Expose two independent feature options under Schedule controls:

| Setting | Default | Visibility and effect |
| --- | --- | --- |
| Enable Pause Until Tomorrow | Off | Adds one persistent pause switch per vacuum and one Pause All switch. |
| Enable Delay Schedules | Off | Adds momentary Delay for X and stateful Delay Active switches per vacuum, plus corresponding all-vacuum switches. |
| Delay interval (minutes) | 60 | Shown beneath Enable Delay Schedules when enabled; shared by every delay switch. |
| Daily reset time | 00:05 | Shown once when either feature is enabled; shared by both features and their individual/all-vacuum controls. |

The options are independent; users may enable either one or both. Both options
enabled for two vacuums add nine control switches. Keep the shared reset setting
outside either feature's dependent fields so it is not duplicated or hidden
when only the other feature is enabled.

Interpretation of the requested Pause Until Tomorrow group: ON pauses the chosen
vacuum(s) until the next configured reset, and OFF restores early. This replaces
the old setup's separate global Pause Until Tomorrow preference tile; do not add
that extra tile alongside these controls. The old controller's behavior below
is reference material, not a requirement to retain its separate preference UI.

The Delay feature must work independently of whether the Pause Until Tomorrow
controls are displayed. Crossing the delay cutoff still creates a per-vacuum
pause until reset when only Delay is enabled. Hiding or disabling a feature must
not discard saved originals or abandon outstanding restoration work.

These are requirements for the eventual working UI. Do not publish selectable
configuration fields that have no implemented runtime behavior. Integrate the
custom Homebridge UI, schema, TypeScript configuration and committed dist together.

For the stateful controls, the ON display must follow saved, verified delay state,
not the most recent button press. If restoring some schedules fails, preserve
their originals and keep the affected Delay Active indicator ON until restoration
succeeds or a conflicting manual edit is explicitly reconciled. A reset must not
visually claim success just because the user requested OFF.

The remaining switch interaction to choose is manually turning an inactive
Delay Active switch ON. Recommended behavior: apply one delay interval; repeated
ON writes while already active do not add time. Extra increments remain on the
momentary Delay for X controls. For the all-vacuum stateful control, this would
apply one interval only to eligible vacuums without an existing active delay.

## Shared pause interval

Expose one plugin setting, Pause interval (minutes), default 60. Validate a
positive whole number of minutes. The configured interval is shared by the
individual and all-vacuum timed-pause actions. Each accepted press uses that
interval once; transport retries must not count as another press.

Persist accumulated delay in minutes, not just a press count. Changing the
setting applies to future presses and does not recalculate already-applied
delays. Example: one 60-minute press followed by changing the setting to 15 and
pressing again produces 75 minutes of accumulated postponement.

Use stable accessory identifiers independent of the configured duration. Default
display names can include the selected interval, while preserving user-assigned
names. Apple Home can cache names, so do not promise that changing an accessory's
reported name immediately renames an existing Home tile.

## Daily reset and postponement cutoff

Use a daily local clock setting in `HH:mm` form with default `00:05`, in the
Homebridge host's timezone to match the existing expiration timer. Compare
actual occurrence timestamps with the next reset timestamp; do not compare
clock strings. Each cloud schedule still uses its own timezone for cron math.

Proposed boundary and scope details for this requirement:

- Treat a proposed run exactly at the reset as exceeding the postponement
  window as well, avoiding a race between cloud execution and restoration.
- Check every affected run before applying an increment. If any would reach or
  exceed the cutoff, pause the entire affected vacuum until the reset.
- Preserve its original enabled-state snapshot, dock it if cleaning, and restore
  original times while schedules remain paused. At reset, restore the enabled
  states owned by this pause, preserving detected manual changes.
- Give the converted pause an explicit per-vacuum expiry without changing
  unrelated vacuums' pause policies.
  A global timed-pause press makes this decision separately for each vacuum.
- The ordinary Pause tile shows paused after conversion, so subsequent timed-pause
  presses do not alter its schedules under the already-paused rule. Their explicit
  docking action still applies to active cleaning. Ordinary unpause can end this
  pause before its expiry.
- Midnight is not itself the cutoff. With a `00:05` reset, a 23:00 occurrence
  shifted to 00:00 can still run before reset; 23:30 shifted to 00:30 converts
  to a pause until reset. A postponed occurrence keeps its original occurrence
  date even when its temporary run time passes midnight.

## Reference behavior in the old setup

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
  The new requested UI instead provides direct pause-until-reset controls as
  described above, without the extra global preference tile.
- Saved state and bounded reconciliation survive process restarts. Preserve
  user-visible behavior without copying the old polling-via-Homebridge approach.

The plugin already exposes routine actions as momentary HAP Switch services.
Use that interaction pattern for the new timed-pause actions. HAP's programmable
switch event is a read/notify event from an accessory; the normal On
characteristic supports controller writes.

## Ten-minute eligibility rule, including stacked presses

The owner chose this timing heuristic on 2026-10-09, replacing the proposal to
identify scheduled runs from cleaning history. No run-history diagnostic or
automatic completion matching is required for this design.

For every individual or all-vacuum Delay press, evaluate each vacuum separately
using fresh cleaning/timer state and the timestamp of the press:

1. If the vacuum's schedules are already paused, make no schedule changes.
2. Include enabled occurrences for today whose current scheduled time is later
   than the press. Use effective delayed times, not the saved original times.
3. If the vacuum is actively cleaning, also include the most recent enabled
   occurrence for today between the press minus ten minutes and the press,
   inclusive. A robot returning home or merely sitting at the dock does not by
   itself establish active cleaning.
4. If it is not cleaning, include no past occurrences. A later stacked press
   must not re-add an old occurrence just because an earlier press included it.
5. Add exactly one configured interval to each selected current scheduled time.
   Preserve the first original time separately for automatic/manual restoration.
   Keep the existing next-reset cutoff and already-disabled exclusion.
6. An explicit Delay command still docks active cleaning regardless of its
   origin or whether a schedule qualifies. Do not create a scheduled job for a
   manual clean or continuously enforce docking afterward.

Example with a sixty-minute interval: press at 09:05 while cleaning after a
09:00 schedule, moving it to 10:00. A second press at 09:20 moves that still-future
occurrence to 11:00 even though the vacuum has docked. A press at 11:04 while it
is cleaning can move 11:00 to 12:00. Its original remains 09:00 for restoration.

This heuristic cannot guarantee that every completed schedule is excluded. A
manual run shortly after a completed schedule can make that recent schedule
eligible again; a scheduled run still cleaning more than ten minutes after its
effective start is excluded from rescheduling but is still docked. These are
consequences of the chosen rule, not verified cleaning-history classifications.
An included occurrence may restart from the beginning; exact continuation has
not been verified.

If several recent schedules have different times, use the most recent one.
If several share that most recent timestamp, report the ambiguity and leave
those recent entries unchanged while delaying the unambiguous future entries.
Do not arbitrarily select by job ID. With intervals shorter than the ten-minute
lookback, a shifted time can remain in the past: never add extra intervals
silently or claim that a past time will trigger another cleaning today.

## Proposed defaults, subject to the design discussion

- No remaining eligible runs: leave schedule times unchanged; do not pre-delay
  tomorrow's schedules. The explicit command still docks any active cleaning.
- Docking belongs to the explicit Pause ON/delay action. Do not continuously
  enforce docking while schedules are paused, and do not let a background retry
  stop a new manual run started after the original command.
- Accumulate deliberate presses, including global then individual presses,
  without applying retries as additional increments.
- Ordinary Pause ON takes precedence: cancel remaining postponement, restore
  original times while schedules remain paused, and retain the original enabled
  states for the eventual unpause. Restore postponed times at the configured
  reset even when only the Delay controls are enabled.
- Detected manual edits take precedence. Do not overwrite changed definitions or
  recreate deleted schedules. New schedules are not silently added to an earlier
  postponement. Stop managing conflicting records and make the conflict visible.
- Apply the ten-minute selection rule on every press, including stacked presses.
  Do not claim that this proves which runs completed or were interrupted.
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
