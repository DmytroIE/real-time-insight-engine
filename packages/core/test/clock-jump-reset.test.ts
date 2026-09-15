import { describe, expect, it } from 'vitest';

import {
  Engine,
  EntityKind,
  InMemoryStateStore,
  PluginRegistry,
  ProcessState,
  asApplicationId,
  asDeviceId,
  asEngineId,
  asPluginTypeId,
  engineSnapshotKey,
  engineStateKeyPrefix,
  type ApplicationPlugin,
  type ApplicationEvaluationContext,
  type DevicePlugin,
  type EngineConfiguration,
  type EngineEvent,
  type StateStore,
} from '../src';
import { FakeClock } from './support/fake-clock';
import { FakeTimerScheduler } from './support/fake-timer-scheduler';

const settingsSchema = { type: 'object', additionalProperties: false } as const;

const createPlugins = (): PluginRegistry => {
  const device: DevicePlugin = {
    kind: 'device',
    type: asPluginTypeId('sxs.test-device'),
    version: 1,
    displayName: 'Test Device',
    datastreams: ['temperature'],
    settingsSchema,
    defaultSettings: {},
    create: () => ({ parse: () => ({ accepted: true }) }),
  };
  const application: ApplicationPlugin<unknown, { runs: number }> = {
    kind: 'application',
    type: asPluginTypeId('sxs.test-application'),
    version: 1,
    displayName: 'Test Application',
    requiredDatafeeds: ['temperature'],
    settingsSchema,
    defaultSettings: {},
    defaultState: { runs: 0 },
    create: () => ({
      evaluate: ({ pluginState }: ApplicationEvaluationContext<{ runs: number }>) => ({
        pluginState: { runs: pluginState.runs + 1 },
        currState: ProcessState.Ok,
        noDataError: false,
        appError: false,
      }),
    }),
  };
  const plugins = new PluginRegistry();
  plugins.register(device);
  plugins.register(application);
  return plugins;
};

const configuration = (): EngineConfiguration => ({
  engineId: asEngineId('engine-1'),
  clockJumpThresholdMs: 100,
  devices: {
    'device-1': {
      type: asPluginTypeId('sxs.test-device'),
      datastreams: {
        temperature: {
          maxBufferLength: 2,
          maxBufferAgeMs: 1_000,
          expectedIntervalMs: 1_000,
        },
      },
    },
  },
  assets: {
    'asset-1': {
      applications: [
        {
          id: 'application-1',
          type: asPluginTypeId('sxs.test-application'),
          runIntervalMs: 100,
          datafeeds: { temperature: 'device-1/temperature' },
        },
      ],
    },
  },
});

const setup = async (store: StateStore = new InMemoryStateStore()) => {
  const clock = new FakeClock(1_000, 0);
  const timers = new FakeTimerScheduler();
  const events: EngineEvent[] = [];
  const engine = await Engine.create(configuration(), {
    clock,
    timers,
    plugins: createPlugins(),
    stateStore: store,
    lifecycleListener: (event) => events.push(event),
  });
  return { clock, engine, events, timers };
};

describe('CLOCK-01 ordinary corrections', () => {
  it('does not reset when wall and monotonic elapsed time differ within the threshold', async () => {
    const { clock, engine } = await setup();
    const sessionId = engine.sessionId;
    clock.advanceWallBy(100);
    clock.advanceMonotonicBy(25);

    await expect(engine.checkClock()).resolves.toBe(false);

    expect(engine.isReady).toBe(true);
    expect(engine.sessionId).toBe(sessionId);
  });

  it('derives the default threshold from the largest Datastream buffer horizon', async () => {
    const config = configuration();
    const clock = new FakeClock(1_000, 0);
    const engine = await Engine.create(
      { engineId: config.engineId, devices: config.devices, assets: config.assets },
      {
        clock,
        timers: new FakeTimerScheduler(),
        plugins: createPlugins(),
        stateStore: new InMemoryStateStore(),
      },
    );
    clock.advanceWallBy(1_000);
    await expect(engine.checkClock()).resolves.toBe(false);
    clock.advanceWallBy(1_001);
    await expect(engine.checkClock()).resolves.toBe(true);
  });
});

class BlockingKeysStore implements StateStore {
  public blockKeys = false;
  public releaseKeys: (() => void) | undefined;

  public constructor(public readonly inner = new InMemoryStateStore()) {}

  public load<Value>(key: string): Promise<Value | undefined> {
    return this.inner.load<Value>(key);
  }

  public save<Value>(key: string, value: Value): Promise<void> {
    return this.inner.save(key, value);
  }

  public delete(key: string): Promise<void> {
    return this.inner.delete(key);
  }

  public async keys(prefix: string): Promise<string[]> {
    if (this.blockKeys) {
      await new Promise<void>((resolve) => {
        this.releaseKeys = resolve;
      });
    }
    return this.inner.keys(prefix);
  }
}

describe('CLOCK-02 readiness gating', () => {
  it('closes readiness and rejects work before reset storage operations complete', async () => {
    const store = new BlockingKeysStore();
    const { clock, engine } = await setup(store);
    store.blockKeys = true;
    clock.advanceWallBy(101);

    const reset = engine.checkClock();

    expect(engine.lifecycleState).toBe('resetting');
    expect(engine.isReady).toBe(false);
    expect(() =>
      engine.ingest({
        deviceId: asDeviceId('device-1'),
        rawPayload: {},
        timestamp: clock.wallTimeMs(),
      }),
    ).toThrow('Engine is not ready');
    store.releaseKeys?.();
    await expect(reset).resolves.toBe(true);
  });
});

describe('CLOCK-03 cold state rebuild', () => {
  it('deletes Engine-owned storage and rebuilds all entities from defaults', async () => {
    const store = new InMemoryStateStore();
    const { clock, engine } = await setup(store);
    clock.advanceBy(100);
    await engine.runApplication(asApplicationId('asset-1/application-1'));
    const obsoleteKey = `${engineStateKeyPrefix(asEngineId('engine-1'))}obsolete`;
    await store.save(obsoleteKey, { stale: true });
    clock.advanceWallBy(101);

    await engine.checkClock();

    const snapshot = engine.snapshot({
      entities: [
        { type: EntityKind.Application, ids: '*' },
        { type: EntityKind.Datastream, ids: '*' },
      ],
    });
    const application = snapshot.entities.application['asset-1/application-1'];
    const datastream = snapshot.entities.datastream['device-1/temperature'];
    expect(application?.state).toMatchObject({
      lastRunTimestamp: 1_201,
      currState: ProcessState.Undefined,
      pluginState: { runs: 0 },
    });
    expect(datastream?.state).toMatchObject({ samples: [], noDataError: false, hwError: false });
    await expect(store.load(obsoleteKey)).resolves.toBeUndefined();
    await expect(store.load(engineSnapshotKey(asEngineId('engine-1')))).resolves.toBeDefined();
  });
});

describe('CLOCK-04 successful reset lifecycle', () => {
  it('creates a new session, restarts schedulers, and reopens readiness', async () => {
    const { clock, engine, events, timers } = await setup();
    const previousSessionId = engine.sessionId;
    clock.advanceWallBy(101);

    await expect(engine.checkClock()).resolves.toBe(true);

    expect(engine.isReady).toBe(true);
    expect(engine.sessionId).not.toBe(previousSessionId);
    expect(timers.pendingCount).toBe(3);
    expect(events.slice(-3)).toMatchObject([
      { type: 'engine.lifecycle', data: { state: 'resetting', ready: false } },
      { type: 'engine.lifecycle', data: { state: 'ready', ready: true } },
      { type: 'engine.ready', data: { ready: true } },
    ]);
    expect(
      engine
        .snapshot({ diagnostics: [{ type: 'common', ids: '*' }] })
        .diagnostics.common['engine-1']?.map(({ code }) => code),
    ).toEqual(['SYSTEM_STARTED', 'CLOCK_JUMP_RESET']);
  });
});

class FailingResetSaveStore extends BlockingKeysStore {
  public failSaves = false;

  public override save<Value>(key: string, value: Value): Promise<void> {
    return this.failSaves ? Promise.reject(new Error('reset save failed')) : super.save(key, value);
  }
}

describe('CLOCK-05 reset persistence failure', () => {
  it('leaves the Engine failed, not ready, and unscheduled', async () => {
    const store = new FailingResetSaveStore();
    const { clock, engine, timers } = await setup(store);
    store.failSaves = true;
    clock.advanceWallBy(101);

    await expect(engine.checkClock()).rejects.toThrow('reset save failed');

    expect(engine.lifecycleState).toBe('failed');
    expect(engine.isReady).toBe(false);
    expect(timers.pendingCount).toBe(0);
  });
});
