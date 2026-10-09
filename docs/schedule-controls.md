# Pause and delay cloud schedules

This fork can pause or temporarily delay existing Roborock cloud schedules from
Apple Home. Everything runs inside the plugin using its existing Roborock
connection. Script2, external scripts and operating-system timers are not needed.

In plugin settings, enable either or both options under **Schedule controls**.
They are off by default and are independent of the other Home app action switches.
Pair the plugin's Homebridge child bridge with HomeKit to see these switches.

| Control | What it does |
| --- | --- |
| Pause Until Tomorrow | ON pauses schedules and docks active cleaning. OFF restores the schedules that this pause disabled. It expires at the daily reset. |
| Delay X Minutes | A momentary switch that resets OFF after 1.5 seconds, independently of cloud success. Each press docks active cleaning and adds the configured interval to today's eligible schedules. |
| Delay Active | ON reflects an active delay. OFF cancels it and restores original times. Manually turning it ON while inactive applies one interval; use the momentary switch to add further intervals. |

Each control is available per vacuum and for all vacuums. An all-vacuum stateful
switch is ON when at least one vacuum has the corresponding active state. Its
OFF action restores all affected vacuums. A failure for one vacuum does not stop
the operation for the others; check the Homebridge log for the result.

## Which schedules are delayed?

Every press checks again using the current, possibly delayed times:

- If the robot is cleaning, include the most recent enabled schedule due within
  the preceding ten minutes, plus today's future enabled schedules.
- If the robot is not cleaning, include only today's future enabled schedules.
- An already-paused vacuum gets no schedule-time changes. A new explicit command
  still docks any active cleaning.
- Disabled schedules and schedules without an occurrence today stay unchanged.
- If several recent schedules share the same latest time, leave those ambiguous
  entries alone and delay the future entries. The log explains the ambiguity.

For example, a 09:00 schedule can move to 10:00 after a press at 09:05 while the
robot is cleaning. Another press at 09:20 moves it to 11:00, even while docked.
A press at 11:20 while docked leaves that past occurrence alone.

The ten-minute check is a timing rule, not verified cleaning-history matching.
A manual clean shortly after a completed schedule can make that recent schedule
eligible again. A scheduled run that started more than ten minutes ago is docked
but is not rescheduled by this rule. A rescheduled run can start from the beginning.
Manual runs never become new scheduled jobs, and manual cleaning started after
the command is allowed to continue normally.

## Interval, reset and cancellation

The delay interval defaults to **60 minutes**; one setting applies to all delay
switches. It accepts whole minutes from 1 to 1440. Changing it affects subsequent
presses, preserving the original times already saved. An edit whose new time is
already past or less than a minute away is refused, without adding extra intervals.

The daily reset defaults to **00:05**, in the Homebridge host's timezone. Each
schedule's own timezone determines which day/time is eligible. Existing pauses
and delays retain the reset deadline saved when they began; changes to the reset
setting apply to subsequent periods.

If a selected delay would reach or pass the reset, that vacuum is paused until
reset instead. Delay Active remains ON for this converted pause, so it can still
be canceled when only Delay Schedules is enabled. Turning it OFF restores that
delay's saved enable states. An independently requested Pause Until Tomorrow
continues until canceled or expired.

Canceling a delay restores times without starting cleaning or docking a robot.
Original times are saved separately from the accumulated delays. Originals and
pending recovery work survive restarts, and hiding a feature does not discard
restoration work. If a restore fails, the active indicator remains ON while the
plugin retries. Recovery never sends a start-cleaning or return-to-dock command.

Homebridge must be running and connected to restore exactly at the reset. If it
is stopped or the cloud is unavailable, the saved cloud schedule can retain its
temporary time until recovery succeeds. Detected external edits and deletions
are preserved; conflicts are logged and their original snapshots retained locally.

## Supported schedule definitions

These controls target cloud schedules linked to robot timers, as verified on
`roborock.vacuum.a15` and `roborock.vacuum.a27` for time editing. Delay supports
repeated schedules with one time and a weekday list, such as `10 8 ? * 1,2,3,4,5`.
Unsupported definitions and ambiguous/nonexistent daylight-saving times are
refused. Routines and other schedule formats are not shifted by these controls.
End-to-end behavior still needs live validation on each robot model.

## Moving from an external pause controller

Install this plugin version with the new options left OFF first. Keep the old
controller's files and snapshots until the cutover has been verified.

1. Use the old controller to restore any active pauses and verify the intended
   enabled schedules in the Roborock app. Do this when no schedule is about to run.
   Already-disabled schedules do not reveal the old controller's saved originals.
2. Disable its reconciliation and daily-reset timers, allow current operations
   to finish, and disable Home automations or cron jobs that invoke the old scripts.
3. Disable the old Roborock Script2 switches. Other Script2 uses can remain.
4. Enable the native options, save and restart the plugin. Verify one vacuum
   before using the all-vacuum controls, then update Home automations to use them.

For `pponce/roborockPauseSchedules`, the timers are
`roborock-pause-reconcile.timer` and `roborock-pause-until-tomorrow.timer`.
Stopping them does not restore paused schedules or cancel an operation already
running. Complete restoration before retiring those timers.

The plugin saves its private recovery journal as
`roborock-schedule-controls-<account-hash>.json` in Homebridge's storage directory.
Do not delete this file while a pause, delay or restoration is active.
