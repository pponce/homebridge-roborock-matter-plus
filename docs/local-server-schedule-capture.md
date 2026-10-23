# Capturing schedules for local-server compatibility

`SCHEDULE_PROTOCOL_CAPTURE` is based on Pedro's `SCHEDULE_PAUSE_DELAY` branch.
It retains the full integration branch, including native pause/delay controls,
and adds an optional diagnostic capture. Pause/delay policy continues to live
in Homebridge. The local server should implement Roborock's scheduling APIs,
state storage, and execution behavior.

## What we know and what remains to measure

Existing tests and live investigations on a15/a27 establish the cloud job
list/update route, cron time editing, and the robot timer on/off commands.
Cloud job IDs and robot timer IDs are different: the link is normally the
job's `param.params[].name`. A cloud job's `enabled` flag is not necessarily
the robot timer's on/off state. Both must be captured and preserved.

The capture helps measure:

- Complete job and scene definitions, including timezone, cron, settings,
  rooms, flags, response envelopes, and calculated next-fire fields.
- Fresh `get_server_timer` and `get_timer` results alongside cloud jobs.
- The plugin's actual timer writes and cloud job time updates, including
  replies, refusals, and the selected LAN/MQTT transport.
- Before/after state when the user edits schedules in the Roborock app.
- Robot status and any clean-history reads the plugin already performs.

It cannot observe private app-to-cloud requests or cloud-to-robot commands
that are not delivered to Homebridge. An app time edit reveals resulting
state; exercising Homebridge's delay control reveals the plugin's PUT body.
Observing a scheduled clean does not prove the exact command the cloud used.
Local-server testing is still needed for scheduled execution, disabled timer
semantics, restart/offline behavior, one-time jobs, and timezone/DST boundaries.
This is evidence for the models captured, not proof for every Roborock model.

## Enable and download

1. Install this branch using the normal GitHub installation procedure.
2. In the plugin's custom settings, open **Advanced settings** and enable
   **Capture schedule protocol for 30 minutes**. Save, then restart the
   Roborock child bridge. General debug logging and Homebridge `-D` are not
   required.
3. Look for **Schedule capture started (format 2)** in the Homebridge log. Capture begins
   after the connection is ready; the first snapshot starts about five seconds
   later. Snapshots repeat sixty seconds after the preceding snapshot finishes.
4. Use **Download schedule capture** in Advanced settings. It downloads the
   most recent capture, including a capture that is still running.
5. Disable the capture checkbox and save when finished. Restart the child
   bridge to stop immediately; otherwise capture ends automatically.

Capture stops after thirty minutes, at two MiB, on an observed HTTP 429,
when the API connection is replaced, or when the plugin shuts down. There is
only one capture window per child-bridge process. Starting another requires a
restart with the checkbox still enabled. Up to three previous files plus the
current file are retained under `roborock-schedule-captures` in Homebridge's
storage directory (normally `/var/lib/homebridge`). Files use mode 0600.

## First experiment

Use one robot and note the clock time of each action. Keep the robot idle
while testing schedule edits and restore the original settings afterward.

1. Wait about ninety seconds after startup for a baseline. Confirm the
   expected schedules in the Roborock app.
2. Toggle one schedule off from its Home app switch. Wait at least seventy-five
   seconds. Toggle it back and wait again. Record its original enabled state.
3. Use the Homebridge **Delay** control for that robot and wait for read-back
   plus at least seventy-five seconds for a fresh snapshot. Then cancel
   **Delay Active**, wait another seventy-five seconds, and verify the
   original times in the Roborock app.
   This records the existing-job PUT and restoration used by our controller.
   Delay deliberately affects eligible schedules and docks active cleaning;
   this is a user action, not something the capture performs automatically.
4. Download the file and share it with the robot model and the action times.

If a full round of reads takes longer, allow more time between actions.
`snapshot-start` and `snapshot-end` delimit each round. Failed reads are
reported explicitly; a missing or failed response is not an empty schedule list.
Snapshots skip while a schedule operation is pending. After three consecutive
failures of an individual read, that read gets a two-minute cooldown before
another attempt; the cooldown is checked on the next snapshot. A successful
read resets its failure count and records `snapshot-read-recovered`, so an
offline/reconnect experiment can include fresh status without restarting the
capture. Cooldown skips are recorded as `snapshot-read-skipped`. Other reads
continue independently. The thirty-minute, size, shutdown, and HTTP 429 limits
still apply, and no extra retry timers or overlapping snapshots are created.
These are sequential
observations, not an atomic snapshot of the account.

Useful later experiments are a temporary disabled schedule created/edited/
deleted in the Roborock app, room-specific versus whole-home jobs, and a normal
scheduled clean. App actions themselves will not appear as plugin requests;
wait for snapshots between them. Run a new capture shortly before a normal
scheduled clean to observe its state changes without starting it manually.

## What is saved

The JSONL file contains one timestamped JSON record per event. HTTP capture is
restricted to schedule jobs and scene routes. Robot capture is restricted to
timer commands, scheduling-related start/stop commands, timezone, status, and
clean-history reads. It does not record login traffic, headers, credentials,
maps, images, or MQTT connection secrets.

HTTP records distinguish JSON from form encoding, including repeated form
fields. Response/error records also contain the sanitized final request body
after signing and Axios serialization; the earlier request event may contain
the caller's original object. Only the two recognized content types are kept,
not the request headers.

Cloud and robot IDs use consistent salted references within a capture. Identity
objects include the original scalar type. User labels and unknown strings are
also replaced; known protocol words, cron, timezone, numeric settings, and
booleans are retained. Capture format 2 also retains recognized `nextFireTime`
timestamp strings (ISO/date-time or Unix seconds/milliseconds) and numeric
comma-separated `segments` strings, including their original spacing and order.
These exceptions apply only to those field names; arbitrary text stays masked.
Nested JSON strings are decoded and sanitized. These
reports are comparison evidence, not restorable schedule backups. The file
still contains schedule times, room numbers, and robot activity.

The first record identifies the recorder with `formatVersion: 2`. Older
format-1 files may contain aliases instead of these time and room-list values;
reinstalling does not restore values already masked in an older capture.

The observer does not change request bodies, signatures, responses, errors,
transport choices, or retry decisions. Its own extra traffic is GET requests
for jobs/scenes and classic robot reads for timers, timezone, and status over
the existing connections. Classic RPC probes are skipped on B01 robots. It
does not log in, create another MQTT connection, or create, edit, delete,
enable, disable, or execute schedules.

## Validation

The capture tests use fake API/robot connections and temporary storage:

```text
node --test tests/schedule-protocol-capture.test.cjs
```

The branch's build workflow also checks formatting, TypeScript, the complete
Jest suite, Node diagnostic tests, Python diagnostic tests, and generated
`dist/`. Live capture and local scheduled execution remain separate checks.
