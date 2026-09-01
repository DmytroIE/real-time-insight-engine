# Repository Instructions

These instructions apply to all work in this repository.

## Read first

Before editing implementation files, read:

1. `ARCHITECTURE.md`
2. `IMPLEMENTATION_PLAN.md`
3. the relevant test IDs in `ACCEPTANCE_TESTS.md`

Treat `ARCHITECTURE.md` as authoritative. `old_code/` is only a behavioral oracle. Never modify it, never import it from production code, and ignore `old_code/temp/` completely.

## Step protocol

- Work from the first unchecked numbered step in `IMPLEMENTATION_PLAN.md`, unless the user names another step.
- Complete one step at a time. Do not combine later architectural work into the current step.
- Before editing, identify the owning code path and the cheapest test that can disprove the intended behavior.
- After the first substantive edit, run that focused test before making adjacent changes.
- Mark a step `[x]` only when all listed completion checks pass.
- Add one short Progress Log row with the date, step, validation commands, and result.
- If blocked, leave the step unchecked and record the concrete blocker. Do not guess around missing contracts.
- Do not commit, tag, publish, or deploy unless the user explicitly requests it.

## Engineering constraints

- Use TypeScript strict mode and compiled JavaScript for production.
- Support Node.js 18, Node-RED 3.0.2, and npm 6.14.9 installation of packed production artifacts.
- Keep the core independent of Node-RED.
- Keep registries, event bus, timers, state, and lifecycle owned by one `Engine`; do not add process-global mutable registries.
- Use explicit plugin registration and stable type IDs. Do not scan the filesystem, use `eval`, or use `new Function`.
- Persist only versioned plain data through `StateStore`; never persist class instances, functions, timers, or the readiness bit.
- Use injected clocks/timers in domain tests. Do not use real sleeps.
- Keep Node-RED messages serializable and free of live domain instances.
- Keep consumer-specific protocol and dashboard mappings outside this package.
- Avoid native runtime dependencies unless the architecture is explicitly amended.
- Preserve public contracts already implemented by earlier completed steps.

## Required invariants

- Every configured Datastream has an independent stale-data schedule.
- Application and Datastream schedulers cannot stop each other after one task fails.
- Parent propagation is Datastream to Device and Application to Asset, with bounded trailing-edge coalescing.
- Before every Application evaluation, common state resets to `currState = 0`, `noDataError = false`, and `appError = false`.
- An Application exception finishes with `currState = 0`, `noDataError = false`, and `appError = true`.
- Plugins report diagnostic conditions through a scoped reporter and never build null-filled clear payloads.
- The Engine owns diagnostic reconciliation and persistence. Receivers only filter and shape delivery.
- Lifecycle and diagnostic transitions are never dropped by Receiver coalescing.
- Readiness is an Engine-owned level state. Missing readiness means false, and readiness is never restored from persistent storage.
- A large wall-clock jump performs the documented Engine cold reset.

## Validation

Use the narrowest relevant test first. Once the root scripts exist, finish every implementation step with the applicable subset of:

```text
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
```

Run `npm run verify` at phase boundaries and before declaring the implementation complete. Do not fix unrelated failures; record them separately.