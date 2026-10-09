# Schedule time investigation

Branch: `SCHEDULE_TIME_INVESTIGATION`, based on
`MQTT_ACCOUNT_SESSION_RECOVERY` at `42f0cc4c862d8e0307d9907f6405c71c53271417`.

The investigation distinguishes server timers, cloud scene timer triggers and
cloud jobs. A cloud connection alone does not identify the representation.

## Live result: model a15

On 2026-10-09, the one-job trial using commit
`691c5043036df9065c526155b5dd6d3b9da92141` succeeded on
`roborock.vacuum.a15`. The existing disabled cloud job was changed from 08:10
to 08:11 and restored to 08:10, with its ID, America/Los_Angeles timezone,
weekdays, repetition flag and complete task parameters preserved. The cloud
enabled flag was false before, during and after the test. The task was
`server_scheduled_start`.

Two PUT attempts completed, one for the edit and one for restoration. Read-back
verified the original definition, excluding the server-calculated next-fire
timestamp, and confirmed the other six jobs on that robot were unchanged.
The body retained the original fields other than `id` and `nextFireTime`.
Authentication used the encrypted configuration session without another login
or MQTT connection. No schedule was deleted or recreated.

This establishes an in-place cloud time-edit API on this model. App confirmation
of the robot-side pause switch remains separate: the trial reports
`robotPauseStateChecked: false`. Model a27, execution at a delayed time, and
automatic next-day restoration have not yet been verified by this test.

The preceding manual app experiment kept the job ID but also changed the cloud
enabled flag after disabling and removed a `clean_order_mode: 0` task field.
The API trial therefore used a fresh original read, not the earlier log payload.

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
`PUT /user/devices/{duid}/jobs/{jobId}`. That client is evidence on another model,
not a reason to reuse its full write body unchanged. The model a15 result above
is the separate live verification.

Verification commands:

```bash
node --test tests/inspect-cloud-jobs.test.cjs
python3 -B -m unittest discover -s tests -p 'test_inspect_schedule_times.py'
```

## One-job time-change trial

### Read-only preflight after a refused trial

`scripts/inspect-schedule-preflight.cjs` uses the same saved-session reader with
a GET-only transport. It performs one fresh cloud job-list request and describes
every job, marking the selected ID. Cloud enabled values retain their types, so
boolean false and the string "false" cannot be confused. Complete task structure
is sanitized with the existing diagnostic sanitizer.

It also checks bounded existing Homebridge log tails and joins jobs to robot
timers using the task's timer identifier. These log observations are explicitly
historical, without interpreted timestamps; they are not current robot state
and cannot justify relaxing a write guard. Missing or malformed observations
remain unknown. There are no schedule writes, login attempts, MQTT connections,
OPTIONS requests, or service changes. No plugin reinstall is needed.

On model a27, two 2026-10-09 trial attempts were refused by the local
`CLOUD_JOB_MUST_BE_DISABLED` guard after app on/off and time-edit preparation.
Both reported zero writes. Those refusals do not establish whether the cloud
time-edit API works on that model. Inspect current values and job identity before
choosing another experiment; do not repeat app edits or remove the guard based
on these reports alone. Trial refusals now include the observed job summary.

The fresh a27 preflight at 2026-10-09T21:16:48Z found all eight cloud jobs with
boolean `enabled: true`. The selected job retained its expected 09:15
Monday/Tuesday/Thursday cron and task fingerprint. Each job matched an older
robot-timer observation reporting off. Those historical timer observations do
not prove current pause state or explain the two controls' execution semantics.

The next trial explicitly expects the freshly observed cloud enabled value and
preserves it in both PUTs. This is a test of editing an enabled cloud definition,
with the same six-hour exclusion window; it does not rely on log evidence to
claim that the job is disabled. The user has permitted testing with schedules
unpaused. Time-edit support on a27 remains unverified until a successful live
read-back and restoration. No additional app toggles are required to prepare it.

### Executing a time-change trial

`scripts/test-schedule-time.cjs` is a developer command, not a background
scheduler. It uses the configured encrypted session in `config.json` with the
existing `roborock.token.key`, or the legacy `roborock.UserData` cache when no
encrypted session is configured. The configured session takes precedence, as it
does in the plugin. Decryption uses the plugin's AES-GCM format but never creates
or replaces a key, changes configuration, or writes decrypted login material.
Multiple Roborock platform entries are refused instead of guessing an account.
It uses this repository's existing Hawk signer for HTTPS. It does not log in, open
MQTT, modify the installed plugin or its configuration, or restart a service.
No additional npm packages are required. It runs from the Git checkout and
does not require a plugin reinstall. It fails without writes if the saved
session or matching owned-device inventory is unavailable.

The command requires `--execute` and explicit storage, robot name, model, job ID,
expected cron, timezone, and a new output directory. By default it requires a
disabled cloud job. An explicit `--expect-enabled true` instead requires boolean
true and preserves that flag; `--expect-enabled false` retains the default.
Missing, string-valued or mismatching cloud flags are refused. This flag is an
expectation, not an instruction to enable or disable a schedule. The current cron
and timezone must also match the supplied expectations. The supported
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
