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

## Expanded cloud-job inspection

When plugin debug logging and child bridge Debug Mode are enabled, the existing
once-per-robot startup probe now also emits `Schedule time inspection` records.
The probe uses its existing authenticated cloud client. It decodes nested JSON
before ordinary diagnostics truncate strings at 500 characters or arrays at
eight entries. Unknown strings and credential fields are masked. Task parameter
fingerprints allow comparisons without printing raw private strings. These
sanitized records describe settings; they are **not restoration snapshots**.

For the first valid job, three additional OPTIONS requests inspect the collection,
the existing job, and a deliberately absent subresource as a control. Each request
has a 10-second timeout. No PUT, POST, PATCH, DELETE, login, or robot action is
performed by the added diagnostic. A job endpoint advertising PUT identifies a
candidate route; it does not prove a particular time-edit payload will work.
An absent control returning the same Allow header would weaken that evidence.

The collector includes the embedded capture timestamp and allowed methods. An
expanded reading replaces the older compacted cloud-job log in the report; check
the capture timestamp to establish freshness. Other readings can still be older.
The robot-side on/off state and the cloud-job `enabled` field are reported
separately. Do not assume those fields mean the same thing or enable jobs based
on their disagreement.

The candidate job update route is used for enabling/disabling jobs by
[`roborock-q10-cli`](https://github.com/andrewlyeats/roborock-q10-cli/blob/main/vac.py):
`PUT /user/devices/{duid}/jobs/{jobId}`. That is evidence on another model, not
validation for the S7 models or a license to reuse its full write body unchanged.

Verification commands:

```bash
node --test tests/inspect-cloud-jobs.test.cjs
python3 -B -m unittest discover -s tests -p 'test_inspect_schedule_times.py'
```

## One-job time-change trial

`scripts/test-schedule-time.cjs` is a developer command, not a background
scheduler. It uses the saved `roborock.UserData` session and this repository's
existing Hawk signer to make HTTPS calls to Roborock. It does not log in, open
MQTT, modify the installed plugin or its configuration, or restart a service.
No additional npm packages are required. It runs from the Git checkout and
does not require a plugin reinstall. It fails without writes if the saved
session or matching owned-device inventory is unavailable.

The command requires `--execute` and explicit storage, robot name, model, job ID,
expected cron, timezone, and a new output directory. It will only test a disabled
cloud job whose current cron and timezone match those expectations. The supported
test is exactly one minute later in the same hour, with neither the original nor
the changed schedule due in the next six hours. Existing-job OPTIONS must name
PUT. It will not create, delete, enable, or execute a job.

Before writing, it saves the complete original and proposed job definitions in
`original-job.private.json` (0600 inside a new 0700 directory), without account
credentials. This is an unredacted local backup, unlike the shareable inspection
reports. The write body retains timezone, repeated/enabled flags, and the entire
task parameter object; only `id` and the server's calculated `nextFireTime` are
omitted. Changing a time in the app can also rewrite task fields, so rebuilding
the body from a log or assuming only cron changes is not acceptable.

The test checks the current definition again before writing, sends one PUT,
reads the result, and restores the original when the current job matches the
proposed test definition. It reads back restoration and checks the other jobs
for changes, excluding calculated next-fire timestamps. An ambiguous timeout
is resolved with bounded reads, not by repeating the time-changing PUT.

Run the test without editing schedules from another app or automation during
the brief trial. There is no demonstrated atomic compare-and-set API. Unexpected
definition changes stop automatic restoration to avoid overwriting a concurrent
edit; a connectivity failure can also prevent verification. Those outcomes print
an explicit instruction to restore the original time and disable it in the app.
The private snapshot remains available. An exclusive local trial lock prevents
two instances of this command; SIGINT/SIGTERM allow restoration checks to finish.
An uncatchable termination can leave the lock and requires checking its recorded
PID before removing it.

This verifies cloud job definitions only. The robot-side pause switch is a
separate reading and must be checked in the app after the trial. Success on one
robot is not proof of support on another model or of next-day restoration after
a Homebridge outage. The eventual plugin implementation must read and preserve
both cloud-job and robot-timer state through its normal account queue.

Additional verification:

```bash
node --test tests/cloud-job-time-trial.test.cjs
```

## Installation convention

For any later runtime update, commit matching compiled `dist` files to this
GitHub branch. Install with `sudo hb-service stop`, then
`sudo hb-service add pponce/homebridge-roborock-matter-plus#SCHEDULE_TIME_INVESTIGATION`,
then `sudo hb-service start`. Ensure start is attempted even if installation
fails. No npm publication is required. The first diagnostic changes no runtime
source, so the base branch's existing `dist` remains unchanged and no installation
is needed.

The expanded diagnostic requires installation. Its runtime changes are in the
JavaScript `roborockLib` loaded directly by `dist/platform.js`; no TypeScript or
generated output changes are required. The existing matching `dist` remains
committed on this branch for GitHub installation.
