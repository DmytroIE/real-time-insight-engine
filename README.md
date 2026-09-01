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

Build and pack artifacts on a development or CI machine. Install the selected versioned `.tgz` files from `/etc/node_red/data` with npm 6.14.9; do not copy source files into `node_modules` or compile TypeScript on the gateway. Restart Node-RED and confirm that these four node types are available:

- `industrial-engine`
- `ug6x-input`
- `engine-message-receiver`
- `engine-state-snapshot`

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

Select `ieps` in the Engine node. Keep `flushInterval` between 60 and 300 seconds and restart Node-RED after changing it. An abrupt power loss can discard updates since the last flush; verify normal restart restoration, simulated power-loss behavior, and clean startup after deleting Engine state before production use.

### Monitoring

Monitor Engine lifecycle events, active diagnostics, process RSS/heap, event-loop delay, CPU, disk space, and context-store write behavior. Treat `failed` lifecycle state, repeated storage diagnostics, sustained event-loop delay, or memory growth under a representative flow as operational alerts. Receiver lifecycle and diagnostic events are never coalesced; use a whole-Engine Snapshot after each `engine.ready` event to initialize consumers.

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

- `npm run verify` covers 133 behavioral acceptance IDs with 163 tests. PACK-01 through PACK-04 are procedural checks: archive inspection, clean npm 6 installation, Node-RED 3.0.2 discovery, and compiled Node 18 smoke execution.
- `npm audit --omit=dev` reports zero production vulnerabilities.
- The full development-tree audit reports 31 findings (6 low, 6 moderate, 15 high, 4 critical) under the exact Node-RED 3.0.2 compatibility dependency. The suggested forced remediation upgrades Node-RED to 3.1.15, so these findings are accepted for the pinned test/runtime target and must be reassessed before exposing the Node-RED editor or HTTP endpoints to untrusted networks.
- Installed dependency license declarations are permissive (MIT, ISC, Apache, BSD, and similar), except the five project packages are intentionally `UNLICENSED` and seven transitive packages omit a license field in their installed metadata. Complete legal/license review before external distribution.
- No package is published or deployed by repository scripts. Release requires explicit approval, version/checksum recording, target-gateway measurements, backup verification, and a tested rollback.