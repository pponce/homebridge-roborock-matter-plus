# [4/4] Reconcile ambiguous schedule writes before retrying

Fourth and final PR for #27, stacked on draft #31. Please review/merge after #29, #30 and #31; the isolated PR 4 diff is linked below.

A schedule write can take effect even when its acknowledgement is lost. Previously, those writes were reported as failed without read-back. Verification could also retain a failed source's old cache and then mistake it for confirmation, or use it to authorize a fallback.

This change:
- Includes ambiguous primary and fallback writes in fresh verification.
- Requires a successful read of the relevant schedule source; another source's success or retained cache is insufficient.
- Confirms an already-applied assignment without sending it again.
- Allows one fallback assignment only when a fresh read finds the existing schedule in the other state.
- Does not retry missing schedules or explicitly refused writes. Failed/untrusted reads cannot authorize retries; account throttling and shutdown stop further writes.
- Rebuilds a cloud-scene retry from fresh scene data so app edits are preserved. Routine execution is never retried.

This works with session recreation disabled and never triggers a reconnect. When PR 3 already has a bounded recreation in flight, reconciliation waits for it before reading. There is no additional setting.

Tests drive the production MQTT queue/receiver and actual request timeouts. The HTTP tests use Roborock's API methods against a local server that applies a PUT and then drops the socket, producing real Axios errors. Existing schedule tests retain their behavioral assertions; source-contract checks and the expected batch log are updated for fresh verification.

Refs #27.

Validation: all 25 new tests and all 2,132 full-suite tests pass. Formatting, type checks and build pass. Against both v3.33.0 and PR 3, the same tests produce 21 behavioral failures and four passing controls, with no runtime-error suites.

- [Isolated PR 4 diff](https://github.com/pponce/homebridge-roborock-matter-plus/compare/454636662539644feda0c7a4e2c0a0a5e1866e7d...3cbfd826971e783cccfe010903192477aeb39501)
- [Successful validation run](https://github.com/pponce/homebridge-roborock-matter-plus/actions/runs/35821772900)
