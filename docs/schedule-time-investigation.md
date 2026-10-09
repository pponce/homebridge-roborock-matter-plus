# Schedule time investigation

Branch: `SCHEDULE_TIME_INVESTIGATION`, based on
`MQTT_ACCOUNT_SESSION_RECOVERY` at `42f0cc4c862d8e0307d9907f6405c71c53271417`.

First identify the schedule representation returned for each robot. A cloud
connection does not establish whether its schedules are server timers, cloud
scene timer triggers, or cloud jobs. No time-edit support is assumed.

## First diagnostic

`scripts/inspect-schedule-times.py` reads the existing `roborock.HomeData`
inventory and only matching schedule observations from the last 20,000 system
journal entries in the selected period. It also checks the last 16 MiB of each
of `homebridge.log.1` and `homebridge.log`. Timestamped journal evidence takes
precedence over undated log-file evidence.

It does not read saved authentication, open a network connection, log in,
modify configuration, install anything, restart a service, change schedules,
or move a robot. It writes one report to a new private output directory.
Robot names and models are included. Robot and server-timer IDs are replaced
with stable references. Only recognised schedule strings, numeric settings,
booleans and field structure are shown; credential fields are redacted.

Example (choose a new output directory each time):

```bash
sudo python3 -B scripts/inspect-schedule-times.py \
  --storage /var/lib/homebridge \
  --output "$HOME/roborock-schedule-inspection-$(date +%Y%m%d-%H%M%S)"
```

Copy the output between `START: SHAREABLE SCHEDULE TIME REPORT` and
`STOP: SHAREABLE SCHEDULE TIME REPORT`. The exact saved report path is printed.
Because sudo creates the output, viewing its saved file later requires sudo.

These are historical observations, not fresh cloud reads. A missing observation
does not mean the robot has no schedules. Cloud-probe logs may have been
compacted before this script saw them and cannot serve as complete restoration
snapshots. If evidence is missing or stale, the next step is obtaining a fresh
reading through the plugin's normal diagnostics, not guessing a write payload.

## Next experiments

1. Identify complete definitions and timezone for both robots.
2. If needed, compare a schedule before and after a user-controlled time edit
   in the Roborock app, preserving other settings. This identifies the changed
   fields but does not prove a programmatic write route.
3. Implement the appropriate time-setting call inside the plugin using its
   existing connection and schedule queue. Test one selected schedule with a
   saved original, read-back verification and explicit restoration.

Do not blindly reuse the on/off operation's payload as a time-edit command.
Do not delete and recreate schedules to work around an unverified edit API.

## Installation convention

For any later runtime update, commit matching compiled `dist` files to this
GitHub branch. Install with `sudo hb-service stop`, then
`sudo hb-service add pponce/homebridge-roborock-matter-plus#SCHEDULE_TIME_INVESTIGATION`,
then `sudo hb-service start`. Ensure start is attempted even if installation
fails. No npm publication is required. The first diagnostic changes no runtime
source, so the base branch's existing `dist` remains unchanged and no installation
is needed.
