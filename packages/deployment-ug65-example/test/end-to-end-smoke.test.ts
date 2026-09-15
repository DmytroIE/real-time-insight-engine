import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  ConfigurationBuilder,
  DEFAULT_PARENT_RECOMPUTATION_DELAY_MS,
  Engine,
  EntityKind,
  InMemoryStateStore,
  PluginRegistry,
  ProcessState,
  asApplicationId,
  asEngineId,
  type ApplicationEvaluationContext,
  type ApplicationEvaluator,
  type ApplicationPlugin,
  type Clock,
  type EngineConfiguration,
  type EngineEvent,
  type StateStore,
  type TimerCallback,
  type TimerScheduler,
} from '@sxs/industrial-core';
import {
  twinTemperatureFailedClosedApplicationPlugin,
  type TwinTemperatureFailedClosedSettings,
  type TwinTemperatureFailedClosedState,
} from '@sxs/app-twin-temp-failed-closed';
import { enlessTwinTemperatureDevicePlugin } from '@sxs/device-enless-twin-temp';
import {
  createEngineMessageReceiver,
  createEngineStateSnapshotHandler,
  createEngineInputHandler,
  type IndustrialEngineNode,
} from 'node-red-contrib-sxs-industrial';
import type { Node, NodeMessage, NodeMessageInFlow } from 'node-red';

import { createUg65ExamplePluginRegistry } from '../src';

class TestClock implements Clock {
  public constructor(
    public wallMs = 1_000,
    public monotonicMs = 0,
  ) {}

  public wallTimeMs(): number {
    return this.wallMs;
  }

  public monotonicTimeMs(): number {
    return this.monotonicMs;
  }

  public advanceBy(durationMs: number): void {
    this.wallMs += durationMs;
    this.monotonicMs += durationMs;
  }
}

class SelectiveTimers implements TimerScheduler<number> {
  readonly #timers = new Map<
    number,
    { readonly callback: TimerCallback; readonly delayMs: number }
  >();
  #nextHandle = 1;

  public setTimeout(callback: TimerCallback, delayMs: number): number {
    const handle = this.#nextHandle++;
    this.#timers.set(handle, { callback, delayMs });
    return handle;
  }

  public clearTimeout(handle: number): void {
    this.#timers.delete(handle);
  }

  public runDelay(delayMs: number): void {
    const due = [...this.#timers].filter(([, timer]) => timer.delayMs === delayMs);
    for (const [handle, timer] of due) {
      this.#timers.delete(handle);
      timer.callback();
    }
  }
}

interface Harness {
  readonly clock: TestClock;
  readonly engine: Engine;
  readonly events: EngineEvent[];
  readonly timers: SelectiveTimers;
}

const loadConfiguration = (): EngineConfiguration => {
  const raw = JSON.parse(
    readFileSync(join(__dirname, '..', 'settings.example.json'), 'utf8'),
  ) as Record<string, unknown>;
  raw['clockJumpThresholdMs'] = 100;
  return new ConfigurationBuilder(createUg65ExamplePluginRegistry()).build(
    raw,
    asEngineId('ug65-example'),
  );
};

const createHarness = async (
  store: StateStore = new InMemoryStateStore(),
  clock = new TestClock(),
  executionFailure?: { enabled: boolean },
): Promise<Harness> => {
  let plugins = createUg65ExamplePluginRegistry();
  if (executionFailure !== undefined) {
    const controlledApplication: ApplicationPlugin<
      TwinTemperatureFailedClosedSettings,
      TwinTemperatureFailedClosedState,
      ApplicationEvaluator<TwinTemperatureFailedClosedState>
    > = {
      ...twinTemperatureFailedClosedApplicationPlugin,
      create: (context) => {
        const evaluator = twinTemperatureFailedClosedApplicationPlugin.create(context);
        return {
          evaluate: (
            evaluationContext: ApplicationEvaluationContext<TwinTemperatureFailedClosedState>,
          ) => {
            if (executionFailure.enabled) {
              throw new Error('controlled application failure');
            }
            return evaluator.evaluate(evaluationContext);
          },
        };
      },
    };
    const controlledPlugins = new PluginRegistry();
    controlledPlugins.register(enlessTwinTemperatureDevicePlugin);
    controlledPlugins.register(controlledApplication);
    plugins = controlledPlugins;
  }
  const timers = new SelectiveTimers();
  const events: EngineEvent[] = [];
  const engine = await Engine.create(loadConfiguration(), {
    clock,
    timers,
    plugins,
    stateStore: store,
    lifecycleListener: (event) => events.push(event),
  });
  return { clock, engine, events, timers };
};

const industrialNode = (engine: Engine): IndustrialEngineNode =>
  ({ engine, ready: Promise.resolve(engine) }) as IndustrialEngineNode;

const invokeInput = async (
  engine: Engine,
  clock: TestClock,
  object: Readonly<Record<string, unknown>>,
): Promise<{ readonly error?: Error }> => {
  const node = { status: vi.fn() } as unknown as Node;
  const message: NodeMessageInFlow = {
    _msgid: `input-${clock.wallMs}`,
    payload: {
      deviceName: 'enless-twin-temp-1',
      rawPayload: object,
      timestamp: clock.wallMs,
    },
  };
  const error = await new Promise<Error | undefined>((resolve) => {
    createEngineInputHandler(node, industrialNode(engine), 'reject')(
      message,
      () => undefined,
      resolve,
    );
  });
  return error === undefined ? {} : { error };
};

const invokeSnapshot = async (
  engine: Engine,
  message: NodeMessageInFlow,
): Promise<NodeMessageInFlow> => {
  const sent: NodeMessage[] = [];
  const error = await new Promise<Error | undefined>((resolve) => {
    createEngineStateSnapshotHandler(
      { status: vi.fn() } as unknown as Pick<Node, 'status'>,
      industrialNode(engine),
    )(
      {
        ...message,
        snapshotRequest: message['snapshotRequest'] ?? {
          entities: [
            { type: EntityKind.Device, ids: '*' },
            { type: EntityKind.Datastream, ids: '*' },
            { type: EntityKind.Application, ids: '*' },
            { type: EntityKind.Asset, ids: '*' },
          ],
          diagnostics: [
            { type: 'common', ids: '*' },
            { type: EntityKind.Device, ids: '*' },
            { type: EntityKind.Datastream, ids: '*' },
            { type: EntityKind.Application, ids: '*' },
            { type: EntityKind.Asset, ids: '*' },
          ],
        },
      },
      (output) => {
        if (!Array.isArray(output)) {
          sent.push(output);
        }
      },
      resolve,
    );
  });
  if (error !== undefined) {
    throw error;
  }
  return sent[0] as NodeMessageInFlow;
};

const applicationId = asApplicationId('steam-trap-1/failed-closed');
const allSnapshot = (engine: Engine) =>
  engine.snapshot({
    entities: [
      { type: EntityKind.Device, ids: '*' },
      { type: EntityKind.Datastream, ids: '*' },
      { type: EntityKind.Application, ids: '*' },
      { type: EntityKind.Asset, ids: '*' },
    ],
    diagnostics: [
      { type: 'common', ids: '*' },
      { type: EntityKind.Device, ids: '*' },
      { type: EntityKind.Datastream, ids: '*' },
      { type: EntityKind.Application, ids: '*' },
      { type: EntityKind.Asset, ids: '*' },
    ],
  });
const entity = (engine: Engine, entityType: EntityKind) =>
  Object.values(allSnapshot(engine).entities[entityType])[0];
const diagnostics = (
  engine: Engine,
  entityType: 'common' | 'device' | 'datastream' | 'application' | 'asset',
) => Object.values(allSnapshot(engine).diagnostics[entityType]).flat();

describe('UG65 end-to-end smoke flows', () => {
  it('E2E-01 cold startup closes then opens readiness and initializes consumers', async () => {
    const { engine, events } = await createHarness();
    const lifecycle = events.filter(
      (event) => event.type === 'engine.lifecycle' || event.type === 'engine.ready',
    );

    expect(lifecycle.map((event) => event.type)).toEqual([
      'engine.lifecycle',
      'engine.lifecycle',
      'engine.ready',
    ]);
    expect(lifecycle[0]).toMatchObject({ data: { state: 'starting', ready: false } });
    expect(lifecycle[1]).toMatchObject({ data: { state: 'ready', ready: true } });

    const initialized = await invokeSnapshot(engine, {
      _msgid: 'startup',
      topic: 'engine.ready',
      event: lifecycle[2],
    });
    expect(initialized['snapshot']).toMatchObject({ entities: expect.any(Object) });
    expect(
      Object.values((initialized['snapshot'] as ReturnType<typeof allSnapshot>).entities).flatMap(
        (group) => Object.values(group),
      ),
    ).toHaveLength(5);
    await engine.close();
  });

  it('E2E-02 valid Engine Input reaches every entity, events, and snapshots', async () => {
    const { clock, engine, timers } = await createHarness();
    const delivered: NodeMessage[] = [];
    const receiver = createEngineMessageReceiver(
      { send: (message) => delivered.push(message as NodeMessage) },
      engine,
      '*',
      {
        timers: {
          setTimeout: (callback) => {
            callback();
            return 0;
          },
          clearTimeout: () => undefined,
        },
      },
    );

    clock.advanceBy(600_000);
    const input = await invokeInput(engine, clock, { sensorType: 12, temp1: 100, temp2: 90 });
    expect(input.error).toBeUndefined();
    timers.runDelay(DEFAULT_PARENT_RECOMPUTATION_DELAY_MS);
    await engine.runApplication(applicationId);
    timers.runDelay(DEFAULT_PARENT_RECOMPUTATION_DELAY_MS);

    const snapshotMessage = await invokeSnapshot(engine, {
      _msgid: 'snapshot',
      event: delivered.find((message) => message.topic === 'entity.updated')?.event,
    });
    const snapshot = snapshotMessage['snapshot'] as ReturnType<typeof allSnapshot>;
    expect(Object.values(snapshot.entities).flatMap((group) => Object.values(group))).toHaveLength(
      5,
    );
    expect(entity(engine, EntityKind.Datastream)?.state).toMatchObject({
      samples: [{ timestamp: 601_000, value: 100 }],
    });
    expect(entity(engine, EntityKind.Device)?.state).toMatchObject({ hwError: false });
    expect(entity(engine, EntityKind.Application)?.state).toMatchObject({
      currState: ProcessState.Ok,
    });
    expect(entity(engine, EntityKind.Asset)?.state).toMatchObject({
      currState: ProcessState.Ok,
    });
    expect(delivered.some((message) => message.topic === 'entity.updated')).toBe(true);
    receiver.close();
    await engine.close();
  });

  it('E2E-03 hardware, stale, calculation, and execution faults raise and clear', async () => {
    const executionFailure = { enabled: false };
    const { clock, engine } = await createHarness(
      new InMemoryStateStore(),
      new TestClock(),
      executionFailure,
    );

    await invokeInput(engine, clock, { sensorType: 12, temp1: 401, temp2: 20 });
    await invokeInput(engine, clock, { sensorType: 12, temp1: 401, temp2: 20 });
    await invokeInput(engine, clock, { sensorType: 12, temp1: 401, temp2: 20 });
    expect(diagnostics(engine, 'datastream').map(({ code }) => code)).toContain('SENSOR_BROKEN');
    await invokeInput(engine, clock, { sensorType: 12, temp1: 100, temp2: 90 });
    expect(diagnostics(engine, 'datastream')).toEqual([]);

    clock.advanceBy(600_000);
    await invokeInput(engine, clock, { sensorType: 12, temp1: 80, temp2: 100 });
    await engine.runApplication(applicationId);
    expect(diagnostics(engine, 'application').map(({ code }) => code)).toContain(
      'TEMP_OUT_ABOVE_IN',
    );
    clock.advanceBy(1_800_001);
    await engine.runApplication(applicationId);
    expect(diagnostics(engine, 'datastream').map(({ code }) => code)).toContain('NO_DATA');
    expect(diagnostics(engine, 'application').map(({ code }) => code)).toContain('NO_DATA');

    clock.advanceBy(600_000);
    await invokeInput(engine, clock, { sensorType: 12, temp1: 100, temp2: 90 });
    await engine.runApplication(applicationId);
    expect(diagnostics(engine, 'datastream')).toEqual([]);
    expect(diagnostics(engine, 'application')).toEqual([]);

    executionFailure.enabled = true;
    clock.advanceBy(600_000);
    await engine.runApplication(applicationId);
    expect(diagnostics(engine, 'application').map(({ code }) => code)).toContain(
      'APPLICATION_EXECUTION_ERROR',
    );
    executionFailure.enabled = false;
    clock.advanceBy(600_000);
    await invokeInput(engine, clock, { sensorType: 12, temp1: 100, temp2: 90 });
    await engine.runApplication(applicationId);
    expect(diagnostics(engine, 'application')).toEqual([]);
    await engine.close();
  });

  it('E2E-04 restart restores condition/entity state but starts a fresh session', async () => {
    const store = new InMemoryStateStore();
    const firstClock = new TestClock(1_000, 0);
    const first = await createHarness(store, firstClock);
    await invokeInput(first.engine, firstClock, { sensorType: 12, temp1: 401, temp2: 20 });
    await invokeInput(first.engine, firstClock, { sensorType: 12, temp1: 401, temp2: 20 });
    await invokeInput(first.engine, firstClock, { sensorType: 12, temp1: 401, temp2: 20 });
    await first.engine.save();
    const previousSession = first.engine.sessionId;
    await first.engine.close();

    const restored = await createHarness(store, new TestClock(2_000, 0));
    expect(restored.engine.sessionId).not.toBe(previousSession);
    expect(restored.engine.isReady).toBe(true);
    expect(entity(restored.engine, EntityKind.Datastream)?.state).toMatchObject({ hwError: true });
    expect(diagnostics(restored.engine, 'datastream').map(({ code }) => code)).toContain(
      'SENSOR_BROKEN',
    );
    expect(diagnostics(restored.engine, 'common')).toEqual([
      expect.objectContaining({
        code: 'SYSTEM_STARTED',
        details: expect.objectContaining({ sessionId: restored.engine.sessionId }),
      }),
    ]);
    expect(restored.events[0]).toMatchObject({ data: { state: 'starting', ready: false } });
    await restored.engine.close();
  });

  it('E2E-05 clock-jump reset closes the gate, replaces state, and reinitializes', async () => {
    const { clock, engine, events } = await createHarness();
    await invokeInput(engine, clock, { sensorType: 12, temp1: 100, temp2: 90 });
    const previousSession = engine.sessionId;
    clock.wallMs += 101;

    const reset = engine.checkClock();
    expect(engine.isReady).toBe(false);
    expect(engine.lifecycleState).toBe('resetting');
    await expect(reset).resolves.toBe(true);

    expect(engine.isReady).toBe(true);
    expect(engine.sessionId).not.toBe(previousSession);
    expect(entity(engine, EntityKind.Datastream)?.state).toMatchObject({ samples: [] });
    expect(events.slice(-3)).toMatchObject([
      { type: 'engine.lifecycle', data: { state: 'resetting', ready: false } },
      { type: 'engine.lifecycle', data: { state: 'ready', ready: true } },
      { type: 'engine.ready', data: { ready: true } },
    ]);
    const initialized = await invokeSnapshot(engine, {
      _msgid: 'reset-ready',
      topic: 'engine.ready',
      event: events.at(-1),
    });
    expect(
      Object.values((initialized['snapshot'] as ReturnType<typeof allSnapshot>).entities).flatMap(
        (group) => Object.values(group),
      ),
    ).toHaveLength(5);
    await engine.close();
  });
});
