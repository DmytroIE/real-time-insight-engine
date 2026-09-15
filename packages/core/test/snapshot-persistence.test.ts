import { describe, expect, it } from 'vitest';

import {
  ENGINE_SNAPSHOT_SCHEMA_VERSION,
  Engine,
  EntityKind,
  InMemoryStateStore,
  PluginRegistry,
  ProcessState,
  asApplicationId,
  assetIdForName,
  asDeviceId,
  asEngineId,
  asPluginTypeId,
  datastreamIdForNames,
  deviceIdForName,
  engineStateKeyPrefix,
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

const configuration = (deviceName = 'device-1', assetName = 'asset-1'): EngineConfiguration => ({
  engineId: asEngineId('engine-1'),
  devices: {
    [deviceName]: {
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
    [assetName]: {
      applications: [
        {
          id: 'application-1',
          type: asPluginTypeId('sxs.test-application'),
          runIntervalMs: 100,
          datafeeds: { temperature: datastreamIdForNames(deviceName, 'temperature') },
        },
      ],
    },
  },
});

const createPersistentEngine = (
  store: InMemoryStateStore,
  applicationFails = false,
  engineConfiguration = configuration(),
  clock = new FakeClock(1_000, 0),
): Promise<Engine> =>
  Engine.create(engineConfiguration, {
    clock,
    timers: new FakeTimerScheduler(),
    plugins: createPlugins(applicationFails),
    stateStore: store,
  });

describe('STATE-02 restart restoration', () => {
  it('restores versioned entity state and condition diagnostics', async () => {
    const store = new InMemoryStateStore();
    const clock = new FakeClock(1_000, 0);
    const first = await createPersistentEngine(store, true, configuration(), clock);
    clock.advanceBy(100);
    await first.runApplication(asApplicationId('asset-1/application-1'));
    await first.save();

    const restored = await createPersistentEngine(store);
    const snapshot = restored.snapshot({
      entities: [{ type: EntityKind.Application, ids: '*' }],
      diagnostics: [{ type: EntityKind.Application, ids: '*' }],
    });
    const application = snapshot.entities.application['asset-1/application-1'];

    expect(application?.state).toMatchObject({
      lastRunTimestamp: 1_100,
      nextRunTimestamp: 1_200,
      appError: true,
      pluginState: { runs: 0 },
    });
    expect(snapshot.diagnostics.application['asset-1/application-1']).toEqual([
      expect.objectContaining({ code: 'APPLICATION_EXECUTION_ERROR' }),
    ]);
  });

  it('restores Device and Asset state when names require encoded runtime IDs', async () => {
    const store = new InMemoryStateStore();
    const deviceName = 'Sensor / 3 South';
    const assetName = 'Steam Trap / 1';
    const engineConfiguration = configuration(deviceName, assetName);
    const deviceId = deviceIdForName(deviceName);
    const assetId = assetIdForName(assetName);
    await createPersistentEngine(store, false, engineConfiguration);

    const snapshotKey = engineSnapshotKey(engineConfiguration.engineId);
    const persisted = await store.load<PersistedEngineSnapshot>(snapshotKey);
    if (persisted === undefined) {
      throw new Error('Expected initial persisted Engine snapshot');
    }
    await store.save(snapshotKey, {
      ...persisted,
      entityStates: {
        ...persisted.entityStates,
        devices: {
          ...persisted.entityStates.devices,
          [deviceId]: { lastUpdateTimestamp: 123, hwError: false },
        },
        assets: {
          ...persisted.entityStates.assets,
          [assetId]: { lastUpdateTimestamp: 456, currState: ProcessState.Undefined },
        },
      },
    });

    const restored = await createPersistentEngine(store, false, engineConfiguration);
    const entities = restored.snapshot({
      entities: [
        { type: EntityKind.Device, ids: '*' },
        { type: EntityKind.Asset, ids: '*' },
      ],
    }).entities;
    expect(entities.device[deviceId]?.state).toMatchObject({
      lastUpdateTimestamp: 123,
    });
    expect(entities.asset[assetId]?.state).toMatchObject({ lastUpdateTimestamp: 456 });
  });
});

describe('STATE-03 empty storage cold start', () => {
  it('initializes and persists every entity from defaults', async () => {
    const store = new InMemoryStateStore();

    const engine = await createPersistentEngine(store);

    const entities = engine.snapshot({
      entities: [
        { type: EntityKind.Device, ids: '*' },
        { type: EntityKind.Datastream, ids: '*' },
        { type: EntityKind.Application, ids: '*' },
        { type: EntityKind.Asset, ids: '*' },
      ],
    }).entities;
    expect(Object.values(entities).flatMap((group) => Object.values(group))).toHaveLength(4);
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

  it('removes restored condition diagnostics for entities absent from the new configuration', async () => {
    const store = new InMemoryStateStore();
    const first = await createPersistentEngine(store, true);
    await first.runApplication(asApplicationId('asset-1/application-1'));
    await first.save();
    const redeployed: EngineConfiguration = {
      ...configuration(),
      assets: { 'asset-1': { applications: [] } },
    };

    const engine = await Engine.create(redeployed, {
      clock: new FakeClock(1_000, 0),
      timers: new FakeTimerScheduler(),
      plugins: createPlugins(),
      stateStore: store,
    });

    expect(
      engine.snapshot({ diagnostics: [{ type: EntityKind.Application, ids: '*' }] }).diagnostics
        .application,
    ).toEqual({});
    await expect(
      store.load<PersistedEngineSnapshot>(engineSnapshotKey(asEngineId('engine-1'))),
    ).resolves.toMatchObject({ diagnostics: [] });
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

  it('deletes only its own persistence namespace when removed', async () => {
    const store = new InMemoryStateStore();
    const engine = await createPersistentEngine(store);
    await store.save('engine/other-engine/snapshot', { retained: true });

    await engine.deletePersistedState();

    await expect(store.keys(engineStateKeyPrefix(asEngineId('engine-1')))).resolves.toEqual([]);
    await expect(store.load('engine/other-engine/snapshot')).resolves.toEqual({ retained: true });
  });
});
