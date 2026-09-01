import { describe, expect, it } from 'vitest';

import {
  Engine,
  InMemoryStateStore,
  PluginRegistry,
  ProcessState,
  asApplicationId,
  asDeviceId,
  asEngineId,
  asPluginTypeId,
  engineSnapshotKey,
  type ApplicationPlugin,
  type ApplicationResult,
  type DevicePlugin,
  type EngineConfiguration,
  type PersistedEngineSnapshot,
  type StateStore,
} from '../src';
import { FakeClock } from './support/fake-clock';
import { FakeTimerScheduler } from './support/fake-timer-scheduler';

interface CalculationState {
  runs: number;
}

const settingsSchema = { type: 'object', additionalProperties: false } as const;

const configuration = (): EngineConfiguration => ({
  engineId: asEngineId('engine-1'),
  devices: {
    'device-1': {
      type: asPluginTypeId('sxs.test-device'),
      datastreams: {
        temperature: {
          maxBufferLength: 2,
          maxBufferAgeMs: 1_000,
          expectedIntervalMs: 100,
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

const createPlugins = (
  evaluate: () =>
    ApplicationResult<CalculationState> | Promise<ApplicationResult<CalculationState>> = () => ({
    state: { runs: 1 },
    currState: ProcessState.Ok,
  }),
): PluginRegistry => {
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
  const application: ApplicationPlugin<unknown, CalculationState> = {
    kind: 'application',
    type: asPluginTypeId('sxs.test-application'),
    version: 1,
    displayName: 'Test Application',
    requiredDatafeeds: ['temperature'],
    settingsSchema,
    defaultSettings: {},
    defaultState: { runs: 0 },
    create: () => ({ evaluate }),
  };
  const plugins = new PluginRegistry();
  plugins.register(device);
  plugins.register(application);
  return plugins;
};

class BlockingSaveStore implements StateStore {
  public blockSaves = false;
  public releaseSave: (() => void) | undefined;
  public readonly saveStarted: Promise<void>;
  readonly #signalSaveStarted: () => void;

  public constructor(public readonly inner = new InMemoryStateStore()) {
    let signalSaveStarted!: () => void;
    this.saveStarted = new Promise<void>((resolve) => {
      signalSaveStarted = resolve;
    });
    this.#signalSaveStarted = signalSaveStarted;
  }

  public load<Value>(key: string): Promise<Value | undefined> {
    return this.inner.load<Value>(key);
  }

  public async save<Value>(key: string, value: Value): Promise<void> {
    if (this.blockSaves) {
      this.#signalSaveStarted();
      await new Promise<void>((resolve) => {
        this.releaseSave = resolve;
      });
    }
    await this.inner.save(key, value);
  }

  public delete(key: string): Promise<void> {
    return this.inner.delete(key);
  }

  public keys(prefix: string): Promise<string[]> {
    return this.inner.keys(prefix);
  }
}

const createEngine = async (
  plugins = createPlugins(),
  store: StateStore = new InMemoryStateStore(),
) => {
  const timers = new FakeTimerScheduler();
  const engine = await Engine.create(configuration(), {
    clock: new FakeClock(1_000, 0),
    timers,
    plugins,
    stateStore: store,
  });
  return { engine, timers };
};

describe('LIFE-07 immediate shutdown gate', () => {
  it('closes readiness, cancels scheduler timers, and rejects new work before persistence finishes', async () => {
    const store = new BlockingSaveStore();
    const { engine, timers } = await createEngine(createPlugins(), store);
    store.blockSaves = true;

    const close = engine.close();

    expect(engine.lifecycleState).toBe('stopping');
    expect(engine.isReady).toBe(false);
    expect(timers.pendingCount).toBe(0);
    expect(() => engine.runApplication(asApplicationId('asset-1/application-1'))).toThrow(
      'Engine is not ready',
    );
    expect(() =>
      engine.ingest({
        deviceId: asDeviceId('device-1'),
        rawPayload: {},
        sourceTimestamp: 1_000,
        receivedTimestamp: 1_000,
      }),
    ).toThrow('Engine is not ready');
    await store.saveStarted;
    store.releaseSave?.();
    await close;
  });
});

describe('LIFE-08 coordinated drain and cleanup', () => {
  it('waits for active work, flushes parent state, persists, and removes timers and listeners', async () => {
    let resolveEvaluation: ((result: ApplicationResult<CalculationState>) => void) | undefined;
    const plugins = createPlugins(
      () =>
        new Promise((resolve) => {
          resolveEvaluation = resolve;
        }),
    );
    const store = new InMemoryStateStore();
    const { engine, timers } = await createEngine(plugins, store);
    const run = engine.runApplication(asApplicationId('asset-1/application-1'));

    const close = engine.close();
    let closed = false;
    void close.then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);

    resolveEvaluation?.({ state: { runs: 1 }, currState: ProcessState.Ok });
    await expect(run).resolves.toBe('completed');
    await close;

    expect(timers.pendingCount).toBe(0);
    expect(() => engine.subscribe('*', () => undefined)).toThrow('closed event bus');
    await expect(
      store.load<PersistedEngineSnapshot>(engineSnapshotKey(asEngineId('engine-1'))),
    ).resolves.toMatchObject({
      entityStates: {
        assets: { 'asset-1': { currState: ProcessState.Ok, error: false } },
        applications: {
          'asset-1/application-1': { pluginState: { runs: 1 }, currState: ProcessState.Ok },
        },
      },
    });
  });
});

describe('LIFE-09 repeated shutdown', () => {
  it('returns the same close operation before and after completion', async () => {
    const { engine } = await createEngine();

    const first = engine.close();
    const second = engine.close();

    expect(second).toBe(first);
    await first;
    expect(engine.close()).toBe(first);
  });
});
