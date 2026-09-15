import { describe, expect, it } from 'vitest';

import {
  Engine,
  EntityKind,
  PluginRegistry,
  ProcessState,
  asApplicationId,
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

const createEngine = (applicationFails = false, clock = new FakeClock(1_000, 0)): Engine => {
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
        extra: { modbus: { registers: { childrenError: 205 } } },
        datastreams: {
          temperature: {
            maxBufferLength: 6,
            maxBufferAgeMs: 60_000,
            expectedIntervalMs: 100,
            extra: { opcua: { node: 'ns=2;s=Temperature' } },
          },
        },
      },
    },
    assets: {
      'asset-1': {
        extra: { cloud: { resource: 'trap-1' } },
        applications: [
          {
            id: 'application-1',
            type: application.type,
            runIntervalMs: 100,
            extra: { modbus: { registers: { currState: 27 } } },
            datafeeds: { temperature: 'device-1/temperature' },
          },
        ],
      },
    },
  };
  return new Engine(configuration, {
    clock,
    timers: new FakeTimerScheduler(),
    plugins,
  });
};

const applicationSelector = {
  type: EntityKind.Application,
  ids: 'asset-1/application-1',
};

const allEntitySelectors = [
  { type: EntityKind.Device, ids: '*' },
  { type: EntityKind.Datastream, ids: '*' },
  { type: EntityKind.Application, ids: '*' },
  { type: EntityKind.Asset, ids: '*' },
] as const;

const entitySnapshot = (response: ReturnType<Engine['snapshot']>, type: EntityKind, id: string) =>
  response.entities[type][id];

describe('SNAP-01 immutable entity DTO', () => {
  it('contains identity, type, relationships, and a deep serializable state copy', () => {
    const engine = createEngine();
    const response = engine.snapshot({ entities: [applicationSelector] });

    expect(entitySnapshot(response, EntityKind.Application, 'asset-1/application-1')).toEqual({
      entityType: EntityKind.Application,
      entityId: 'asset-1/application-1',
      entityName: 'application-1',
      pluginType: 'sxs.test-application',
      extra: { modbus: { registers: { currState: 27 } } },
      relationships: {
        parent: { kind: EntityKind.Asset, id: 'asset-1' },
        children: [],
        datafeeds: {
          temperature: { kind: EntityKind.Datastream, id: 'device-1/temperature' },
        },
      },
      state: {
        lastRunTimestamp: 1_000,
        lastUpdateTimestamp: 1_000,
        nextRunTimestamp: 1_100,
        currState: ProcessState.Undefined,
        noDataError: false,
        appError: false,
        pluginState: { nested: { runs: 0 } },
        hasError: false,
      },
    });
    expect(JSON.parse(JSON.stringify(response))).toEqual(response);
    expect(() =>
      Object.assign(
        entitySnapshot(response, EntityKind.Application, 'asset-1/application-1')?.state ?? {},
        { currState: ProcessState.Error },
      ),
    ).toThrow();
    expect(
      entitySnapshot(
        engine.snapshot({ entities: [applicationSelector] }),
        EntityKind.Application,
        'asset-1/application-1',
      )?.state,
    ).toMatchObject({
      currState: ProcessState.Undefined,
    });
  });

  it('returns immutable copied metadata for every entity type', () => {
    const engine = createEngine();
    const response = engine.snapshot({ entities: allEntitySelectors });

    expect(response.entities.device['device-1']?.extra).toEqual({
      modbus: { registers: { childrenError: 205 } },
    });
    expect(response.entities.datastream['device-1/temperature']?.extra).toEqual({
      opcua: { node: 'ns=2;s=Temperature' },
    });
    expect(response.entities.asset['asset-1']?.extra).toEqual({ cloud: { resource: 'trap-1' } });
    expect(response.entities.application['asset-1/application-1']?.extra).toEqual({
      modbus: { registers: { currState: 27 } },
    });
    expect(() => {
      (response.entities.device['device-1']?.extra as { modbus: object }).modbus = {};
    }).toThrow();
  });

  it('includes hasError for every entity and childrenError for parent entities', () => {
    const engine = createEngine();
    const response = engine.snapshot({ entities: allEntitySelectors });

    expect(response.entities.device['device-1']?.state).toMatchObject({
      childrenError: false,
      hasError: false,
    });
    expect(response.entities.datastream['device-1/temperature']?.state).toMatchObject({
      hasError: false,
    });
    expect(response.entities.application['asset-1/application-1']?.state).toMatchObject({
      hasError: false,
    });
    expect(response.entities.asset['asset-1']?.state).toMatchObject({
      childrenError: false,
      hasError: false,
    });
  });
});

describe('SNAP-02 selector relationship expansion', () => {
  it('includes requested parent, children, and datafeeds without failing at missing relationships', () => {
    const engine = createEngine();
    const parent = engine.snapshot({
      entities: [{ ...applicationSelector, parent: true, children: true }],
    });
    const children = engine.snapshot({
      entities: [{ type: EntityKind.Device, ids: 'device-1', children: true }],
    });
    const datafeeds = engine.snapshot({
      entities: [{ ...applicationSelector, datafeeds: true }],
    });

    expect(Object.keys(parent.entities[EntityKind.Application])).toEqual(['asset-1/application-1']);
    expect(Object.keys(parent.entities[EntityKind.Asset])).toEqual(['asset-1']);
    expect(Object.keys(children.entities[EntityKind.Datastream])).toEqual(['device-1/temperature']);
    expect(Object.keys(datafeeds.entities[EntityKind.Application])).toEqual([
      'asset-1/application-1',
    ]);
    expect(Object.keys(datafeeds.entities[EntityKind.Datastream])).toEqual([
      'device-1/temperature',
    ]);
  });
});

describe('SNAP-03 and SNAP-07 indexed whole-Engine and diagnostic snapshots', () => {
  it('indexes every entity and active diagnostic by lowercase type and source ID', async () => {
    const clock = new FakeClock(1_000, 0);
    const engine = createEngine(true, clock);
    clock.advanceBy(100);
    await engine.runApplication(asApplicationId('asset-1/application-1'));

    const response = engine.snapshot({
      entities: allEntitySelectors,
      diagnostics: [{ type: EntityKind.Application, ids: '*' }],
    });

    expect(Object.keys(response.entities)).toEqual([
      EntityKind.Device,
      EntityKind.Datastream,
      EntityKind.Application,
      EntityKind.Asset,
    ]);
    expect(response.entities[EntityKind.Application]['asset-1/application-1']).toBeDefined();
    expect(Object.keys(response.diagnostics)).toEqual([
      'common',
      'device',
      'datastream',
      'application',
      'asset',
    ]);
    expect(response.diagnostics.application['asset-1/application-1']).toEqual([
      expect.objectContaining({ code: 'APPLICATION_EXECUTION_ERROR' }),
    ]);
  });

  it('filters entities and diagnostics by optional type and source ID', async () => {
    const clock = new FakeClock(1_000, 0);
    const engine = createEngine(true, clock);
    clock.advanceBy(100);
    await engine.runApplication(asApplicationId('asset-1/application-1'));

    const allEntities = engine.snapshot({ entities: allEntitySelectors });
    const devices = engine.snapshot({
      entities: [{ type: EntityKind.Device, ids: '*' }],
    });
    const oneDevice = engine.snapshot({
      entities: [{ type: EntityKind.Device, ids: 'device-1' }],
    });
    const applicationDiagnostics = engine.snapshot({
      diagnostics: [
        { type: EntityKind.Application, ids: '*' },
        { type: EntityKind.Application, ids: 'asset-1/application-1' },
      ],
    });
    const oneApplicationDiagnostics = engine.snapshot({
      diagnostics: [{ type: EntityKind.Application, ids: 'asset-1/application-1' }],
    });

    expect(Object.keys(allEntities.entities[EntityKind.Device])).toEqual(['device-1']);
    expect(Object.keys(allEntities.entities[EntityKind.Application])).toEqual([
      'asset-1/application-1',
    ]);
    expect(Object.keys(devices.entities[EntityKind.Device])).toEqual(['device-1']);
    expect(Object.keys(devices.entities[EntityKind.Datastream])).toEqual([]);
    expect(Object.keys(oneDevice.entities[EntityKind.Device])).toEqual(['device-1']);
    expect(Object.keys(applicationDiagnostics.diagnostics.application)).toEqual([
      'asset-1/application-1',
    ]);
    expect(applicationDiagnostics.diagnostics.application['asset-1/application-1']).toHaveLength(1);
    expect(oneApplicationDiagnostics.diagnostics.application['asset-1/application-1']).toEqual([
      expect.objectContaining({ code: 'APPLICATION_EXECUTION_ERROR' }),
    ]);
  });
});

describe('SNAP-04 dotted state projection', () => {
  it('returns only requested nested paths', () => {
    const engine = createEngine();

    const response = engine.snapshot({
      entities: [
        {
          ...applicationSelector,
          statePaths: ['currState', 'pluginState.nested.runs'],
        },
      ],
    });

    expect(
      entitySnapshot(response, EntityKind.Application, 'asset-1/application-1')?.state,
    ).toEqual({
      currState: ProcessState.Undefined,
      pluginState: { nested: { runs: 0 } },
    });
  });
});

describe('SNAP-05 permissive missing paths', () => {
  it('omits missing values without failing the request', () => {
    const engine = createEngine();

    const response = engine.snapshot({
      entities: [{ ...applicationSelector, statePaths: ['currState', 'pluginState.missing'] }],
    });

    expect(
      entitySnapshot(response, EntityKind.Application, 'asset-1/application-1')?.state,
    ).toEqual({
      currState: ProcessState.Undefined,
    });
    expect(response).not.toHaveProperty('missingPaths');
  });
});

describe('SNAP-06 selector unioning', () => {
  it('deduplicates repeated entities and lets a complete state selection override projections', () => {
    const engine = createEngine();

    const response = engine.snapshot({
      entities: [{ ...applicationSelector, statePaths: ['currState'] }, { ...applicationSelector }],
    });

    expect(Object.keys(response.entities[EntityKind.Application])).toEqual([
      'asset-1/application-1',
    ]);
    expect(
      entitySnapshot(response, EntityKind.Application, 'asset-1/application-1')?.state,
    ).toMatchObject({
      currState: ProcessState.Undefined,
      pluginState: { nested: { runs: 0 } },
      hasError: false,
    });
  });
});
