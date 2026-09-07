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
- **CFG-03:** Valid configuration receives plugin, type, and concrete-entity settings without mutating raw input. Application-type defaults supply omitted Application intervals and provision mapped Datastreams; Device-type defaults provision declared Datastreams; application datafeed defaults override Device-type settings, shared application defaults aggregate by maximum buffer length/age and minimum expected interval, then explicit Device values override and final Datastream validation runs.
- **CFG-04:** Missing required settings produce JSON-path errors.
- **CFG-05:** Invalid intervals and buffer limits are rejected while nonempty descriptive entity names, including spaces and separators, are accepted.
- **CFG-06:** Missing required datafeeds and unresolved structured `{ device, datastream }` mappings fail startup.
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
- **DS-05:** Valid input updates timestamps, due time, buffer, persistence dirty state, and `entity.updated`; restored due times are recalculated from the active interval and restored last-update time.
- **DS-06:** Invalid/sentinel input sets `hwError` and its diagnostic without inserting a numeric sample.
- **DS-07:** An empty buffer becomes stale no earlier than its configurable startup grace period (default two expected intervals); an already-restored no-data condition remains active during that grace period.
- **DS-08:** Fresh data clears `noDataError` and its diagnostic.
- **DS-09:** Stale evaluation runs without incoming data or an Application request.

## Device, Application, and Asset

- **DEV-01:** Device defaults are `hwError=false`, `chldError=false`, `hasError=false`, and a default timestamp.
- **DEV-02:** Device `chldError` includes every child Datastream `hasError`; `hasError` also includes own `hwError`.
- **DEV-03:** Clearing the final source error clears Device `chldError` and `hasError` after recomputation.
- **DEV-04:** Invalid payload diagnostics reconcile on the next successful parse.
- **ASSET-01:** Empty Asset state is `currState=Undefined`, `chldError=false`, and `hasError=false`.
- **ASSET-02:** Asset `currState` is the maximum direct Application `currState`.
- **ASSET-03:** Asset `chldError` and `hasError` are true iff a child Application `hasError` is true.
- **APP-01:** A not-yet-due Application does not execute or mutate run timestamps.
- **APP-02:** Every run first resets common state to `0/false/false`, refreshes required Datastream stale state, and exposes full immutable datafeed state, `sessionStartTs`, and the prior no-data condition to the evaluator.
- **APP-03:** Successful execution atomically commits common and plugin-specific state.
- **APP-04:** A thrown plugin leaves common state `currState=0`, `noDataError=false`, `appError=true`.
- **APP-05:** A thrown plugin does not partially commit plugin state or clear plugin-owned diagnostics.
- **APP-06:** A later successful run clears the runner exception diagnostic and replaces calculation state.
- **AGG-01:** A burst of child changes creates one pending parent timer.
- **AGG-02:** Parent recomputation reads the latest states and emits at most one update for that pass.
- **AGG-03:** A child change during recomputation schedules exactly one trailing pass.
- **AGG-04:** Startup/reset recomputation is synchronous; shutdown flushes and removes timers.

## Engine and snapshots

- **ENG-01:** Engine constructs all entities in dependency order with safe deterministic IDs derived from configured name paths and exposes names in entity metadata.
- **ENG-02:** Duplicate entity IDs or unresolved mappings fail atomically.
- **ENG-03:** Two Engine instances have isolated registries, buses, state, and timers.
- **ENG-04:** Public registries/views cannot mutate live Engine objects.
- **SNAP-01:** Entity snapshot is a deep serializable copy with identity, type, relationships, and state.
- **SNAP-02:** Parent, children, and family requests return only the documented related entities.
- **SNAP-03:** Whole-Engine snapshot includes every entity and active diagnostic category, indexed by lowercase category/type and runtime/source ID.
- **SNAP-04:** Projection returns requested dotted paths.
- **SNAP-05:** Non-strict projection omits absent paths and reports entity/path pairs in `missingPaths`.
- **SNAP-06:** Strict projection fails atomically when any path is absent.
- **SNAP-07:** `entities` and `diagnostics` support optional type and ID filters; an ID requires a type, and diagnostics rejects entity-view options.

## Persistence and lifecycle

- **STATE-02:** Valid versioned entity state and condition diagnostics survive restart.
- **STATE-03:** Empty/deleted storage performs a supported cold start from defaults.
- **STATE-04:** Obsolete entity state and condition diagnostics for removed entities are removed only after successful configuration construction.
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
- **SCHED-05:** An overdue Application runs once and sets next due from the current run time; restored scheduling uses the current configured interval rather than a persisted next-due timestamp.
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
- **PLUG-DEV-03:** Consecutive values outside `[-100, 400]` raise hardware fault and `SENSOR_BROKEN` without insertion only at the configured `numFaultyValues` threshold (default three).
- **PLUG-DEV-04:** A later valid value resets the faulty-value count and clears that scoped condition.
- **PLUG-DEV-05:** Malformed/wrong-sensor payload reports invalid input without partial updates.
- **PLUG-APP-01:** Application manifest exposes required feeds/settings and stable defaults.
- **PLUG-APP-02:** Missing averages remain Undefined until `windowSizeMs` has elapsed from the session start, then set `noDataError` and `NO_DATA`.
- **PLUG-APP-03:** `tempOutAvg - tempInAvg` above margin sets `appError` and its diagnostic.
- **PLUG-APP-04:** Input below off threshold sets `operState=Off` and leaves process state Undefined.
- **PLUG-APP-05:** On-state with excessive temperature difference sets Warning and reports `FAILED_CLOSED` on the parent Asset through the scoped parent reporter.
- **PLUG-APP-06:** Healthy on-state sets Ok and clears prior condition diagnostics automatically.
- **PLUG-APP-07:** Average values and timestamps use the configured inclusive window.
- **PLUG-APP-08:** Plugin uses scoped reporting and has no null-filled diagnostic payload.
- **PROFILE-01:** Example profile registers only the selected Device/Application plugins.
- **PROFILE-02:** Example configuration validates and constructs its full graph.
- **PROFILE-03:** Referencing an unregistered type fails before ready.

## Node-RED adapters

- **NR-01:** Node-RED 3.0.2 discovers all four node types from package metadata.
- **NR-02:** Engine config node creates one Engine using its immutable Node-RED config ID as the persistence identity and exposes it to referencing nodes.
- **NR-03:** Invalid configuration reports status/error and never becomes ready.
- **NR-04:** `ieps` context adapter reads/writes the selected named store.
- **NR-05:** A blank or unavailable configured context store falls back to Node-RED's default store, emits a node warning, shows a yellow ready status, and still initializes the Engine.
- **NR-06:** Config-node close awaits Engine shutdown and calls the Node-RED close callback once; config-node removal then deletes only that Engine's persisted namespace.
- **NR-07:** Engine Input validates the `msg.payload` `{ deviceName, rawPayload, timestamp }` contract and forwards a transport-neutral ingestion envelope.
- **NR-08:** Missing or invalid payload fields become envelope issues; the Engine rejects them before Device parsing and raises an Engine-owned Common diagnostic observable through Engine Message Receiver.
- **NR-09:** Engine Input has zero outputs and never relays an input message; its status reports accepted or rejected ingestion.
- **NR-10:** Input while not ready follows the configured queue/reject policy.
- **NR-11:** Expected Engine rejection is diagnostic state; unexpected adapter failure calls `done(error)`.
- **NR-12:** The Engine derives parser receipt time from its injected clock while using the validated envelope timestamp as the Datastream sample time.
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
- **NR-29:** Every published Node-RED node provides built-in editor help, and the Insight Engine editor starts with full, partial, and default-driven configuration examples.
- **NR-30:** Dynamic Snapshot requests support diagnostic filtering and reject an ID filter without a type/category.

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
- **PACK-05:** One Palette-uploadable Node-RED archive contains the selected private packages, installs without separate project artifacts, and exposes the built-in Device/Application registry.
