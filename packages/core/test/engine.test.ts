import { describe, expect, it } from 'vitest';

import {
  Engine,
  PluginRegistry,
  ProcessState,
  asApplicationId,
  asPluginTypeId,
  type ApplicationPlugin,
  type DevicePlugin,
  type EngineConfiguration,
  type EngineEvent,
} from '../src';
import { FakeClock } from './support/fake-clock';
import { FakeTimerScheduler } from './support/fake-timer-scheduler';

interface CalculationState {
  runs: number;
}

const settingsSchema = { type: 'object', additionalProperties: false } as const;

const createPlugins = (constructionOrder: string[] = []): PluginRegistry => {
  const device: DevicePlugin<
    Record<string, never>,
    Record<string, never>,
    { parse(): { accepted: true } }
  > = {
    kind: 'device',
    type: asPluginTypeId('sxs.test-device'),
    version: 1,
    displayName: 'Test Device',
    datastreams: ['temperature'],
    settingsSchema,
    defaultSettings: {},
    create: ({ id }) => {
      constructionOrder.push(`device:${id}`);
      return { parse: () => ({ accepted: true }) };
    },
  };
  const application: ApplicationPlugin<
    Record<string, never>,
    CalculationState,
    { evaluate(): { state: CalculationState; currState: ProcessState } }
  > = {
    kind: 'application',
    type: asPluginTypeId('sxs.test-application'),
    version: 1,
    displayName: 'Test Application',
    requiredDatafeeds: ['temperature'],
    settingsSchema,
    defaultSettings: {},
    defaultState: { runs: 0 },
    create: ({ id, datafeeds }) => {
      constructionOrder.push(`application:${id}:${datafeeds['temperature']}`);
      return {
        evaluate: () => ({ state: { runs: 1 }, currState: ProcessState.Ok }),
      };
    },
  };
  const plugins = new PluginRegistry();
  plugins.register(device);
  plugins.register(application);
  return plugins;
};

const configuration = (engineId = 'engine-1'): EngineConfiguration => ({
  engineId: engineId as EngineConfiguration['engineId'],
  devices: {
    'device-1': {
      type: asPluginTypeId('sxs.test-device'),
      settings: {},
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
          settings: {},
          datafeeds: { temperature: 'device-1/temperature' },
        },
      ],
    },
  },
});

const createEngine = (
  config = configuration(),
  plugins = createPlugins(),
  clock = new FakeClock(1_000, 0),
  timers = new FakeTimerScheduler(),
): Engine => new Engine(config, { clock, timers, plugins });

describe('ENG-01 Engine object graph', () => {
  it('constructs entities in dependency order with stable qualified IDs', () => {
    const constructionOrder: string[] = [];
    const engine = createEngine(configuration(), createPlugins(constructionOrder));

    expect(constructionOrder).toEqual([
      'device:device-1',
      'application:asset-1/application-1:device-1/temperature',
    ]);
    expect(engine.registry()).toEqual({
      devices: ['device-1'],
      datastreams: ['device-1/temperature'],
      assets: ['asset-1'],
      applications: ['asset-1/application-1'],
    });
  });

  it('derives safe IDs while retaining descriptive configured names', () => {
    const base = configuration();
    const device = base.devices['device-1'];
    const application = base.assets['asset-1']?.applications[0];
    if (device === undefined || application === undefined) {
      throw new Error('Missing test configuration');
    }
    const config: EngineConfiguration = {
      ...base,
      devices: { 'Diag kit TX2 19297/2': device },
      assets: {
        'Steam Trap 1': {
          applications: [
            {
              ...application,
              id: 'Twin Temp Failed Closed',
              datafeeds: {
                temperature: { device: 'Diag kit TX2 19297/2', datastream: 'temperature' },
              },
            },
          ],
        },
      },
    };

    const engine = createEngine(config);

    expect(engine.registry()).toEqual({
      devices: ['Diag%20kit%20TX2%2019297%2F2'],
      datastreams: ['Diag%20kit%20TX2%2019297%2F2/temperature'],
      assets: ['Steam%20Trap%201'],
      applications: ['Steam%20Trap%201/Twin%20Temp%20Failed%20Closed'],
    });
    const entities = engine.snapshot({ target: { scope: 'all' } }).entities;
    expect(entities.device['Diag%20kit%20TX2%2019297%2F2']).toMatchObject({
      entityType: 'device',
      entityName: 'Diag kit TX2 19297/2',
    });
    expect(entities.application['Steam%20Trap%201/Twin%20Temp%20Failed%20Closed']).toMatchObject({
      entityType: 'application',
      entityName: 'Twin Temp Failed Closed',
    });
  });
});

describe('ENG-02 atomic graph validation', () => {
  it('rejects duplicate IDs before invoking factories', () => {
    const constructionOrder: string[] = [];
    const config = configuration();
    const duplicate = config.assets['asset-1']?.applications[0];
    const invalid: EngineConfiguration = {
      ...config,
      assets: {
        'asset-1': { applications: duplicate === undefined ? [] : [duplicate, duplicate] },
      },
    };

    expect(() => createEngine(invalid, createPlugins(constructionOrder))).toThrow(
      'Duplicate application ID: asset-1/application-1',
    );
    expect(constructionOrder).toEqual([]);
  });

  it('rejects unresolved mappings before invoking factories', () => {
    const constructionOrder: string[] = [];
    const config = configuration();
    const application = config.assets['asset-1']?.applications[0];
    if (application === undefined) {
      throw new Error('Missing test Application');
    }
    const invalid: EngineConfiguration = {
      ...config,
      assets: {
        'asset-1': {
          applications: [{ ...application, datafeeds: { temperature: 'device-1/missing' } }],
        },
      },
    };

    expect(() => createEngine(invalid, createPlugins(constructionOrder))).toThrow(
      'references unknown Datastream: device-1/missing',
    );
    expect(constructionOrder).toEqual([]);
  });
});

describe('ENG-03 Engine isolation', () => {
  it('isolates registries, buses, dirty state, and parent timers', async () => {
    const plugins = createPlugins();
    const firstTimers = new FakeTimerScheduler();
    const secondTimers = new FakeTimerScheduler();
    const first = createEngine(configuration('engine-1'), plugins, undefined, firstTimers);
    const second = createEngine(configuration('engine-2'), plugins, undefined, secondTimers);
    const firstEvents: EngineEvent[] = [];
    const secondEvents: EngineEvent[] = [];
    first.subscribe('*', (event) => firstEvents.push(event));
    second.subscribe('*', (event) => secondEvents.push(event));
    firstEvents.length = 0;
    secondEvents.length = 0;
    const firstTimerBaseline = firstTimers.pendingCount;
    const secondTimerBaseline = secondTimers.pendingCount;

    await expect(first.runApplication(asApplicationId('asset-1/application-1'))).resolves.toBe(
      'completed',
    );

    expect(firstEvents).toHaveLength(1);
    expect(secondEvents).toEqual([]);
    expect(first.dirty).toBe(true);
    expect(second.dirty).toBe(false);
    expect(firstTimers.pendingCount).toBe(firstTimerBaseline + 1);
    expect(secondTimers.pendingCount).toBe(secondTimerBaseline);
    expect(first.registry()).toEqual(second.registry());
  });
});

describe('ENG-04 read-only registry view', () => {
  it('cannot mutate live Engine registries', () => {
    const engine = createEngine();
    const view = engine.registry();

    expect(() => (view.applications as unknown as string[]).push('other')).toThrow();
    expect(() => Object.assign(view, { devices: [] })).toThrow();
    expect(engine.registry().applications).toEqual(['asset-1/application-1']);
  });
});
