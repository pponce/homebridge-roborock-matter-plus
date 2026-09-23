# [3/4] Add opt-in bounded MQTT session recreation

Third of four PRs for #27. This draft is stacked on #30 (which includes #29); please review/merge after those two. The isolated PR 3 diff is linked below.

This adds opt-in session recreation when the observations from PR 1 identify correlated silence across robots. Recovery stays disabled by default.

- Recreate a fresh MQTT client, single-flight, with bounded drain, teardown and readiness waits and a cooldown.
- Require the reply subscription acknowledgement before allowing cloud sends. Leave local requests running.
- Reject outstanding cloud requests, including B01 map reads, with an unknown outcome rather than replaying them.
- Ignore retired-client callbacks and cancel recovery on shutdown.
- Keep schedule-write reconciliation separate for PR 4.

Both configuration options are currently in the plugin UI's collapsible **Advanced troubleshooting** section:
- **Enable experimental MQTT session recovery** (`enableMqttSessionRecovery`): off by default.
- **Enable preventive MQTT refresh** (`enableMqttPreventiveRefresh`): separately off by default; requires recovery to be enabled. When enabled, it refreshes a ready session after four hours, deferring for outstanding cloud requests.

I put the preventive option there for now; happy to change its presentation to fit your preference. Changing either option requires a child-bridge restart. These are plugin configuration options, not HomeKit switch accessories.

Regression tests exercise real connector callbacks and request-queue timeouts, including refused/missing SUBACKs, single-flight recreation, pending writes, B01 maps, local requests, cooldowns and shutdown. Against the PR 2 baseline, 13 tests fail behaviorally and six control cases pass, with no runtime-error suites.

Refs #27. No automatic command replay or ambiguous schedule-write reconciliation in this PR.

Validation: 19/19 focused tests and 2,107/2,107 full-suite tests pass; formatting, both TypeScript checks, and build pass.

- [Isolated PR 3 diff](https://github.com/pponce/homebridge-roborock-matter-plus/compare/7f0235c54a5573f3b8533be5c552f226b54673d6...454636662539644feda0c7a4e2c0a0a5e1866e7d)
- [Successful validation run](https://github.com/pponce/homebridge-roborock-matter-plus/actions/runs/35819754237)
