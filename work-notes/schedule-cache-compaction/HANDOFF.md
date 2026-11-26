# Schedule cache compaction handoff

## Objective

Prevent unbounded HomeKit schedule metadata growth and automatically compact
existing cached name definitions without recreating accessories.

## Repositories and branches

- Fork: https://github.com/pponce/homebridge-roborock-matter-plus
- Maintained branches: `SCHEDULE_PAUSE_DELAY` and
  `upstream_plus_SCHEDULE_PAUSE_DELAY`.
- Upstream: https://github.com/mathiashornbek/homebridge-roborock-matter
- PR source: `pponce:fix/schedule-cache-growth`.
- PR source commit: `2ff7826da0ea2d19ec9bbf604c3aabb94304d993`.
- The maintained branches retain their existing 3.42.0 feature sets.
- The PR branch is based on upstream `1d277508bd32137c04120652be592b6581554058`.

## Completed changes

- Register ConfiguredName only when neither an active characteristic nor its
  optional definition exists.
- Compact duplicate ConfiguredName definitions when cached schedules and routines
  are attached, before cloud reads.
- Save repaired accessories immediately through Homebridge's accessory API.
- Preserve accessory UUIDs, service subtypes, active characteristic objects,
  values, custom names, and unrelated optional definitions.
- Include six regression cases using real Homebridge serialization.
- Refresh the compiled schedule module and source map in both maintained branches.
- Keep validation workflows out of the upstream PR and maintained-branch changes.

## Validation

- Upstream: 2,972 tests, 261 suites, all passed.
  https://github.com/pponce/homebridge-roborock-matter-plus/actions/runs/45829412680
- SCHEDULE_PAUSE_DELAY: 2,898 tests, 257 suites, all passed.
  https://github.com/pponce/homebridge-roborock-matter-plus/actions/runs/45829514851
- upstream_plus_SCHEDULE_PAUSE_DELAY: 2,830 tests, 255 suites, all passed.
  https://github.com/pponce/homebridge-roborock-matter-plus/actions/runs/45829463986
- Formatting, type checking, builds, and available fork diagnostic tests passed.
- Runtime installation and live cache measurements remain pending.

## Decisions and next steps

1. Open the prefilled comparison link and submit the upstream PR. No upstream PR
   has been opened automatically.
2. Install the preferred maintained fork branch using the normal Homebridge
   stop, add, and start sequence.
3. Rerun the read-only cache-size and duplicate-count diagnostics after startup.
   Existing name duplicates should be removed and subsequent refreshes should
   keep the cache bounded.
4. Homebridge's recovery .bak file can retain its previous size until the next
   successful cache load. Verify it after a further restart if the backup warning
   still names that recovery copy.
5. Do not clear or recreate accessories as part of this migration.
