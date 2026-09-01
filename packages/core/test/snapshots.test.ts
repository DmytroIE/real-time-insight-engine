import { describe, expect, it } from 'vitest';

import {
  Engine,
  EntityKind,
  PluginRegistry,
  ProcessState,
  SnapshotPathError,
  asApplicationId,
  asDeviceId,
  asEngineId,
  asPluginTypeId,
  type ApplicationPlugin,
  type DevicePlugin,
  type EngineConfiguration,
} from '../src';
import { FakeClock } from './support/fake-clock';
import { FakeTimerScheduler } from './support/fake-timer-scheduler';

interface CalculationState {
  nested: { runs: number };
}

const settingsSchema = { type: 'object', additionalProperties: false } as const;

const createEngine = (applicationFails = false): Engine => {
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
    defaultState: { nested: { runs: 0 } },
    create: () => ({
      evaluate: () => {
        if (applicationFails) {
          throw new Error('snapshot test failure');
        }
        return {
          state: { nested: { runs: 1 } },
          currState: ProcessState.Ok,
        };
      },
    }),
  };
  const plugins = new PluginRegistry();
  plugins.register(device);
  plugins.register(application);
  const configuration: EngineConfiguration = {
    engineId: asEngineId('engine-1'),
    devices: {
      'device-1': {
        type: device.type,
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
            type: application.type,
            runIntervalMs: 100,
            datafeeds: { temperature: 'device-1/temperature' },
          },
        ],
      },
    },
  };
  return new Engine(configuration, {
    clock: new FakeClock(1_000, 0),
    timers: new FakeTimerScheduler(),
    plugins,
  });
};

const applicationTarget = {
  scope: 'entity' as const,
  entityType: EntityKind.Application,
  entityId: 'asset-1/application-1',
};

describe('SNAP-01 immutable entity DTO', () => {
  it('contains identity, type, relationships, and a deep serializable state copy', () => {
    const engine = createEngine();
    const response = engine.snapshot({ target: applicationTarget });

    expect(response.entities).toEqual([
      {
        entityType: EntityKind.Application,
        entityId: 'asset-1/application-1',
        pluginType: 'sxs.test-application',
        relationships: {
          parent: { kind: EntityKind.Asset, id: 'asset-1' },
          children: [],
          datafeeds: {
            temperature: { kind: EntityKind.Datastream, id: 'device-1/temperature' },
          },
        },
        state: {
          lastRunTimestamp: 0,
          nextRunTimestamp: 100,
          currState: ProcessState.Undefined,
          noDataError: false,
          appError: false,
          pluginState: { nested: { runs: 0 } },
        },
      },
    ]);
    expect(JSON.parse(JSON.stringify(response))).toEqual(response);
    expect(() =>
      Object.assign(response.entities[0]?.state ?? {}, { currState: ProcessState.Error }),
    ).toThrow();
    expect(engine.snapshot({ target: applicationTarget }).entities[0]?.state).toMatchObject({
      currState: ProcessState.Undefined,
    });
  });
});

describe('SNAP-02 relationship scopes', () => {
  it('returns only the requested parent, children, or family', () => {
    const engine = createEngine();
    const parent = engine.snapshot({ target: applicationTarget, relations: 'parent' });
    const children = engine.snapshot({
      target: {
        scope: 'entity',
        entityType: EntityKind.Device,
        entityId: 'device-1',
      },
      relations: 'children',
    });
    const family = engine.snapshot({
      target: {
        scope: 'entity',
        entityType: EntityKind.Datastream,
        entityId: 'device-1/temperature',
      },
      relations: 'family',
    });
    const eventSource = engine.snapshot(
      { target: { scope: 'eventSource' } },
      {
        engineId: asEngineId('engine-1'),
        entityType: EntityKind.Device,
        entityId: asDeviceId('device-1'),
        pluginType: asPluginTypeId('sxs.test-device'),
      },
    );

    expect(parent.entities.map(({ entityType, entityId }) => [entityType, entityId])).toEqual([
      [EntityKind.Asset, 'asset-1'],
    ]);
    expect(children.entities.map(({ entityType, entityId }) => [entityType, entityId])).toEqual([
      [EntityKind.Datastream, 'device-1/temperature'],
    ]);
    expect(family.entities.map(({ entityType, entityId }) => [entityType, entityId])).toEqual([
      [EntityKind.Datastream, 'device-1/temperature'],
      [EntityKind.Device, 'device-1'],
    ]);
    expect(eventSource.entities.map(({ entityType, entityId }) => [entityType, entityId])).toEqual([
      [EntityKind.Device, 'device-1'],
    ]);
  });
});

describe('SNAP-03 whole-Engine snapshot', () => {
  it('includes every entity and every active diagnostic category', async () => {
    const engine = createEngine(true);
    await engine.runApplication(asApplicationId('asset-1/application-1'));

    const response = engine.snapshot({ target: { scope: 'all' } });

    expect(response.entities.map(({ entityType }) => entityType)).toEqual([
      EntityKind.Device,
      EntityKind.Datastream,
      EntityKind.Application,
      EntityKind.Asset,
    ]);
    expect(Object.keys(response.diagnostics ?? {})).toEqual([
      'Common',
      'Device',
      'Datastream',
      'Application',
      'Asset',
    ]);
    expect(response.diagnostics?.Application).toEqual([
      expect.objectContaining({ code: 'APPLICATION_EXECUTION_ERROR' }),
    ]);
  });
});

describe('SNAP-04 dotted state projection', () => {
  it('returns only requested nested paths', () => {
    const engine = createEngine();

    const response = engine.snapshot({
      target: applicationTarget,
      statePaths: ['currState', 'pluginState.nested.runs'],
    });

    expect(response.entities[0]?.state).toEqual({
      currState: ProcessState.Undefined,
      pluginState: { nested: { runs: 0 } },
    });
    expect(response.missingPaths).toEqual([]);
  });
});

describe('SNAP-05 non-strict missing paths', () => {
  it('omits missing values and reports entity/path pairs', () => {
    const engine = createEngine();

    const response = engine.snapshot({
      target: applicationTarget,
      statePaths: ['currState', 'pluginState.missing'],
    });

    expect(response.entities[0]?.state).toEqual({ currState: ProcessState.Undefined });
    expect(response.missingPaths).toEqual([
      {
        entity: { kind: EntityKind.Application, id: 'asset-1/application-1' },
        path: 'pluginState.missing',
      },
    ]);
  });
});

describe('SNAP-06 strict missing paths', () => {
  it('fails atomically when any requested path is absent', () => {
    const engine = createEngine();

    expect(() =>
      engine.snapshot({
        target: applicationTarget,
        statePaths: ['currState', 'pluginState.missing'],
        strictPaths: true,
      }),
    ).toThrow(SnapshotPathError);
    expect(engine.snapshot({ target: applicationTarget }).missingPaths).toEqual([]);
  });
});
