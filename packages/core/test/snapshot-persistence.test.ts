import { describe, expect, it } from 'vitest';

import {
  ENGINE_SNAPSHOT_SCHEMA_VERSION,
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
  entityStateKey,
  type ApplicationPlugin,
  type DevicePlugin,
  type EngineConfiguration,
  type PersistedEngineSnapshot,
} from '../src';
import { FakeClock } from './support/fake-clock';
import { FakeTimerScheduler } from './support/fake-timer-scheduler';

interface CalculationState {
  runs: number;
}

const settingsSchema = { type: 'object', additionalProperties: false } as const;

const createPlugins = (applicationFails = false): PluginRegistry => {
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
    create: () => ({
      evaluate: () => {
        if (applicationFails) {
          throw new Error('persisted execution failure');
        }
        return { state: { runs: 1 }, currState: ProcessState.Ok };
      },
    }),
  };
  const plugins = new PluginRegistry();
  plugins.register(device);
  plugins.register(application);
  return plugins;
};

const configuration = (): EngineConfiguration => ({
  engineId: asEngineId('engine-1'),
  devices: {
    'device-1': {
      type: asPluginTypeId('sxs.test-device'),
      datastreams: {
        temperature: {
          maxBufferLength: 6,
          maxBufferAgeMs: 60_000,
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

const createPersistentEngine = (
  store: InMemoryStateStore,
  applicationFails = false,
): Promise<Engine> =>
  Engine.create(configuration(), {
    clock: new FakeClock(1_000, 0),
    timers: new FakeTimerScheduler(),
    plugins: createPlugins(applicationFails),
    stateStore: store,
  });

describe('STATE-02 restart restoration', () => {
  it('restores versioned entity state and condition diagnostics', async () => {
    const store = new InMemoryStateStore();
    const first = await createPersistentEngine(store, true);
    await first.runApplication(asApplicationId('asset-1/application-1'));
    await first.save();

    const restored = await createPersistentEngine(store);
    const snapshot = restored.snapshot({ target: { scope: 'all' } });
    const application = snapshot.entities.find(
      ({ entityType }) => entityType === EntityKind.Application,
    );

    expect(application?.state).toMatchObject({
      lastRunTimestamp: 1_000,
      nextRunTimestamp: 1_100,
      appError: true,
      pluginState: { runs: 0 },
    });
    expect(snapshot.diagnostics?.Application).toEqual([
      expect.objectContaining({ code: 'APPLICATION_EXECUTION_ERROR' }),
    ]);
  });
});

describe('STATE-03 empty storage cold start', () => {
  it('initializes and persists every entity from defaults', async () => {
    const store = new InMemoryStateStore();

    const engine = await createPersistentEngine(store);

    expect(engine.snapshot({ target: { scope: 'all' } }).entities).toHaveLength(4);
    await expect(
      store.load<PersistedEngineSnapshot>(engineSnapshotKey(asEngineId('engine-1'))),
    ).resolves.toMatchObject({
      schemaVersion: ENGINE_SNAPSHOT_SCHEMA_VERSION,
      entityStates: {
        devices: { 'device-1': expect.any(Object) },
        datastreams: { 'device-1/temperature': expect.any(Object) },
        assets: { 'asset-1': expect.any(Object) },
        applications: { 'asset-1/application-1': expect.any(Object) },
      },
    });
  });
});

describe('STATE-04 obsolete entity cleanup', () => {
  it('removes obsolete keys only after graph construction succeeds', async () => {
    const store = new InMemoryStateStore();
    const obsoleteKey = entityStateKey(
      asEngineId('engine-1'),
      EntityKind.Device,
      asDeviceId('removed-device'),
    );
    await store.save(obsoleteKey, { schemaVersion: 1, state: {} });
    const valid = configuration();
    const application = valid.assets['asset-1']?.applications[0];
    if (application === undefined) {
      throw new Error('Missing test Application');
    }
    const invalid: EngineConfiguration = {
      ...valid,
      assets: {
        'asset-1': {
          applications: [{ ...application, datafeeds: { temperature: 'device-1/missing' } }],
        },
      },
    };

    await expect(
      Engine.create(invalid, {
        clock: new FakeClock(1_000, 0),
        timers: new FakeTimerScheduler(),
        plugins: createPlugins(),
        stateStore: store,
      }),
    ).rejects.toThrow('references unknown Datastream');
    await expect(store.load(obsoleteKey)).resolves.toBeDefined();

    await createPersistentEngine(store);
    await expect(store.load(obsoleteKey)).resolves.toBeUndefined();
  });
});

describe('STATE-05 plain persisted data', () => {
  it('contains no functions, timers, class instances, or readiness flag', async () => {
    const store = new InMemoryStateStore();
    await createPersistentEngine(store);
    const persisted = await store.load<PersistedEngineSnapshot>(
      engineSnapshotKey(asEngineId('engine-1')),
    );

    expect(persisted).toBeDefined();
    expect(JSON.parse(JSON.stringify(persisted))).toEqual(persisted);
    expect(JSON.stringify(persisted)).not.toContain('isReady');
    expect(JSON.stringify(persisted)).not.toContain('readiness');
    expect(Object.getPrototypeOf(persisted)).toBe(Object.prototype);
  });
});
