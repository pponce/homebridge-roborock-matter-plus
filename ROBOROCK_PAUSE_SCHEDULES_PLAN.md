# Roborock Schedule Pause / Restore Plan

## Status

**Phase:** Planning / environment discovery  
**Last updated:** 2026-08-21  
**Active branch:** `schedule-refresh-recovery-fixes`

This document tracks the separate Linux/Homebridge work needed to implement a true state-aware **Pause All Vacuum Schedules / Restore** function.

The plan is intentionally kept in the repository so the design and implementation progress remain versioned alongside the Roborock schedule-switch work. A working copy will also be placed at:

```text
/var/lib/homebridge/roborockPauseSchedules/ROBOROCK_PAUSE_SCHEDULES_PLAN.md
```

## Goal

Provide a genuine Pause/Resume behavior for all Roborock schedule switches exposed in HomeKit.

Current real configuration:

- **Uptown Rock:** 8 schedule switches; currently all 8 are enabled.
- **Downtown Rock:** 7 schedule switches; currently 3 enabled and 4 disabled.
- Total: **15 schedule switches**.

The configuration is not fixed. Future schedule changes must be reflected automatically, so restoration must use a runtime snapshot rather than a predetermined ON/OFF configuration.

Desired user experience:

> “Hey Siri, pause all vacuum schedules.”

Expected behavior:

1. Record the current ON/OFF state of every discovered Roborock schedule switch.
2. Turn every discovered schedule switch OFF.
3. Preserve the original state persistently until restoration.
4. Shortly after midnight, restore every schedule to exactly its pre-pause state.
5. A schedule that was OFF before the pause must remain OFF after restoration.
6. Only schedules that were ON before the pause are turned back ON.

## Required pause semantics

The pause operation must be idempotent with respect to the saved snapshot.

Conceptually:

```text
IF schedules are NOT already paused:
    discover current schedule switches
    read current ON/OFF state of every switch
    save the snapshot persistently
    mark schedules paused

turn all discovered schedule switches OFF
```

The **already-paused check is mandatory**. If the user issues the pause command twice, the second command must not replace the original snapshot with an all-OFF snapshot.

Example original state:

```text
Uptown:
ON ON OFF ON ON ON OFF ON

Downtown:
ON OFF OFF ON OFF ON OFF
```

During pause:

```text
Uptown:
OFF OFF OFF OFF OFF OFF OFF OFF

Downtown:
OFF OFF OFF OFF OFF OFF OFF
```

After restoration:

```text
Uptown:
ON ON OFF ON ON ON OFF ON

Downtown:
ON OFF OFF ON OFF ON OFF
```

## Persistence

State must survive:

- Homebridge restarts
- Linux process/script termination
- the midnight boundary
- temporary Homebridge/API failures

Proposed state file:

```text
/var/lib/homebridge/roborockPauseSchedules/state.json
```

Conceptual structure:

```json
{
  "paused": true,
  "snapshot": {
    "Uptown Rock Schedule 1": true,
    "Uptown Rock Schedule 2": true,
    "Downtown Rock Schedule 1": false
  }
}
```

The exact representation can change during implementation. The important properties are persistence, atomic updates, and preservation of the original snapshot until successful restoration.

## Restoration semantics

A scheduled job should run shortly after midnight, initially targeting approximately **00:05**.

Conceptually:

```text
IF schedules are marked paused:
    load saved snapshot

    for every saved schedule:
        restore its saved ON/OFF state

    only after successful restoration:
        clear paused state and snapshot
```

The snapshot must **not** be deleted before successful restoration. If Homebridge is unavailable or a restoration operation fails, the saved state must remain available for a later retry.

The restoration operation should also be safe to run more than once.

## Architecture

The preferred architecture is Linux-side orchestration using the existing Homebridge API rather than introducing another Homebridge plugin specifically for pause/restore.

```text
Siri / Apple Home
       |
       v
homebridge-script2 trigger
       |
       v
Linux pause/restore scripts
       |
       v
Homebridge Config UI X REST API
       |
       v
Roborock schedule Switch accessories
       |
       v
homebridge-roborock-matter-plus
       |
       v
Roborock cloud / robot
```

The existing `homebridge-roborock-matter-plus` branch exposes the Roborock schedules as HomeKit `Switch` accessories. The pause system should manipulate those HomeKit switches rather than independently calling Roborock schedule APIs.

This keeps pause/restore aligned with the state that Apple Home actually exposes.

## Do not hard-code the 15 switches

The scripts should discover the schedule switches from Homebridge rather than assuming there will always be exactly 8 Uptown and 7 Downtown schedules.

Discovery should identify the schedule switches by their stable/recognizable accessory identity and current Homebridge state.

This is important because:

- schedules can be added or removed;
- schedules can be enabled or disabled normally;
- displayed schedule numbering may change;
- the pause feature must work with future schedule configurations.

The first implementation tool will therefore be a read-only discovery script before any pause behavior is enabled.

## Linux working directory

All Linux-side scripts and runtime state will live under:

```text
/var/lib/homebridge/roborockPauseSchedules
```

Planned initial layout:

```text
/var/lib/homebridge/roborockPauseSchedules/
├── ROBOROCK_PAUSE_SCHEDULES_PLAN.md
├── config
├── state.json
├── common.sh
├── list-schedules.sh
├── pause-schedules.sh
└── restore-schedules.sh
```

A systemd service/timer may be added later:

```text
roborock-schedule-restore.service
roborock-schedule-restore.timer
```

The exact filenames and configuration format are implementation details and may be adjusted as the environment is inspected.

## Homebridge integration

The Linux scripts will use the documented Homebridge Config UI X API where practical.

Initial discovery must establish:

- Homebridge Config UI X listening address/port;
- authentication requirements for local API calls;
- the exact `/api/accessories` response available on this installation;
- how to identify the Roborock schedule switches;
- the correct API operation for changing an accessory's `On` characteristic.

Do not guess accessory IDs, HAP AID/IID values, or authentication credentials.

Do not place Homebridge passwords, API tokens, or other secrets in this plan file.

## Existing environment

Homebridge is managed by `hb-service`.

Homebridge data root:

```text
/var/lib/homebridge
```

Primary log:

```text
/var/lib/homebridge/homebridge.log
```

Installed Roborock plugin:

```text
/var/lib/homebridge/node_modules/homebridge-roborock-matter
```

`hb-service`:

```text
/usr/local/bin/hb-service
```

Focused Roborock/schedule logging:

```bash
sudo tail -F /var/lib/homebridge/homebridge.log | grep --line-buffered -E "Schedule (discovery|parser|sync|command|refresh)|Roborock"
```

Existing supporting plugins/capabilities:

- `homebridge-script2` can create HomeKit switches that execute Linux scripts when activated.
- `homebridge-virtual-accessories` is installed and can provide dummy/virtual switches if a dedicated HomeKit control surface is useful.

A virtual/dummy switch is **not currently assumed to be necessary**. We will first determine whether `homebridge-script2` can provide the desired Siri trigger cleanly on its own.

## Proposed scripts

### `list-schedules.sh`

Read-only diagnostic/discovery tool.

Responsibilities:

- query Homebridge;
- discover the current Roborock schedule switches;
- display each discovered switch and current state;
- avoid changing any accessory state.

This must be implemented and validated before the pause script is allowed to modify anything.

### `common.sh`

Shared configuration and helper functions.

Potential responsibilities:

- Homebridge API endpoint configuration;
- authentication handling;
- accessory discovery;
- state parsing;
- atomic state-file writes;
- locking;
- API error handling;
- logging.

Secrets should come from protected configuration/environment mechanisms rather than being embedded in the script.

### `pause-schedules.sh`

Responsibilities:

1. Acquire an exclusive lock.
2. Read existing state.
3. If already paused, preserve the existing snapshot.
4. If not paused, discover all current schedule switches and read their states.
5. Persist the snapshot atomically.
6. Mark the pause active.
7. Turn all discovered schedules OFF.
8. Verify the resulting states where practical.
9. Release the lock.

The snapshot must be written before the operation can be considered paused.

### `restore-schedules.sh`

Responsibilities:

1. Acquire the same exclusive lock.
2. Determine whether a pause snapshot exists/is active.
3. Load the original snapshot.
4. Restore each saved schedule individually.
5. Verify restoration where practical.
6. Clear the pause state only after successful restoration.
7. Preserve the snapshot if restoration fails.
8. Release the lock.

## Concurrency and safety

The scripts must prevent overlapping pause/restore operations.

Use a Linux lock mechanism such as `flock`.

Important race cases to handle:

- two pause commands arriving close together;
- pause arriving while restore is running;
- restore running while Homebridge is temporarily unavailable;
- Homebridge restarting during an operation;
- one accessory failing while other accessories succeed;
- a schedule being added/removed between normal configuration changes and a future pause.

The original snapshot is authoritative for the active pause. A later discovery must not silently replace it.

## Failure behavior

The implementation should fail conservatively.

### During pause

If the snapshot cannot be persisted, **do not proceed as though the pause succeeded**.

If individual OFF operations fail, retain enough state/logging to retry safely. The original snapshot must not be lost.

### During restoration

If one or more schedule restorations fail:

- do not clear the snapshot;
- leave the pause state active;
- report the failure;
- allow a later retry.

The implementation should avoid turning a transient Homebridge failure into permanent loss of the user's schedule configuration.

## Midnight scheduling

Initial target:

```text
00:05 local time
```

Prefer a Linux/systemd scheduled job for deterministic behavior and persistence across Homebridge restarts.

A HomeKit automation can be considered as an alternative trigger, but it should not be required for the core restoration guarantee.

## Siri/HomeKit trigger

The desired command is:

> “Hey Siri, pause all vacuum schedules.”

The trigger should ultimately invoke `pause-schedules.sh`.

We will determine whether the cleanest implementation is:

1. a `homebridge-script2` switch directly exposed to Siri, or
2. a `homebridge-script2` trigger combined with a virtual accessory from `homebridge-virtual-accessories`.

Do not add the virtual accessory unless it provides a real usability benefit.

## Testing strategy

Testing should proceed from least destructive to most realistic.

### Phase 1 — discovery

- Verify Homebridge API connectivity.
- Identify all 15 current schedule switches.
- Confirm current ON/OFF state matches Apple Home.
- Confirm discovery is read-only.

### Phase 2 — state persistence

- Create a test snapshot.
- Inspect the resulting state file.
- Verify atomic/valid JSON state.
- Verify restart/process interruption does not lose the snapshot.

### Phase 3 — pause

With the real schedule configuration:

- capture the expected current states;
- run pause;
- verify all 15 are OFF;
- run pause again;
- verify the original snapshot remains unchanged.

### Phase 4 — restoration

- run restore manually before enabling the midnight timer;
- verify every schedule exactly matches its pre-pause state;
- verify schedules originally OFF remain OFF;
- verify the state file is cleared only after successful restoration.

### Phase 5 — failure testing

Where practical, simulate:

- Homebridge unavailable;
- API timeout/failure;
- one accessory update failure;
- restore interruption.

Verify the snapshot remains recoverable.

### Phase 6 — Siri/HomeKit

- expose the trigger through HomeKit;
- invoke it using Siri;
- verify the same pause semantics;
- repeat the Siri command and verify the snapshot is not overwritten.

### Phase 7 — overnight

Only after manual testing passes:

- enable the approximately 00:05 scheduled restoration;
- verify a real overnight pause/restoration cycle;
- inspect only focused logs/results.

## Keep terminal output short

This is an explicit workflow constraint. The user pastes command output into ChatGPT and large output can hit text caps.

Prefer:

```bash
git status --short
git log -n N
targeted tests
narrow grep
bounded tail
```

Do **not** ask for:

- whole logs;
- recursive directory dumps;
- large files;
- broad command output;

unless specifically necessary.

When diagnosing Homebridge, request only the smallest command output that answers the current question.

## Relationship to the Roborock schedule recovery project

This pause/restore project depends on the schedule switches provided by:

`pponce/homebridge-roborock-matter-plus`

active branch:

`schedule-refresh-recovery-fixes`

The schedule recovery work already provides the important architectural behavior that schedule switches are backed by a per-vacuum cached snapshot and coordinated refresh rather than independent polling.

This pause/restore layer should **not** add a second Roborock cloud polling system. It should operate through the Homebridge schedule switches and their existing coordinator/API behavior.

## Progress log

### 2026-08-21 — Plan created

- Confirmed the target environment is Linux + Homebridge managed by `hb-service`.
- Confirmed the Roborock schedule switches come from `homebridge-roborock-matter-plus` on `schedule-refresh-recovery-fixes`.
- Confirmed `homebridge-script2` is available for Linux-script-triggering HomeKit switches.
- Confirmed `homebridge-virtual-accessories` is available if a dummy control switch is useful.
- Established the target Linux working directory: `/var/lib/homebridge/roborockPauseSchedules`.
- Established the state-aware snapshot requirement and the critical rule that repeated pause commands must not overwrite the original snapshot.
- Established the requirement to discover schedule switches dynamically rather than hard-code the current 15-switch configuration.
- Next implementation step: inspect the local Homebridge Config UI X API and build the read-only `list-schedules.sh` discovery tool.

## Future progress entries

Add a dated entry here after each meaningful implementation/testing milestone. Record:

- what changed;
- tests performed;
- relevant pass/fail result;
- any real-device validation;
- next step.
