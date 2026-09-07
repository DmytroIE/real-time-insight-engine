# Real-Time Insight Engine

This repository contains a universal TypeScript real-time insight engine, independently installable domain plugins, and Node-RED adapters. The included Milesight UG65 profile demonstrates one deployment without coupling the engine to a particular application.

## Project status

The engine, Node-RED adapters, example device and application plugins, and UG65 deployment profile are implemented and covered by unit, integration, end-to-end, and packed-runtime tests. The JavaScript under `old_code/` remains test/reference material only and has never been deployed to production.

## Documentation map

- `ARCHITECTURE.md`: authoritative product and architecture decisions.
- `IMPLEMENTATION_PLAN.md`: ordered implementation checklist. Start here when writing code.
- `ACCEPTANCE_TESTS.md`: required behavioral and integration tests referenced by the plan.
- `AGENTS.md`: repository-wide instructions for coding agents.
- `old_code/`: behavioral oracle for selected calculations; exclude `old_code/temp/` entirely.

If documents conflict, use this precedence:

1. `ARCHITECTURE.md`
2. `ACCEPTANCE_TESTS.md`
3. `IMPLEMENTATION_PLAN.md`
4. `old_code/`, excluding `old_code/temp/`

## Target environment

- Production Node.js: 18
- Production Node-RED: 3.0.2
- Gateway npm: 6.14.9
- Development: TypeScript strict mode in an npm monorepo
- Production delivery: compiled, versioned npm packages; no TypeScript compilation on the gateway

## Development workflow

1. Read `AGENTS.md` and `ARCHITECTURE.md`.
2. Find the first unchecked step in `IMPLEMENTATION_PLAN.md`.
3. Implement only that step and its direct prerequisites.
4. Run the step's checks plus the relevant tests from `ACCEPTANCE_TESTS.md`.
5. Mark the step complete only after validation passes and record concise evidence in the plan's Progress Log.

In VS Code Chat, run the workspace prompt `/implement-next-step` to give an agent this workflow automatically. Add a step number after the prompt only when deliberately resuming a specific unchecked step.

Run the complete local verification suite with `npm run verify`.

## Operations

### Install

Build the single Palette artifact on an internet-connected development or CI machine:

```text
npm install
npm run verify
npm run pack:palette
```

This creates `artifacts/node-red-contrib-sxs-industrial-0.2.0.tgz`. In Node-RED, open **Manage palette**, select **Install**, choose **Upload module tgz**, and upload that file. The archive includes the core and selected Device/Application plugins as bundled npm dependencies, so no other project archives or `settings.js` plugin-registry hook are required. Restart Node-RED and confirm that these four node types are available:

- `insight-engine`
- `engine-input`
- `engine-message-receiver`
- `engine-state-snapshot`

The Palette still uses npm normally. Public dependencies can be resolved from the configured registry, while the current archive also carries its complete tested runtime dependency tree. Do not copy source files into `node_modules` or compile TypeScript on the gateway.

Each node includes short built-in help in the Node-RED Help sidebar. The Insight Engine configuration editor opens with a valid template that demonstrates full, partial, and default-driven Device/Application settings. Replace its names and values with the deployment configuration before use.

Before upgrading, back up `/etc/node_red/data/flows.json`, its package manifests and lockfile, and persistent Engine state. Retain the previously tested artifacts and checksums for rollback.

### Persistent state

Add a named `localfilesystem` context store to `/etc/node_red/settings.js`, merging it with any existing `contextStorage` configuration:

```js
contextStorage: {
	default: "memoryOnly",
	memoryOnly: { module: "memory" },
	ieps: {
		module: "localfilesystem",
		config: { flushInterval: 300 }
	}
}
```

Select `ieps` in the Engine node. Keep `flushInterval` between 60 and 300 seconds and restart Node-RED after changing it. A blank or unavailable Context store makes the node warn and use Node-RED's default context store instead; this allows startup but is commonly memory-only, so it does not provide restart recovery. An abrupt power loss can discard updates since the last flush; verify normal restart restoration, simulated power-loss behavior, and clean startup after deleting Engine state before production use.

Each Engine config node uses its immutable Node-RED node ID to namespace persistent state; its editable Name is only a label. Deleting the config node removes that Engine's namespace after shutdown. Configuration JSON uses descriptive names as object keys and structured datafeed references, so names may contain spaces or separators without becoming runtime IDs. A normal redeploy removes persisted condition diagnostics for entities no longer present in the validated configuration.

The optional top-level `applicationDefaults` configuration supplies per-Application-type `runIntervalMs`, partial plugin `settings`, and partial retention settings by required datafeed name. `deviceDefaults` supplies partial plugin `settings` and partial `datastreams` settings by Device plugin type. Resolved plugin settings merge plugin manifest defaults, type defaults, then concrete Device/Application settings. For each Datastream, Device-type defaults merge first, application datafeed defaults override them by field (shared application defaults use maximum buffer length/age and minimum expected interval), and explicit Device Datastream values override last. Device-type Datastream defaults also provision declared streams without an Application mapping. `gracePeriodCoefficient` is an optional positive Datastream setting that delays an empty-buffer `NO_DATA` alarm until at least `expectedIntervalMs * gracePeriodCoefficient` has elapsed in the current Engine session; its default is `2`. A restored active `NO_DATA` condition remains active during that grace period. The Engine validates the complete resulting settings after merging; see `packages/deployment-ug65-example/settings.example.json` for a deployment example.

### Engine input

Normalize source-specific Node-RED messages in a Function or Change node before `engine-input`. The node accepts only this payload contract and has no output:

```js
msg.payload = {
  deviceName: 'configured Device name',
  rawPayload: { sensorType: 12, temp1: 25.6, temp2: 45.3 },
  timestamp: 1787328000000,
};
return msg;
```

`timestamp` is the Unix epoch milliseconds at which the reading occurred. Invalid envelopes are rejected before Device parsing and emit an Engine-owned Common diagnostic; subscribe an Engine Message Receiver to `diagnostic.*` to observe them.

### Snapshots

`engine-state-snapshot` adds a serializable response to `msg.snapshot`. Use `{ "target": { "scope": "all" } }` for all entity state and active diagnostics. The `entities` target optionally filters by `entityType` and then `entityId`; the `diagnostics` target uses the same filters and also accepts `entityType: "common"`. An `entityId` requires its `entityType`.

Entity results are indexed as `msg.snapshot.entities.<type>[runtimeId]`, such as `entities.datastream["Device%201/temp1"]`. Diagnostic results are indexed as `msg.snapshot.diagnostics.<lowercase-category>[sourceId]`, such as `diagnostics.datastream["Device%201/temp1"]`. `relations`, `statePaths`, and `strictPaths` apply to entity views and are invalid for a `diagnostics` request.

### Monitoring

Monitor Engine lifecycle events, active diagnostics, process RSS/heap, event-loop delay, CPU, disk space, and context-store write behavior. Treat `failed` lifecycle state, repeated storage diagnostics, sustained event-loop delay, or memory growth under a representative flow as operational alerts. Receiver lifecycle and diagnostic events are never coalesced; use the replayed `engine.lifecycle` event with `msg.event.data.ready === true` to request a whole-Engine Snapshot and initialize consumers.

Run `npm run benchmark` after `npm run build` for a repeatable Engine/plugin baseline. Override the workload with `BENCH_ITERATIONS`. On Node 18.20.8 Linux x64 in a clean container, 5,000 ingests plus 500 Application runs measured:

- Engine startup: 3.45 ms
- Workload: 205.65 ms, 24,312.93 ingests/s
- CPU: 241.24 ms user, 26.65 ms system
- RSS: 52.89 MiB before, 72.26 MiB after
- Heap used: 7.46 MiB before, 20.17 MiB after
- Event-loop delay: 13.21 ms mean, 35.23 ms p99/max

This synthetic container result excludes Node-RED and gateway I/O. Record the same metrics on the target UG65 with representative flows, input rates, retention settings, and persistent context before deployment; establish limits from that hardware measurement.

### Rollback

Stop or disable incoming work, restore the prior `flows.json`, package manifests, lockfile, and compatible persistent-state backup, reinstall the prior tested artifacts, and restart Node-RED. Confirm lifecycle readiness, node discovery, state restoration, and one known input-to-snapshot flow before reopening ingestion. Do not restore state produced by a newer incompatible schema unless a documented reverse migration exists.

## Release review

- `npm run verify` covers 134 behavioral acceptance IDs with 163 tests. PACK-01 through PACK-05 include procedural checks for archive inspection, clean npm 6 installation, Node-RED 3.0.2 discovery, compiled Node 18 smoke execution, and the single Palette artifact.
- `npm audit --omit=dev` reports zero production vulnerabilities.
- The full development-tree audit reports 31 findings (6 low, 6 moderate, 15 high, 4 critical) under the exact Node-RED 3.0.2 compatibility dependency. The suggested forced remediation upgrades Node-RED to 3.1.15, so these findings are accepted for the pinned test/runtime target and must be reassessed before exposing the Node-RED editor or HTTP endpoints to untrusted networks.
- Installed dependency license declarations are permissive (MIT, ISC, Apache, BSD, and similar), except the five project packages are intentionally `UNLICENSED` and seven transitive packages omit a license field in their installed metadata. Complete legal/license review before external distribution.
- No package is published or deployed by repository scripts. Release requires explicit approval, version/checksum recording, target-gateway measurements, backup verification, and a tested rollback.
