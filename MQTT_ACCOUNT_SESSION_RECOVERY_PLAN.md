# Account-Level MQTT Session Recovery Plan

## Document purpose

This document is the implementation plan for making Roborock cloud command
handling resilient when the MQTT client remains nominally connected but stops
delivering robot replies.

The work is intentionally divided into **three reviewable commits**. Each
commit must build, pass its own tests, and leave the repository in a coherent
state. The commits should be pushed together in one pull request, in the order
defined here.

This is a plan, not an implementation. It does not change runtime behavior by
itself.

## Problem statement

The connector currently has a useful socket-level health signal, but that
signal is not sufficient to prove that the account's inbound Roborock reply
subscription is functioning.

The observed failure shape is:

1. The MQTT client reports `connected=true`.
2. Cloud requests are published and remain pending for their full timeout.
3. No decoded cloud message arrives while those requests are pending.
4. Multiple methods can be affected, including `get_server_timer` and
   `get_map_v1`.
5. Both robots on the same account can fail sequentially.
6. Local LAN requests continue to receive replies.
7. HTTPS HomeData refreshes continue to succeed.
8. The hourly MQTT health check sees an existing connected client and skips
   reconnection.
9. Recreating the child bridge, and therefore the MQTT connection and
   subscription, is followed by immediate successful schedule reads.

This evidence is consistent with a stale or half-open MQTT connection, a stale
broker-side subscription/session, or another failure in the inbound cloud
reply path. It does not prove which component is responsible.

The practical consequence is more important than the exact owner of the
fault: a critical schedule write can reach the robot, but its acknowledgement
or the subsequent authoritative verification read can be lost. The plugin
must not blindly repeat an ambiguous write, and it must not report success
until it has authoritative confirmation.

## Primary objectives

1. Distinguish socket connectivity from subscription readiness.
2. Make MQTT session health observable at several inbound processing stages.
3. Provide one account-scoped, single-flight way to recreate the MQTT session
   and wait for subscription acknowledgement.
4. Prevent new cloud requests from publishing while the account session is
   being replaced.
5. Handle old-generation requests and late events deterministically.
6. Recover schedule writes by reconnecting and **reading authoritative state
   before retrying an ambiguous write**.
7. Return a real failure to HomeKit/Config UI callers when recovery is
   exhausted.
8. Preserve local transport, schedule caches, accessory identity, and normal
   HomeKit topology throughout MQTT recovery.
9. Make nearly all behavior deterministic and testable without a physical
   robot.

## Non-goals

The three commits should not:

- add periodic unconditional hourly reconnects as the default policy;
- generate a random MQTT client ID;
- treat ordinary cloud inactivity by itself as a failure;
- reconnect after every isolated command timeout;
- retry an ambiguous write before reading authoritative state;
- restart the Homebridge child bridge as part of normal recovery;
- clear schedule caches or recreate HomeKit accessories;
- change local LAN connection behavior;
- redesign every polling interval in the plugin;
- claim that the observed issue is an HTTP 429 or proven Roborock rate limit;
- include user-specific device identifiers, room names, account data, or raw
  diagnostic payloads in tests or documentation;
- modify `CHANGELOG.md`; the upstream maintainer can add release notes when
  choosing to release the work.

## Why three commits

This change crosses the connector, the generic request pipeline, lifecycle
management, and schedule transaction semantics. Putting all of that into one
undifferentiated commit would make review and regression isolation difficult.

The three-commit structure follows the dependency graph:

1. **Observe and define readiness.** The system cannot safely recover until it
   can identify a connection generation and prove subscription readiness.
2. **Provide safe account-level session replacement.** Recovery cannot be
   invoked from schedule code until cloud publication is gated and reconnects
   are serialized.
3. **Apply the mechanism to schedule transactions.** Only after the transport
   primitive is safe should schedule logic decide when and how to invoke it.

This split has several review benefits:

- Commit 1 can be reviewed primarily for observability and MQTT readiness
  semantics.
- Commit 2 can be reviewed primarily for concurrency, lifecycle, and request
  ownership.
- Commit 3 can be reviewed primarily for product behavior and ambiguous-write
  correctness.
- `git bisect` can identify whether a regression came from instrumentation,
  generic transport recovery, or schedule policy.
- The first two commits are useful beyond schedules and can be tested without
  relying on schedule accessory behavior.
- Reviewers can reject or revise the automatic recovery policy without losing
  the lower-level transport improvements.

The intended pull request therefore contains exactly these logical commits:

1. `Instrument MQTT session readiness and inbound cloud activity`
2. `Serialize account MQTT session recreation and cloud requests`
3. `Recover ambiguous schedule writes through reconnect and verification`

Commit messages may be adjusted for repository style, but the boundaries
should remain intact.

---

# Existing behavior and constraints

## Account-scoped MQTT client

One MQTT client serves the Roborock account and therefore all robots on that
account. Session recreation is not a per-vacuum operation. A failure reported
while handling one vacuum can require account-level recovery, and recovery can
affect commands for every vacuum.

## Current subscription readiness gap

The current connection handler initiates `subscribe()` and then marks the
connector connected without awaiting the subscription callback. Consequently,
`connected=true` means the socket/client connected; it does not necessarily
mean the response subscription was acknowledged and is delivering messages.

The implementation should use `subscribeAsync()` or an equivalent bounded
promise and should introduce a distinct `subscriptionReady` state.

## Current health check limitation

The periodic health check calls `ensureConnected()`. If a client object exists
and the connector's Boolean says connected, it skips reconnecting. This catches
explicit disconnects but not a logically stale reply path.

## Shared pending request map

Cloud and local operations use the same pending request map. Existing entries
record resolution callbacks, a timeout handle, method information, and some
protocol metadata, but do not fully identify:

- transport;
- device;
- read versus write semantics;
- MQTT session generation;
- creation/publication timestamps.

That metadata is required to drain or reject only the affected cloud requests
without disturbing local requests.

## Schedule write semantics

Schedule switches batch writes arriving inside the configured batch window.
The batch:

1. sends primary writes with spacing;
2. waits for robot state propagation;
3. performs an authoritative schedule read;
4. compares the returned state with every requested state;
5. uses a fallback write method for unconfirmed changes;
6. performs another authoritative read;
7. resolves or rejects each switch operation based on consolidated results.

This is the correct foundation. Recovery must preserve batching and
authoritative verification rather than replacing them with optimistic state.

## Caller-visible failure limitation

The switch setter currently catches a rejected batch, rolls back the visible
switch value, logs the failure, and does not rethrow. A HomeKit or Config UI
caller can therefore observe a completed request even though verification
failed.

Commit 3 must make the final exhausted failure observable to the caller while
still rolling the characteristic back.

---

# Shared design principles

## Connection state is not readiness

The connector should distinguish at least:

```text
disconnected
connecting
subscribing
ready
draining
reconnecting
shutting-down
```

Only `ready` permits a new cloud publication.

## Every MQTT session has a generation

Increment a monotonically increasing generation number for each new logical
MQTT session. Capture the client instance and generation in every event
handler. Late events from an old client must not change the current session's
state.

Every cloud pending request should remember the generation on which it was
published. Diagnostics should include the generation but must not expose raw
topics, credentials, or account identifiers.

## Account-level single flight

At most one reconnect/recreation promise may exist for an account. Concurrent
callers adopt the same promise. This includes:

- schedule recovery;
- future map/status recovery;
- manual diagnostics;
- preventive refresh, if one is later added;
- ordinary disconnected-client recovery.

## Gate cloud, not local

During reconnect:

- new cloud operations wait behind a readiness gate;
- local LAN operations continue normally;
- cloud waiters have bounded timeouts and shutdown cancellation;
- no request should be registered as published until it actually passes the
  gate and is published on a ready generation.

## Read before retrying an ambiguous write

If a cloud write times out, it may have reached and changed the robot. The
correct recovery is:

1. recreate the session;
2. read authoritative state;
3. accept success if the state already matches;
4. retry only a still-mismatched idempotent state assignment;
5. verify once more.

## Bounded recovery

Every stage needs a timeout. No reconnect, subscription wait, cloud gate, or
schedule verification may remain pending indefinitely.

## Recovery cooldown

A failed recovery must not create a reconnect loop. Track the last recovery
attempt and result, apply a cooldown, and report when recovery is skipped due
to that cooldown.

## Safe logs

Normal logs should report:

- session generation;
- state transition;
- reason category;
- durations;
- pending cloud read/write counts;
- age of last raw/decoded/correlated inbound activity;
- success or failure of SUBACK;
- first post-reconnect request outcome.

They should not report:

- raw subscription topics;
- client IDs;
- usernames/passwords;
- device IDs unless existing diagnostic policy already permits them;
- raw HomeData or message payloads at info level.

---

# Commit 1: Instrument MQTT session readiness and inbound cloud activity

## Purpose

Create the observability and readiness model needed by later commits without
yet enabling automatic timeout-triggered recovery.

The repository must remain behaviorally conservative after this commit. Normal
connections should work as before, but `ready` must now mean that subscription
acknowledgement has succeeded.

## Expected production files

Primary:

- `roborockLib/lib/roborock_mqtt_connector.js`
- `roborockLib/roborockAPI.js`

Possible helper:

- a new small MQTT session-state/readiness helper under `roborockLib/lib/`

Generated output should be rebuilt only as required by repository convention.

## Work items

### 1. Move mutable MQTT session state onto the connector instance

Where practical, replace mutable module-level state with instance fields:

```text
client
rriot/session credentials
endpoint
mqttUser
mqttPassword
connected/socketConnected
subscriptionReady
sessionState
sessionGeneration
```

This prevents an old callback from accidentally reading a newly assigned
module-global client.

Credential derivation and the normal Roborock client identity must remain
unchanged.

### 2. Introduce explicit state and generation

Add state transition helpers instead of scattering Boolean assignments.

Conceptual API:

```js
transitionSessionState(nextState, reason);
isReady();
getSessionGeneration();
getSessionHealthSnapshot();
```

Increment the generation at the documented boundary chosen by the
implementation. The recommended boundary is creation of a new candidate
client/session, with `readyAt` recorded only after SUBACK.

### 3. Centralize client handler installation

Create one method that installs handlers on a specific client and generation:

```js
installClientHandlers(candidate, generation);
```

Every handler must first verify that:

```text
candidate is still the active client
generation is still the active generation
shutdown has not begun
```

Handlers include:

- `connect`;
- `message`;
- `error`;
- `close`;
- `offline`;
- `reconnect`.

### 4. Use one authoritative subscription path

Subscribe after the `connect` event. The `reconnect` event should be telemetry,
not a second independent subscription path.

Use `subscribeAsync()` or wrap the callback form in a bounded promise.

Validate:

- a grant exists for the expected topic;
- the grant is not a failure value;
- the client and generation are still current;
- shutdown did not start while awaiting SUBACK.

Do not log the raw topic.

### 5. Mark ready only after SUBACK

Separate:

```text
socketConnected=true
subscriptionReady=false
```

from:

```text
socketConnected=true
subscriptionReady=true
sessionState=ready
```

`isConnected()` may need compatibility behavior during this commit, but cloud
request readiness should eventually use `isReady()`.

Document any temporary compatibility layer clearly so Commit 2 can remove it.

### 6. Track inbound processing stages

Record timestamps/counters at distinct stages:

1. raw MQTT `message` callback invoked;
2. topic attributed to a known robot;
3. Roborock envelope decoded;
4. request reply correlated;
5. per-robot decoded/correlated activity.

Suggested fields:

```text
lastRawMqttMessageAt
lastAttributedCloudMessageAt
lastDecodedCloudMessageAt
lastCorrelatedCloudReplyAt
lastDecodedCloudMessageAtByDuid
lastCorrelatedCloudReplyAtByDuid
```

Use monotonic durations for decisions where possible; wall-clock timestamps are
appropriate for diagnostics.

### 7. Expand the health snapshot

Return a redacted structure such as:

```json
{
  "state": "ready",
  "generation": 12,
  "socketConnected": true,
  "subscriptionReady": true,
  "readyAgeMs": 120000,
  "lastRawInboundAgeMs": 90000,
  "lastDecodedInboundAgeMs": 90000,
  "lastCorrelatedReplyAgeMs": 90000
}
```

Do not treat an old timestamp by itself as failure. The fields are
instrumentation for Commit 3's active-failure policy.

### 8. Improve timeout diagnostics without changing recovery policy

When a cloud request times out, include a concise health snapshot:

```text
connected
subscriptionReady
generation
last raw inbound age
last decoded inbound age
last correlated reply age
messages received while request was pending
```

Preserve warning suppression so diagnostics do not flood normal logs.

### 9. Preserve current error containment

Keep the outer `try/catch` around the inbound message callback. Add counters
before parsing without allowing parsing exceptions to escape the callback.

### 10. Preserve current shutdown behavior

Old-client handlers and subscription promises must be cancelable/ignorable
during shutdown. This commit must not create new timers or listeners that keep
the process alive.

## Commit 1 automated tests

Add or extend tests to prove:

1. Socket connect does not imply subscription readiness.
2. Readiness becomes true only after successful SUBACK.
3. Subscription failure leaves the connector non-ready.
4. Subscription timeout leaves the connector non-ready.
5. The response topic is subscribed exactly once per successful connection.
6. The `reconnect` event does not initiate a duplicate subscription.
7. Session generation increments at the chosen boundary.
8. A late `connect` from an old client is ignored.
9. A late SUBACK from an old generation is ignored.
10. A late `close` from an old client cannot mark the new client disconnected.
11. Raw inbound activity is recorded before attribution/parsing.
12. Attributed activity is recorded only after topic attribution.
13. Decoded activity is recorded only after successful decoding.
14. Correlated activity is recorded only after a pending request is resolved.
15. Per-robot activity is separated correctly.
16. A parser exception is logged and contained.
17. Health snapshots contain no topic, client ID, or credential.
18. Shutdown during connect/SUBACK prevents readiness.
19. All temporary listeners and timers are removed.

Prefer fake MQTT clients and fake timers. Do not use real network access.

## Commit 1 acceptance criteria

- All existing behavior tests pass.
- New readiness tests pass deterministically.
- Normal startup reaches `ready` only after SUBACK.
- No automatic reconnect is introduced solely because inbound traffic is old.
- No duplicate subscription occurs on reconnect.
- Debug and diagnostic output contains no new secrets.
- Lint, type checks, build, and the complete test suite pass.

## Commit 1 review focus

Reviewers should concentrate on:

- state naming and transition correctness;
- generation boundary;
- SUBACK validation;
- old-client event guards;
- secret-safe diagnostics;
- absence of behavior-changing recovery policy.

---

# Commit 2: Serialize account MQTT session recreation and cloud requests

## Purpose

Provide a safe, reusable account-level recovery primitive and ensure cloud
requests cannot race with session replacement.

This commit supplies mechanism, not schedule-specific recovery policy. It may
be invoked by explicit disconnected-client recovery or test hooks, but Commit
3 owns the decision to invoke it after schedule failures.

## Expected production files

Primary:

- `roborockLib/lib/roborock_mqtt_connector.js`
- `roborockLib/lib/messageQueueHandler.js`
- `roborockLib/roborockAPI.js`

Possible helper/types:

- the session-state helper introduced in Commit 1;
- a pending-request/recovery error helper under `roborockLib/lib/`.

## Work items

### 1. Add a single-flight reconnect primitive

Conceptual API:

```ts
interface MqttReconnectOptions {
  reason: string;
  mode: "preventive" | "recovery";
  drainTimeoutMs: number;
  connectTimeoutMs: number;
  subscribeTimeoutMs: number;
}

interface MqttReconnectResult {
  generation: number;
  connected: boolean;
  subscriptionAcknowledged: boolean;
  oldCloudRequestsRejected: number;
  durationMs: number;
}

reconnectAndWaitReady(options): Promise<MqttReconnectResult>
```

Maintain one `reconnectInProgress` promise. Concurrent callers adopt it.
Clear the field in `finally` only if it still points to that operation.

### 2. Add an account-wide cloud readiness gate

Provide a bounded wait primitive:

```js
waitUntilReady({ timeoutMs, signal });
```

Required behavior:

- resolves immediately while ready;
- waits while connecting/subscribing/reconnecting;
- rejects on timeout;
- rejects on shutdown;
- releases every waiter after successful SUBACK;
- rejects every waiter after terminal reconnect failure;
- does not affect local transport.

### 3. Gate publication at the generic transport boundary

Before any cloud request is published, await readiness. Do not implement this
only in schedule code.

The request's response timeout should start when the request is actually
published, not while it waits behind the readiness gate. A separate bounded
gate timeout prevents indefinite waiting.

Re-evaluate device online state and shutdown state after the wait, because
those conditions can change while blocked.

### 4. Enrich pending request metadata

Add:

```text
duid
transport
operationClass (read/write/fire-and-forget/secure-map)
sessionGeneration
createdAt
publishedAt
method
```

Do not rely on method-name string guesses where the caller can supply an
operation class explicitly.

### 5. Define preventive drain semantics

For a future scheduled/manual preventive refresh:

1. close the cloud gate;
2. wait for old-generation cloud requests to finish;
3. if a cloud write remains pending, defer or skip;
4. reconnect only when safe;
5. never interrupt an active write merely to refresh a healthy session.

This mode is not required to be exposed in configuration in this pull request,
but the primitive should make the safe distinction.

### 6. Define failure-recovery semantics

For a session believed stale:

1. close the cloud gate;
2. allow a short bounded drain;
3. reject remaining old-generation cloud requests exactly once;
4. clear their response timers;
5. remove them from the pending map;
6. clear secure/photo/map buffers owned by those requests where required;
7. use a typed `MqttSessionReplacedError` carrying safe metadata;
8. preserve local pending requests.

### 7. Recreate the session

Preferred implementation:

1. detach managed handlers from the old client;
2. force-close the old client with bounded cleanup;
3. create a new mqtt.js client using the same Roborock-derived identity;
4. install generation-bound handlers;
5. await connect;
6. await and validate SUBACK;
7. mark the new generation ready;
8. release gate waiters.

If the implementation reuses the mqtt.js client object instead, tests must
prove that internal state, listeners, outgoing stores, and reconnect timers do
not leak across the generation. A genuinely new client is easier to reason
about.

### 8. Protect against late messages and ID reuse

When resolving a cloud reply, ensure the pending request belongs to the active
generation. A reply associated only with an old generation must not resolve a
new request that happens to reuse the same numeric ID.

If the wire protocol does not expose generation, use the active client
instance plus pending generation and ensure old-client message handlers are
disabled before new requests publish.

### 9. Integrate shutdown

Shutdown must:

- close the gate permanently;
- reject readiness waiters;
- cancel reconnect timeouts;
- invalidate the active generation;
- reject pending requests exactly once;
- prevent creation of a replacement client;
- remove listeners;
- leave no referenced timer or socket.

### 10. Add reconnect cooldown/backoff

Track:

```text
lastReconnectAttemptAt
lastReconnectSucceededAt
lastReconnectFailureAt
consecutiveReconnectFailures
nextReconnectAllowedAt
```

The generic primitive should accept an explicit manual override only for
controlled use. Normal automatic callers respect cooldown.

### 11. Add safe lifecycle logs

Example:

```text
MQTT generation 12 entering recovery: reason=silent-cloud-timeouts;
pendingCloudReads=2; pendingCloudWrites=0.
MQTT generation 13 subscription acknowledged; recovery completed in 1840ms.
```

No raw topic or account identity should be logged.

## Commit 2 automated tests

Add or extend tests to prove:

1. Multiple reconnect callers cause one physical reconnect.
2. Every caller receives the same result.
3. New cloud reads wait while the gate is closed.
4. New cloud writes wait while the gate is closed.
5. Local requests continue during reconnect.
6. Response timeouts begin after publication, not while waiting at the gate.
7. Gate waiters have a bounded timeout.
8. Successful SUBACK releases waiters.
9. Failed SUBACK rejects waiters.
10. Preventive mode waits for pending cloud reads.
11. Preventive mode skips rather than interrupts a pending write.
12. Recovery mode rejects stuck old-generation cloud reads exactly once.
13. Recovery mode identifies ambiguous old-generation writes.
14. Local pending requests are untouched.
15. Every rejected request has its timeout cleared.
16. Secure map/photo buffers are cleaned correctly.
17. Old replies cannot resolve new-generation requests.
18. Old-client events cannot alter current state.
19. Reconnect cooldown prevents a loop.
20. Shutdown during drain is safe.
21. Shutdown during connect is safe.
22. Shutdown during SUBACK is safe.
23. No reconnect occurs after shutdown.
24. No listener/timer/socket leaks remain after each path.
25. The same normal client identity is reused without being logged.

## Commit 2 acceptance criteria

- The connector exposes a tested single-flight reconnect-and-ready primitive.
- `ready` requires a successful subscription acknowledgment.
- All cloud publications pass through one readiness gate.
- Local requests remain independent.
- Pending requests are transport- and generation-aware.
- Failure recovery never leaves a pending promise or timeout orphaned.
- No automatic schedule retry policy is introduced yet.
- Full lint, type checks, build, and tests pass.

## Commit 2 review focus

Reviewers should concentrate on:

- deadlock freedom;
- exact-once resolve/reject behavior;
- when response timers start;
- old-generation isolation;
- read/write distinction;
- shutdown races;
- preservation of local transport;
- whether creating a new client is safer than reusing the old object.

---

# Commit 3: Recover ambiguous schedule writes through reconnect and verification

## Purpose

Use the account-level recovery primitive to make schedule enable/disable
transactions reliable when the cloud reply path becomes silently stale.

This commit must preserve the existing consolidated batch design. One failed
verification for a batch should cause at most one account reconnect and one
consolidated post-reconnect authoritative read—not one reconnect per switch.

## Expected production files

Primary:

- `src/hap_schedule_accessory.ts`
- `src/hap_schedule_api.ts` if typed operation metadata/options are needed
- `roborockLib/lib/messageQueueHandler.js` only if classification hooks cannot
  be completed cleanly in Commit 2
- `roborockLib/roborockAPI.js` for a narrow recovery facade if schedule code
  should not access the connector directly

Generated distribution artifacts should be rebuilt as required.

## Work items

### 1. Define a narrow recoverable failure classifier

Recovery should trigger for the observed silent-cloud shape, not for every
error.

Candidate requirements:

- request used cloud transport;
- failure is a response timeout or typed session-replacement error;
- MQTT was nominally connected or had just been marked stale;
- no decoded/correlated inbound cloud message arrived during the request;
- recovery cooldown permits an attempt;
- shutdown/disposal is not active.

Do not use recovery for:

- explicit robot refusal;
- invalid parameters;
- unsupported methods;
- authentication failure requiring a new account login;
- definite rate-limit response during cooldown;
- device explicitly offline unless policy says a session-level failure is also
  present;
- parser rejection of a valid but unsupported schedule shape.

### 2. Treat primary write timeouts as ambiguous

Today, a primary write that throws is recorded as failed and may leave no
primary request eligible for verification. Under silent MQTT failure, the
write may still have reached the robot.

For a recoverable ambiguous write failure:

1. retain the requested schedule/state in an ambiguous set;
2. do not immediately retry it;
3. continue collecting batch results safely;
4. invoke one consolidated account recovery for the batch;
5. read all schedules authoritatively after reconnect;
6. remove requests already matching the desired state from the failure set;
7. retry only confirmed mismatches if the operation is an idempotent state
   assignment.

### 3. Recover failed verification reads

If primary writes returned but the verification `get_server_timer` read fails
with the recoverable silent shape:

1. invoke the same single-flight account recovery;
2. wait for connection plus SUBACK;
3. perform one consolidated authoritative schedule read;
4. compare every batch request;
5. accept already-matching requests;
6. send fallback/retry writes only for true mismatches.

### 4. Preserve read-before-write ordering

No ambiguous primary or fallback write may be repeated until a successful
post-reconnect read proves the desired state is absent.

This is the central correctness invariant of Commit 3.

### 5. Limit recovery to one attempt per batch

Define a strict budget:

```text
maximum account reconnects per schedule batch: 1
maximum post-reconnect authoritative reads before retry: 1
maximum retry/fallback write per mismatched schedule: 1
maximum final authoritative verification reads: 1
```

If the final read fails, return failure. Do not recurse into another reconnect
inside the same HomeKit operation.

### 6. Preserve fallback semantics

The existing primary `upd_server_timer` and fallback `upd_timer` behavior must
remain model-compatible.

Recovery should not automatically run fallback merely because the original
verification transport failed. Fallback is warranted only after a successful
authoritative read shows that the primary requested state is absent.

### 7. Keep account queue ownership explicit

The schedule batch already runs inside the account coordinator. Its recovery
and verification calls must not enqueue behind themselves.

Document and test the lock/wait graph:

- schedule account queue held;
- cloud gate may close/reopen;
- reconnect single flight may be adopted;
- post-reconnect verification reads directly while queue ownership is known;
- no background `onGet` refresh can be adopted if it waits behind the current
  batch.

### 8. Bound the HomeKit operation

Set explicit budgets for:

- write request timeout;
- propagation delay;
- reconnect drain;
- connection wait;
- SUBACK wait;
- post-reconnect read;
- final verification.

Calculate and document the worst-case duration. If it exceeds the reliable HAP
or Config UI request window, the implementation must either:

- shorten bounded stages;
- fail the synchronous request and complete reconciliation in the background;
- or expose a dedicated asynchronous operation API in a later change.

Do not leave the `onSet` promise unbounded.

### 9. Propagate exhausted failure to the caller

After rolling the switch characteristic back and recording cooldown, rethrow
the final error so the HomeKit/Config UI API caller can distinguish success
from failure.

Expected semantics:

- verified final state matches request: resolve;
- request superseded by a newer desired state: resolve/return according to
  existing supersession contract;
- recovery exhausted or authoritative state mismatches: reject;
- disposed/shutdown operation: settle deterministically according to shutdown
  contract.

Assess and document the visible Home app behavior of rejecting `onSet`.

### 10. Preserve characteristic rollback and later correction

On exhausted failure:

- restore the last authoritative local switch value;
- report the failure;
- retain caches rather than inventing state;
- allow a later successful refresh to correct the characteristic;
- retain the existing failed-command cooldown unless recovery changes make a
  different value demonstrably necessary.

### 11. Add structured batch outcome logging

Example safe summary:

```text
Schedule recovery batch: requested=8; primaryAcked=6; ambiguous=2;
reconnectGeneration=14; alreadyAppliedAfterReconnect=7; retried=1;
finalConfirmed=8; failed=0.
```

Avoid logging raw schedule tuples. Existing schedule IDs may remain under the
plugin's established debug policy, but normal info logs should prefer counts.

### 12. Consider ordinary read recovery separately

The critical path is a write requiring verification. A single background
`onGet` refresh timeout should normally retain existing backoff behavior rather
than immediately reconnecting.

A conservative initial policy is:

- critical ambiguous write/verification failure: one immediate recovery
  attempt, because an outcome must be established;
- ordinary background read: recovery only after repeated silent account-level
  failures or leave it to a later policy change.

This avoids excessive reconnects caused by occasional lost reads.

## Commit 3 automated tests

Add or extend tests to prove:

1. A normal successful batch performs no reconnect.
2. A primary write timeout is classified as ambiguous when appropriate.
3. Ambiguous writes are not immediately repeated.
4. Multiple ambiguous writes cause one account reconnect.
5. Post-reconnect read shows all changes applied: no writes are repeated.
6. Post-reconnect read shows a subset applied: only mismatches are retried.
7. Post-reconnect read shows none applied: each idempotent change is retried at
   most once with configured spacing.
8. Failed verification after acknowledged primary writes reconnects once.
9. Successful post-reconnect verification avoids fallback writes.
10. Fallback occurs only after an authoritative mismatch.
11. Final verification confirms every requested state before success.
12. Final verification timeout rejects the batch.
13. Explicit robot refusal does not trigger reconnect.
14. Definite throttle does not trigger reconnect during cooldown.
15. Invalid/unsupported request does not trigger reconnect.
16. Two vacuums encountering the same stale session adopt one reconnect.
17. Background `onGet` refresh cannot deadlock a verifying batch.
18. Account queue remains usable after recovery succeeds.
19. Account queue remains usable after recovery fails.
20. Each switch promise resolves only when its requested state is confirmed.
21. Each failed switch promise rejects after rollback.
22. A superseded switch request follows the existing supersession contract.
23. The 30-second failed-command cooldown does not silently convert an
    exhausted failure into reported success.
24. Schedule caches and services survive MQTT recovery.
25. Shutdown/disposal settles every batch and gate waiter.
26. Fake timers leave no open handles.
27. Worst-case recovery stays inside the documented bound.

## Commit 3 acceptance criteria

- A schedule batch survives one stale MQTT session by reconnecting and
  authoritatively reconciling state.
- No ambiguous write is repeated before a successful read.
- One batch performs at most one reconnect.
- One account performs at most one physical reconnect when multiple callers
  detect the same failure.
- Success means consolidated authoritative final state matches the request.
- Exhausted failure is visible to the HAP/Config UI caller.
- Switch rollback remains correct.
- Existing backoff, throttle, batching, spacing, and deadlock protections pass.
- Full lint, type checks, build, and complete test suite pass.

## Commit 3 review focus

Reviewers should concentrate on:

- ambiguous-write correctness;
- authoritative read-before-retry invariant;
- one reconnect per batch;
- fallback ordering;
- account queue/cloud gate lock ordering;
- caller-visible rejection behavior;
- worst-case latency;
- continued compatibility with HomeKit UI behavior.

---

# Cross-commit file and ownership map

## `roborockLib/lib/roborock_mqtt_connector.js`

Owns:

- client creation;
- session state;
- connection generation;
- handler lifecycle;
- inbound stage timestamps;
- connect/SUBACK readiness;
- reconnect single flight;
- gate readiness primitive;
- client teardown;
- redacted session diagnostics.

It should not own schedule policy.

## `roborockLib/lib/messageQueueHandler.js`

Owns:

- transport decision;
- waiting for cloud readiness before publish;
- pending request metadata;
- starting response timeout after publication;
- exact-once timeout cleanup;
- attaching generation/operation class to requests.

It should not decide when schedule recovery is warranted.

## `roborockLib/roborockAPI.js`

Owns:

- account lifecycle;
- timer registration and shutdown;
- shared pending request collection;
- a narrow facade for account-level recovery if needed;
- metrics shared across vacuums;
- cooldown state if it is account-scoped.

## `src/hap_schedule_accessory.ts`

Owns:

- schedule batching;
- schedule-specific recoverable error classification;
- authoritative reconciliation;
- fallback/retry decisions;
- switch rollback;
- caller-visible success/failure;
- schedule recovery metrics.

It should call a generic recovery facade rather than manipulating the MQTT
client directly.

## `src/hap_schedule_api.ts`

May own:

- typed request options identifying read/write operation class;
- typed schedule API wrappers;
- no MQTT lifecycle behavior.

## Tests

Prefer focused tests rather than one monolithic suite:

- MQTT readiness and generations;
- subscription acknowledgment;
- reconnect single flight;
- cloud gate behavior;
- pending request generations and cleanup;
- shutdown races;
- schedule recovery transaction;
- source-level contracts only where behavior cannot reasonably be exercised.

Behavioral tests are preferred over assertions pinned to literal call-site
text.

---

# Lock ordering and deadlock analysis

Before implementation, document the exact ordering of:

1. schedule account coordinator;
2. per-vacuum schedule write queue;
3. MQTT reconnect single flight;
4. cloud readiness gate;
5. pending request completion.

Recommended rules:

- The reconnect primitive must never wait to acquire the schedule account
  queue.
- The cloud gate must never execute schedule callbacks while changing state.
- A schedule batch holding the account queue may await reconnect readiness,
  because reconnect does not require that queue.
- A post-reconnect schedule read performed while the account queue is already
  held must use the direct held-queue path.
- A background refresh queued behind the batch must not be adopted by that
  batch's verification.
- Request rejection during reconnect must not synchronously call back into the
  reconnect primitive while it holds mutable-state locks.
- Promise settlement should occur after internal collections/state are updated
  to avoid reentrant observers seeing inconsistent state.

Add at least one test for each plausible wait-cycle, including the previously
identified pattern where verification adopted a refresh queued behind its own
batch.

---

# Error taxonomy

Use typed/tagged errors rather than parsing message strings in policy code.

Suggested categories:

```text
CloudUnavailableError
CloudRequestTimeoutError
SilentCloudRequestTimeoutError
MqttSessionReplacedError
MqttConnectTimeoutError
MqttSubscriptionError
MqttSubscriptionTimeoutError
MqttRecoveryCooldownError
RobotRefusalError
RobotOfflineError
DefiniteThrottleError
ScheduleVerificationMismatchError
ScheduleRecoveryExhaustedError
ShutdownError
```

Every error should expose only safe structured fields required for policy and
diagnostics. Preserve `cause` where supported.

The schedule layer should classify based on tags/fields, not English error
text.

---

# Metrics and diagnostics

Add account-scoped counters such as:

```text
mqttSessionGenerations
mqttReconnectAttempts
mqttReconnectSuccesses
mqttReconnectFailures
mqttSubscriptionFailures
cloudRequestsGated
cloudGateTimeouts
oldGenerationRequestsRejected
silentCloudTimeouts
scheduleRecoveryAttempts
scheduleRecoverySuccesses
scheduleRecoveryFailures
scheduleWritesAlreadyAppliedAfterReconnect
scheduleWritesRetriedAfterReconnect
```

Useful timestamps:

```text
lastSocketConnectedAt
lastSubscriptionReadyAt
lastRawMqttMessageAt
lastAttributedCloudMessageAt
lastDecodedCloudMessageAt
lastCorrelatedCloudReplyAt
lastReconnectAttemptAt
lastReconnectSucceededAt
```

Metrics should be queryable in diagnostics but should not create frequent info
logs.

---

# Timing budget proposal

Final values should be validated against HomeKit and Config UI behavior. A
starting design budget might be:

```text
primary write timeout:              existing 10 seconds
robot propagation delay:            existing 3 seconds
reconnect drain in recovery mode:   0–2 seconds
connect timeout:                    10 seconds
SUBACK timeout:                     5 seconds
post-reconnect authoritative read:  10 seconds
write retry timeout:                10 seconds if needed
final propagation delay:            3 seconds if needed
final authoritative read:           10 seconds
```

The worst case is too long for a comfortable synchronous HomeKit operation if
every stage is exercised. Before Commit 3 is finalized, choose one of these:

1. Use shorter recovery-stage bounds and accept failure when exceeded.
2. Keep `onSet` bounded and finish reconciliation in the background.
3. Add a later dedicated asynchronous Config UI operation API for scripts.

For the initial pull request, prefer correctness and a documented hard bound.
Do not let a HomeKit promise remain pending indefinitely.

---

# Automated test strategy

## Fake MQTT client

Provide a controllable fake that can:

- emit connection lifecycle events;
- hold, resolve, or reject SUBACK;
- record subscriptions without exposing real topics in snapshots;
- accept publications;
- emit correlated and uncorrelated replies;
- emit late events after replacement;
- simulate close/error/offline during every phase;
- expose active listener counts;
- model multiple client generations.

## Fake clock/timers

Use fake timers for:

- response timeouts;
- gate timeouts;
- connect/SUBACK timeouts;
- write spacing;
- verification delay;
- failure and reconnect cooldown;
- shutdown cancellation.

Avoid tests that sleep in real time.

## Deterministic dependency injection

Inject or wrap:

- MQTT client factory;
- time source;
- timers;
- randomness/jitter if later added;
- account recovery facade.

Do not depend on module cache manipulation where a normal injected factory can
provide isolation.

## Test cleanup

Every test should verify as applicable:

- no open timers;
- no unresolved waiters;
- no pending requests;
- no listeners on retired clients;
- no new client after shutdown;
- no unhandled rejection.

## Full repository checks

At the end of every commit, run the repository's standard commands discovered
from `package.json`, normally including:

```text
npm test
npm run lint
npm run typecheck
npm run build
```

Use the exact available script names rather than assuming them. Run focused
tests during development and the complete suite before each commit.

---

# Human and hardware validation

Automated tests can cover most state and concurrency behavior, but they cannot
prove how the Roborock broker behaves in the field.

## Required manual validation

1. Start the plugin with two robots and confirm one account MQTT session.
2. Confirm connect followed by acknowledged subscription readiness.
3. Confirm ordinary local and cloud requests.
4. Trigger a manual recovery while the cloud path is idle.
5. Confirm local requests continue.
6. Confirm both robots answer the first post-recovery cloud reads.
7. Confirm no accessories are recreated and schedule names/rooms remain.
8. Confirm HomeKit behavior for a verified schedule write.
9. Confirm HomeKit behavior for an intentionally failed/rejected write.
10. Run the external pause/unpause script and verify its API failure handling.

## Ambiguous-write validation

With care and a disposable test schedule:

1. send an enable/disable write;
2. interrupt only the reply path if a controlled test mechanism exists;
3. reconnect;
4. confirm the authoritative read detects whether the first write applied;
5. verify no duplicate write is sent when state already matches;
6. verify one retry occurs when state does not match.

Do not perform destructive fault injection against production schedules
without a recorded restore plan.

## Soak test

Run for at least 24–72 hours with:

- debug logging optional but targeted transport telemetry enabled;
- both robots available;
- normal local polling;
- periodic organic cloud reads;
- at least one pause and unpause cycle;
- tracking of session generation, silent timeouts, recovery, and first
  post-reconnect outcome.

The most useful field proof is:

```text
silent multi-method timeout condition
→ one automatic reconnect
→ successful SUBACK
→ successful authoritative read
→ correct schedule state without duplicate writes
```

---

# Risk register and mitigations

## Risk: reconnect interrupts a write

Mitigation:

- distinguish preventive drain from failure recovery;
- track operation class;
- treat interrupted writes as ambiguous;
- read before retrying.

## Risk: reconnect storm

Mitigation:

- account-level single flight;
- cooldown/backoff;
- one recovery per schedule batch;
- no reconnect based on idle age alone.

## Risk: deadlock between account queue and cloud gate

Mitigation:

- reconnect never acquires schedule queue;
- document lock order;
- direct verification path while account queue held;
- behavioral deadlock tests.

## Risk: old event corrupts new state

Mitigation:

- client-instance and generation guards;
- detach old handlers;
- reject old pending requests;
- test every late event type.

## Risk: false readiness

Mitigation:

- require connect plus valid SUBACK;
- separate socket and subscription flags;
- optionally record first correlated reply separately from readiness.

## Risk: HomeKit times out during recovery

Mitigation:

- hard recovery budget;
- caller-visible failure;
- consider later asynchronous operation API;
- measure real HomeKit/Config UI timeout behavior.

## Risk: duplicate schedule changes

Mitigation:

- authoritative read after reconnect;
- retry only confirmed mismatches;
- one retry maximum;
- retain write spacing and batching.

## Risk: local behavior regresses

Mitigation:

- gate cloud only;
- retain local pending requests;
- add tests proving local success throughout reconnect.

## Risk: secrets in telemetry

Mitigation:

- never log raw subscription topics/client identity;
- use redacted generation/count/age fields;
- add tests scanning diagnostics for known credentials/topic fragments.

---

# Pull request structure

## Commit 1

Suggested subject:

```text
Instrument MQTT session readiness and inbound cloud activity
```

Suggested body points:

- distinguish socket connection from acknowledged subscription readiness;
- track MQTT generation and inbound processing stages;
- bind handlers to client generations;
- improve redacted health diagnostics;
- no automatic timeout recovery yet.

## Commit 2

Suggested subject:

```text
Serialize account MQTT session recreation and cloud requests
```

Suggested body points:

- add account-wide single-flight reconnect;
- gate cloud publication while reconnecting;
- make pending requests transport/generation-aware;
- drain or reject old-generation requests safely;
- preserve local transport and shutdown correctness.

## Commit 3

Suggested subject:

```text
Recover ambiguous schedule writes through reconnect and verification
```

Suggested body points:

- classify silent verification failures;
- reconnect once per consolidated schedule batch;
- read authoritative state before retrying writes;
- retry only confirmed mismatches;
- reject caller-visible operations when recovery is exhausted.

## Pull request description outline

### Motivation

- MQTT can remain nominally connected while cloud replies stop arriving.
- Both schedule and map commands have shown the silent failure shape.
- Restarting the child bridge is followed by successful cloud reads.
- Schedule writes require authoritative confirmation and cannot safely be
  retried blindly.

### Implementation

- Commit 1: readiness, generations, SUBACK, telemetry.
- Commit 2: account-level reconnect single flight, cloud gate, pending request
  lifecycle.
- Commit 3: schedule-specific recovery and authoritative reconciliation.

### Safety

- no reconnect from idle age alone;
- local transport remains available;
- old events are generation-guarded;
- writes are read back before retry;
- one reconnect per batch;
- bounded waits and cooldown;
- caller receives exhausted failure.

### Testing

- list focused suites by commit;
- full lint/typecheck/build/test results;
- manual two-robot validation;
- soak duration and observed recovery outcome.

### Known limitations

- root cause may remain broker-, network-, client-, or device-cloud-side;
- real stale-session reproduction requires field observation;
- synchronous HomeKit recovery has a bounded latency budget;
- general map/status automatic recovery may remain future work.

---

# Definition of done

The pull request is ready for review when:

1. It contains the three commits in the documented order.
2. Every commit independently builds and passes its relevant tests.
3. The final tree passes all lint, type checks, build, and tests.
4. MQTT readiness requires successful SUBACK.
5. Old client generations cannot affect the current session.
6. Cloud requests cannot publish during session replacement.
7. Local requests remain functional during replacement.
8. Reconnect is account-scoped and single-flight.
9. Pending cloud requests settle exactly once with timers cleaned.
10. Schedule recovery reads state before retrying ambiguous writes.
11. A schedule batch causes at most one reconnect.
12. Success requires authoritative final-state confirmation.
13. Exhausted failure is visible to the caller.
14. Shutdown leaves no client, listener, timer, gate waiter, or request behind.
15. Logs and diagnostics expose no MQTT topic or credential.
16. Manual validation confirms both robots work after recreation.
17. A soak test demonstrates either successful automatic recovery or produces
    sufficient generation/SUBACK/inbound-stage evidence to diagnose failure.

---

# Guidance for the next Codex session

Start by reading:

- this plan;
- repository `AGENTS.md` files, if present;
- `WORKING_WITH_PEDRO.md`;
- `roborockLib/lib/roborock_mqtt_connector.js`;
- `roborockLib/lib/messageQueueHandler.js`;
- MQTT lifecycle portions of `roborockLib/roborockAPI.js`;
- schedule batching and verification in `src/hap_schedule_accessory.ts`;
- relevant MQTT, message queue, shutdown, and schedule tests.

Then:

1. Confirm the branch and clean working tree.
2. Inspect the exact npm scripts and repository build conventions.
3. Create a task plan matching the three commits.
4. Implement and fully test Commit 1 before beginning Commit 2.
5. Commit Commit 1 separately.
6. Implement and fully test Commit 2 before beginning Commit 3.
7. Commit Commit 2 separately.
8. Implement and fully test Commit 3.
9. Commit Commit 3 separately.
10. Run the complete repository verification suite.
11. Review the cumulative diff for secrets, generated artifacts, accidental
    changelog changes, and commit-boundary leakage.
12. Push the three commits and open one pull request using the structure above.

Do not collapse the commits during implementation, and do not amend earlier
commits after review has begun. If a later stage discovers a necessary fix to
an earlier stage, prefer a clearly explained follow-up commit during active
review unless the reviewer explicitly requests history cleanup.

## Questions to resolve before coding

The new session should explicitly answer these from repository behavior and
tests:

1. Should a new mqtt.js client object be created, or can the existing object be
   proven safe to reuse?
2. What exact QoS/grant values does the Roborock subscription expect?
3. What is the reliable synchronous timeout budget for HomeKit and Config UI
   characteristic writes?
4. Which schedule update methods are strictly idempotent state assignments?
5. Which pending secure/photo/map buffers require generation-specific cleanup?
6. Can numeric request IDs be reused quickly enough to require additional
   correlation protection?
7. Should exhausted `onSet` failure be rethrown directly, or exposed through a
   dedicated API to avoid undesirable Home app behavior?
8. What account-wide silent-failure threshold should eventually apply to
   non-schedule cloud operations?
9. Should ordinary background schedule reads trigger recovery, or only
   critical writes and verification?
10. What diagnostic fields are safe at info, debug, and exported-report levels?

Resolving these explicitly before Commit 3 will keep product-policy decisions
out of the lower-level transport commits.
