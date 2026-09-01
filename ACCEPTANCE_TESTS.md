# Acceptance Tests

This catalog defines the minimum observable behavior for `IMPLEMENTATION_PLAN.md`. Test names should include these IDs so future agents can run focused subsets. Unit tests use injected clocks/timers and must not sleep in real time.

## Core contracts

- **CORE-01:** Process-state ordering is `Undefined=0`, `Ok=1`, `Warning=2`, `Error=3`; fake wall and monotonic clocks advance independently.
- **EVT-01:** Engine bus preserves publication order and isolates listener failures.
- **EVT-02:** Unsubscribe/Engine close removes listeners; two Engines never receive each other's events.
- **STATE-01:** In-memory `StateStore` implements load/save/delete/keys and never returns mutable stored references.

## Configuration and plugins

- **CFG-01:** Explicit registry resolves an installed stable type ID.
- **CFG-02:** Duplicate or unavailable plugin type IDs fail before Engine readiness.
- **CFG-03:** Valid configuration receives plugin defaults without mutating raw input.
- **CFG-04:** Missing required settings produce JSON-path errors.
- **CFG-05:** Invalid intervals, buffer limits, or IDs are rejected.
- **CFG-06:** Missing required datafeeds and unresolved Datastream mappings fail startup.
- **CFG-07:** Unknown configuration fields follow the schema's explicit reject/allow policy.

## Diagnostics

- **DIAG-01:** First condition observation creates one registry record and emits `diagnostic.raised`.
- **DIAG-02:** A material severity/message/details change emits `diagnostic.updated`.
- **DIAG-03:** An identical observation updates `lastObservedTs`/count without publishing another event.
- **DIAG-04:** Explicit clear removes the record and emits `diagnostic.cleared` once.
- **DIAG-05:** A successful empty evaluation scope clears conditions previously owned by that scope.
- **DIAG-06:** A thrown evaluation discards its incomplete scope and does not clear prior plugin conditions.
- **DIAG-07:** One owner scope cannot update or clear another owner's records.
- **DIAG-08:** Session diagnostics are discarded on a new session; condition diagnostics restore.

## Datastreams

- **DS-01:** Samples remain timestamp-sorted after out-of-order arrival.
- **DS-02:** A sample with the same timestamp replaces the prior sample and does not increase length.
- **DS-03:** Age and length pruning both apply, with the configured minimum practical buffer length.
- **DS-04:** Inclusive range, last-value, and average queries return correct values/timestamps or `null`.
- **DS-05:** Valid input updates timestamps, due time, buffer, persistence dirty state, and `entity.updated`.
- **DS-06:** Invalid/sentinel input sets `hwError` and its diagnostic without inserting a numeric sample.
- **DS-07:** An empty buffer becomes stale only after startup grace and interval margin.
- **DS-08:** Fresh data clears `noDataError` and its diagnostic.
- **DS-09:** Stale evaluation runs without incoming data or an Application request.

## Device, Application, and Asset

- **DEV-01:** Device defaults are `hwError=false`, `error=false`, and a default timestamp.
- **DEV-02:** Device `error` includes its own `hwError` and every child's `hwError/noDataError`.
- **DEV-03:** Clearing the final source error clears Device `error` after recomputation.
- **DEV-04:** Invalid payload diagnostics reconcile on the next successful parse.
- **ASSET-01:** Empty Asset state is `currState=Undefined` and `error=false`.
- **ASSET-02:** Asset `currState` is the maximum direct Application `currState`.
- **ASSET-03:** Asset `error` is true iff a child has `noDataError` or `appError`.
- **APP-01:** A not-yet-due Application does not execute or mutate run timestamps.
- **APP-02:** Every run first resets common state to `0/false/false` and refreshes required Datastream stale state.
- **APP-03:** Successful execution atomically commits common and plugin-specific state.
- **APP-04:** A thrown plugin leaves common state `currState=0`, `noDataError=false`, `appError=true`.
- **APP-05:** A thrown plugin does not partially commit plugin state or clear plugin-owned diagnostics.
- **APP-06:** A later successful run clears the runner exception diagnostic and replaces calculation state.
- **AGG-01:** A burst of child changes creates one pending parent timer.
- **AGG-02:** Parent recomputation reads the latest states and emits at most one update for that pass.
- **AGG-03:** A child change during recomputation schedules exactly one trailing pass.
- **AGG-04:** Startup/reset recomputation is synchronous; shutdown flushes and removes timers.

## Engine and snapshots

- **ENG-01:** Engine constructs all entities in dependency order with stable IDs.
- **ENG-02:** Duplicate entity IDs or unresolved mappings fail atomically.
- **ENG-03:** Two Engine instances have isolated registries, buses, state, and timers.
- **ENG-04:** Public registries/views cannot mutate live Engine objects.
- **SNAP-01:** Entity snapshot is a deep serializable copy with identity, type, relationships, and state.
- **SNAP-02:** Parent, children, and family requests return only the documented related entities.
- **SNAP-03:** Whole-Engine snapshot includes every entity and active diagnostic category.
- **SNAP-04:** Projection returns requested dotted paths.
- **SNAP-05:** Non-strict projection omits absent paths and reports entity/path pairs in `missingPaths`.
- **SNAP-06:** Strict projection fails atomically when any path is absent.

## Persistence and lifecycle

- **STATE-02:** Valid versioned entity state and condition diagnostics survive restart.
- **STATE-03:** Empty/deleted storage performs a supported cold start from defaults.
- **STATE-04:** Obsolete entity state is removed only after successful configuration construction.
- **STATE-05:** Persisted data contains no functions, timers, class instances, or readiness flag.
- **STATE-06:** Supported schema/plugin migrations transform state deterministically.
- **STATE-07:** Malformed/unmigratable state falls back to defaults and raises a diagnostic.
- **STATE-08:** A storage failure is surfaced and cannot silently diverge memory from persisted state.
- **LIFE-01:** Startup publishes/replays `starting` with `ready=false` before any true state.
- **LIFE-02:** Readiness becomes true only after validation, restoration/defaults, construction, aggregation, and scheduler startup.
- **LIFE-03:** Transition to ready emits `engine.lifecycle` and `engine.ready` with the same session ID.
- **LIFE-04:** A late Receiver immediately receives the current lifecycle state.
- **LIFE-05:** Startup infrastructure failure publishes/replays `failed`, never `engine.ready`.
- **LIFE-06:** Application health errors do not make Engine readiness false.
- **LIFE-07:** Shutdown first closes readiness and stops accepting work.
- **LIFE-08:** Shutdown drains parent recomputation, saves state, and removes timers/listeners.
- **LIFE-09:** Repeated shutdown is harmless.

## Scheduling and clock changes

- **SCHED-01:** Every configured Datastream, including unmapped ones, is scheduled for stale checks.
- **SCHED-02:** A Datastream may become stale before any Application is due.
- **SCHED-03:** One stale-task failure does not stop later stale tasks.
- **SCHED-04:** Stale scheduler timers are rescheduled and cleaned up correctly.
- **SCHED-05:** An overdue Application runs once and sets next due from the current run time.
- **SCHED-06:** Missed historical intervals are not replayed after restart.
- **SCHED-07:** One Application failure does not stop later Applications.
- **SCHED-08:** The same Application never overlaps; the selected skip/coalesce policy is deterministic.
- **CLOCK-01:** Small wall-clock corrections do not trigger reset.
- **CLOCK-02:** A jump beyond the configured horizon closes readiness and gates ingestion.
- **CLOCK-03:** Cold reset deletes Engine-owned state through `StateStore` and rebuilds defaults/empty buffers.
- **CLOCK-04:** Successful reset persists clean state, creates a new session, restarts schedulers, and reopens readiness.
- **CLOCK-05:** Reset persistence failure leaves Engine failed and not ready.

## First plugins

- **PLUG-DEV-01:** Enless manifest exposes stable ID, schema, defaults, and required `temp1/temp2` Datastreams.
- **PLUG-DEV-02:** Valid sensor type 12 payload updates both available temperature streams.
- **PLUG-DEV-03:** Values outside `[-100, 400]` set hardware fault and `SENSOR_BROKEN` without insertion.
- **PLUG-DEV-04:** A later valid value clears that scoped condition.
- **PLUG-DEV-05:** Malformed/wrong-sensor payload reports invalid input without partial updates.
- **PLUG-APP-01:** Application manifest exposes required feeds/settings and stable defaults.
- **PLUG-APP-02:** Missing averages remain Undefined during grace, then set `noDataError` and `NO_DATA`.
- **PLUG-APP-03:** `tempOutAvg - tempInAvg` above margin sets `appError` and its diagnostic.
- **PLUG-APP-04:** Input below off threshold sets `operState=Off` and leaves process state Undefined.
- **PLUG-APP-05:** On-state with excessive temperature difference sets Warning and `FAILED_CLOSED`.
- **PLUG-APP-06:** Healthy on-state sets Ok and clears prior condition diagnostics automatically.
- **PLUG-APP-07:** Average values and timestamps use the configured inclusive window.
- **PLUG-APP-08:** Plugin uses scoped reporting and has no null-filled diagnostic payload.
- **PROFILE-01:** Example profile registers only the selected Device/Application plugins.
- **PROFILE-02:** Example configuration validates and constructs its full graph.
- **PROFILE-03:** Referencing an unregistered type fails before ready.

## Node-RED adapters

- **NR-01:** Node-RED 3.0.2 discovers all four node types from package metadata.
- **NR-02:** Engine config node creates one Engine and exposes it to referencing nodes.
- **NR-03:** Invalid configuration reports status/error and never becomes ready.
- **NR-04:** `ieps` context adapter reads/writes the selected named store.
- **NR-05:** Missing selected context store fails clearly.
- **NR-06:** Config-node close awaits Engine shutdown and calls the Node-RED close callback once.
- **NR-07:** UG6x Input reads top-level `deviceName` and ISO `gatewayTime`.
- **NR-08:** Valid time becomes epoch milliseconds while raw payload remains available to the plugin.
- **NR-09:** Missing/invalid time uses `receivedTs` and produces the Engine-owned Device diagnostic.
- **NR-10:** Unknown/missing device produces Engine-owned Common diagnostics and no plugin parse.
- **NR-11:** Input while not ready follows the configured queue/reject policy.
- **NR-12:** Expected rejection is diagnostic state; unexpected adapter failure calls `done(error)`.
- **NR-13:** Receiver filters exact and wildcard event patterns through one output.
- **NR-14:** Receiver output contains only serializable event envelopes and no state/live instances.
- **NR-15:** Multiple Receivers subscribe independently without sharing delivery buffers.
- **NR-16:** Receiver replays current `engine.lifecycle` immediately after subscription.
- **NR-17:** Receiver close removes listeners and pending timers.
- **NR-18:** Lifecycle and raised/cleared/materially-updated diagnostics are delivered immediately and in order.
- **NR-19:** Coalescing retains the latest eligible event per event type/source key.
- **NR-20:** Trailing delay begins near 100 ms and continuous traffic flushes by 500 ms.
- **NR-21:** Coalescing one source never suppresses another source or a noncoalescible event.
- **NR-22:** Snapshot node preserves `_msgid`, event, and unrelated input properties.
- **NR-23:** Configured request works without a preceding Function node.
- **NR-24:** Valid dynamic `msg.snapshotRequest` overrides configured defaults.
- **NR-25:** Entity/family/all targets attach results to `msg.snapshot`.
- **NR-26:** Non-strict missing paths appear in `missingPaths`; strict mode calls `done(error)` with no output.
- **NR-27:** Missing entity or malformed request calls `done(error)` without Engine mutation.
- **NR-28:** `engine.ready` can trigger a whole-Engine initialization snapshot.

## End-to-end and packaging

- **E2E-01:** Cold start flows from false readiness to ready and initializes consumers with a whole snapshot.
- **E2E-02:** Valid UG6x payload reaches plugin, Datastream, Device, Application, Asset, events, and snapshots.
- **E2E-03:** Hardware, stale, calculation, and execution faults raise and clear through the registry.
- **E2E-04:** Restart restores condition/entity state but creates a new session and discards session diagnostics/readiness.
- **E2E-05:** Clock-jump reset closes the gate, replaces state, and reinitializes consumers.
- **PACK-01:** Every packed package contains only its intended compiled JavaScript, declarations, source maps, schemas, Node-RED assets, and required metadata.
- **PACK-02:** A clean npm 6.14.9 installation resolves the selected packed profile and runtime dependencies without workspace support.
- **PACK-03:** Node-RED 3.0.2 starts with the packed artifacts and discovers exactly the four documented node types.
- **PACK-04:** The installed artifacts pass the end-to-end smoke flow on Node.js 18 without source compilation.