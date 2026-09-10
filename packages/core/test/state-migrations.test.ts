import { describe, expect, it } from 'vitest';

import {
  ENGINE_SNAPSHOT_SCHEMA_VERSION,
  Engine,
  EntityKind,
  InMemoryStateStore,
  PERSISTED_STATE_RECOVERY_DIAGNOSTIC,
  PluginRegistry,
  ProcessState,
  asApplicationId,
  asEngineId,
  asPluginTypeId,
  engineCorruptSnapshotKey,
  engineSnapshotKey,
  type ApplicationPlugin,
  type DevicePlugin,
  type EngineConfiguration,
  type PersistedEngineSnapshot,
  type StateStore,
} from '../src';
import { FakeClock } from './support/fake-clock';
import { FakeTimerScheduler } from './support/fake-timer-scheduler';

interface CalculationState {
  runs: number;
  migrated?: boolean;
}

const settingsSchema = { type: 'object', additionalProperties: false } as const;

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

const createPlugins = (version = 1, includeMigrations = true): PluginRegistry => {
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
    version,
    displayName: 'Test Application',
    requiredDatafeeds: ['temperature'],
    settingsSchema,
    defaultSettings: {},
    defaultState: { runs: 0 },
    stateMigrations:
      version === 2 && includeMigrations
        ? { 1: (state) => ({ ...(state as { runs: number }), migrated: true }) }
        : {},
    create: () => ({
      evaluate: () => ({ state: { runs: 1 }, currState: ProcessState.Ok }),
    }),
  };
  const plugins = new PluginRegistry();
  plugins.register(device);
  plugins.register(application);
  return plugins;
};

const dependencies = (store: StateStore, plugins = createPlugins()) => ({
  clock: new FakeClock(1_000, 0),
  timers: new FakeTimerScheduler(),
  plugins,
  stateStore: store,
});

const persistedSnapshot = (): PersistedEngineSnapshot => ({
  schemaVersion: ENGINE_SNAPSHOT_SCHEMA_VERSION,
  entityStates: {
    devices: { 'device-1': { lastUpdateTimestamp: 0, hwError: false } },
    datastreams: {
      'device-1/temperature': {
        lastUpdateTimestamp: 0,
        nextUpdateTimestamp: 1_150,
        noDataError: false,
        hwError: false,
        samples: [],
      },
    },
    assets: {
      'asset-1': { lastUpdateTimestamp: 0, currState: ProcessState.Undefined },
    },
    applications: {
      'asset-1/application-1': {
        lastRunTimestamp: 900,
        lastUpdateTimestamp: 900,
        nextRunTimestamp: 1_100,
        currState: ProcessState.Ok,
        noDataError: false,
        appError: false,
        pluginState: { runs: 4 },
      },
    },
  },
  diagnostics: [],
  pluginVersions: { applications: { 'asset-1/application-1': 1 } },
});

describe('STATE-06 deterministic migrations', () => {
  it('applies a supported schema migration', async () => {
    const store = new InMemoryStateStore();
    const current = persistedSnapshot();
    await store.save(engineSnapshotKey(asEngineId('engine-1')), {
      schemaVersion: 0,
      payload: current,
    });

    const engine = await Engine.create(configuration(), {
      ...dependencies(store),
      snapshotMigrations: [
        {
          fromVersion: 0,
          toVersion: 1,
          migrate: (snapshot) => (snapshot as { payload: PersistedEngineSnapshot }).payload,
        },
      ],
    });

    expect(
      engine.snapshot({
        entities: [{ type: EntityKind.Application, ids: 'asset-1/application-1' }],
      }).entities.application['asset-1/application-1']?.state,
    ).toMatchObject({ pluginState: { runs: 4 } });
  });

  it('applies plugin state migrations from the persisted version', async () => {
    const store = new InMemoryStateStore();
    await store.save(engineSnapshotKey(asEngineId('engine-1')), persistedSnapshot());

    const engine = await Engine.create(configuration(), dependencies(store, createPlugins(2)));

    expect(
      engine.snapshot({
        entities: [{ type: EntityKind.Application, ids: 'asset-1/application-1' }],
      }).entities.application['asset-1/application-1']?.state,
    ).toMatchObject({ pluginState: { runs: 4, migrated: true } });
    await expect(
      store.load<PersistedEngineSnapshot>(engineSnapshotKey(asEngineId('engine-1'))),
    ).resolves.toMatchObject({
      pluginVersions: { applications: { 'asset-1/application-1': 2 } },
    });
  });
});

describe('STATE-07 corrupt-state recovery', () => {
  it('preserves malformed input, initializes defaults, and raises a diagnostic', async () => {
    const store = new InMemoryStateStore();
    const malformed = { schemaVersion: 1, entityStates: 'invalid' };
    await store.save(engineSnapshotKey(asEngineId('engine-1')), malformed);

    const engine = await Engine.create(configuration(), dependencies(store));
    const snapshot = engine.snapshot({
      entities: [
        { type: EntityKind.Device, ids: '*' },
        { type: EntityKind.Datastream, ids: '*' },
        { type: EntityKind.Application, ids: '*' },
        { type: EntityKind.Asset, ids: '*' },
      ],
      diagnostics: [{ type: 'common', ids: '*' }],
    });

    expect(Object.values(snapshot.entities).flatMap((group) => Object.values(group))).toHaveLength(
      4,
    );
    expect(snapshot.diagnostics.common['engine-1']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: PERSISTED_STATE_RECOVERY_DIAGNOSTIC }),
      ]),
    );
    await expect(store.load(engineCorruptSnapshotKey(asEngineId('engine-1')))).resolves.toEqual(
      malformed,
    );
  });

  it('falls back when a required plugin migration is unavailable', async () => {
    const store = new InMemoryStateStore();
    await store.save(engineSnapshotKey(asEngineId('engine-1')), persistedSnapshot());

    const engine = await Engine.create(
      configuration(),
      dependencies(store, createPlugins(2, false)),
    );

    expect(
      engine.snapshot({
        entities: [{ type: EntityKind.Application, ids: 'asset-1/application-1' }],
      }).entities.application['asset-1/application-1']?.state,
    ).toMatchObject({ pluginState: { runs: 0 } });
  });
});

class FailingStateStore implements StateStore {
  public failLoads = false;
  public failSaves = false;

  public constructor(public readonly inner = new InMemoryStateStore()) {}

  public load<Value>(key: string): Promise<Value | undefined> {
    return this.failLoads ? Promise.reject(new Error('load failed')) : this.inner.load<Value>(key);
  }

  public save<Value>(key: string, value: Value): Promise<void> {
    return this.failSaves ? Promise.reject(new Error('save failed')) : this.inner.save(key, value);
  }

  public delete(key: string): Promise<void> {
    return this.inner.delete(key);
  }

  public keys(prefix: string): Promise<string[]> {
    return this.inner.keys(prefix);
  }
}

describe('STATE-08 storage failures', () => {
  it('surfaces load failures instead of silently starting from defaults', async () => {
    const store = new FailingStateStore();
    store.failLoads = true;

    await expect(Engine.create(configuration(), dependencies(store))).rejects.toThrow(
      'load failed',
    );
  });

  it('surfaces save failures and keeps changed memory dirty', async () => {
    const store = new FailingStateStore();
    const engine = await Engine.create(configuration(), dependencies(store));
    const key = engineSnapshotKey(asEngineId('engine-1'));
    const before = await store.load(key);
    await engine.runApplication(asApplicationId('asset-1/application-1'));
    store.failSaves = true;

    await expect(engine.save()).rejects.toThrow('save failed');

    expect(engine.dirty).toBe(true);
    await expect(store.inner.load(key)).resolves.toEqual(before);
  });
});
