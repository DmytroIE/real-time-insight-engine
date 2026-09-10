import { describe, expect, it } from 'vitest';

import {
  Engine,
  EntityKind,
  InMemoryStateStore,
  PluginRegistry,
  asApplicationId,
  asEngineId,
  asPluginTypeId,
  type ApplicationPlugin,
  type DevicePlugin,
  type EngineConfiguration,
  type EngineEvent,
  type StateStore,
} from '../src';
import { FakeClock } from './support/fake-clock';
import { FakeTimerScheduler } from './support/fake-timer-scheduler';

const emptyConfiguration = (): EngineConfiguration => ({
  engineId: asEngineId('engine-1'),
  devices: {},
  assets: {},
});

const lifecycleEvents = (events: readonly EngineEvent[]): readonly EngineEvent[] =>
  events.filter(({ type }) => type === 'engine.lifecycle' || type === 'engine.ready');

describe('LIFE-01 startup ordering', () => {
  it('publishes starting with false readiness before ready', async () => {
    const events: EngineEvent[] = [];

    await Engine.create(emptyConfiguration(), {
      clock: new FakeClock(1_000, 0),
      timers: new FakeTimerScheduler(),
      plugins: new PluginRegistry(),
      stateStore: new InMemoryStateStore(),
      lifecycleListener: (event) => events.push(event),
    });

    expect(lifecycleEvents(events).map((event) => event.type)).toEqual([
      'engine.lifecycle',
      'engine.lifecycle',
      'engine.ready',
    ]);
    expect(events[0]).toMatchObject({
      type: 'engine.lifecycle',
      data: { state: 'starting', ready: false },
    });
  });
});

describe('LIFE-02 readiness boundary', () => {
  it('becomes ready only after startup persistence completes', async () => {
    const operations: string[] = [];
    const store = new InMemoryStateStore();
    const trackingStore: StateStore = {
      load: async <Value>(key: string) => {
        operations.push('load');
        return store.load<Value>(key);
      },
      save: async <Value>(key: string, value: Value) => {
        operations.push('save');
        await store.save(key, value);
      },
      delete: (key) => store.delete(key),
      keys: async (prefix) => {
        operations.push('keys');
        return store.keys(prefix);
      },
    };

    const engine = await Engine.create(emptyConfiguration(), {
      clock: new FakeClock(1_000, 0),
      timers: new FakeTimerScheduler(),
      plugins: new PluginRegistry(),
      stateStore: trackingStore,
      lifecycleListener: (event) => operations.push(event.type),
    });

    expect(operations).toEqual([
      'engine.lifecycle',
      'load',
      'save',
      'keys',
      'engine.lifecycle',
      'engine.ready',
    ]);
    expect(engine.isReady).toBe(true);
    expect(engine.lifecycleState).toBe('ready');
  });
});

describe('LIFE-03 ready transition', () => {
  it('emits lifecycle and ready events with the current runtime session', async () => {
    const events: EngineEvent[] = [];
    const engine = await Engine.create(emptyConfiguration(), {
      clock: new FakeClock(1_234, 0),
      timers: new FakeTimerScheduler(),
      plugins: new PluginRegistry(),
      stateStore: new InMemoryStateStore(),
      lifecycleListener: (event) => events.push(event),
    });
    const readyEvents = events.slice(-2);

    expect(engine.sessionStartTs).toBe(1_234);
    expect(engine.sessionId).toBe('1234');
    expect(readyEvents).toMatchObject([
      { type: 'engine.lifecycle', data: { state: 'ready', ready: true, sessionId: '1234' } },
      { type: 'engine.ready', data: { ready: true, sessionId: '1234' } },
    ]);
  });

  it('reports a clean session in lifecycle and ready events', async () => {
    const events: EngineEvent[] = [];

    await Engine.create(emptyConfiguration(), {
      clock: new FakeClock(1_234, 0),
      timers: new FakeTimerScheduler(),
      plugins: new PluginRegistry(),
      stateStore: new InMemoryStateStore(),
      cleanSession: true,
      lifecycleListener: (event) => events.push(event),
    });

    expect(events.slice(-2)).toMatchObject([
      { type: 'engine.lifecycle', data: { state: 'ready', cleanSession: true } },
      { type: 'engine.ready', data: { cleanSession: true } },
    ]);
  });
});

describe('LIFE-04 lifecycle replay', () => {
  it('immediately replays the current lifecycle state to a late subscriber', async () => {
    const engine = await Engine.create(emptyConfiguration(), {
      clock: new FakeClock(1_000, 0),
      timers: new FakeTimerScheduler(),
      plugins: new PluginRegistry(),
      stateStore: new InMemoryStateStore(),
    });
    const events: EngineEvent[] = [];

    engine.subscribe('engine.lifecycle', (event) => events.push(event));

    expect(events).toEqual([
      expect.objectContaining({
        type: 'engine.lifecycle',
        data: { state: 'ready', ready: true, sessionId: engine.sessionId, cleanSession: false },
      }),
    ]);
  });
});

describe('LIFE-05 startup failure', () => {
  it('publishes failed and never ready when startup infrastructure fails', async () => {
    const events: EngineEvent[] = [];
    const failingStore: StateStore = {
      load: () => Promise.reject(new Error('load failed')),
      save: () => Promise.resolve(),
      delete: () => Promise.resolve(),
      keys: () => Promise.resolve([]),
    };

    await expect(
      Engine.create(emptyConfiguration(), {
        clock: new FakeClock(1_000, 0),
        timers: new FakeTimerScheduler(),
        plugins: new PluginRegistry(),
        stateStore: failingStore,
        lifecycleListener: (event) => events.push(event),
      }),
    ).rejects.toThrow('load failed');

    expect(events.map(({ type }) => type)).toEqual(['engine.lifecycle', 'engine.lifecycle']);
    expect(events.at(-1)).toMatchObject({ data: { state: 'failed', ready: false } });
    expect(events.some(({ type }) => type === 'engine.ready')).toBe(false);
  });
});

describe('LIFE-06 health and readiness', () => {
  it('keeps Engine readiness true when an Application evaluation fails', async () => {
    const settingsSchema = { type: 'object', additionalProperties: false } as const;
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
    const application: ApplicationPlugin<unknown, Record<string, never>> = {
      kind: 'application',
      type: asPluginTypeId('sxs.test-application'),
      version: 1,
      displayName: 'Test Application',
      requiredDatafeeds: ['temperature'],
      settingsSchema,
      defaultSettings: {},
      defaultState: {},
      create: () => ({
        evaluate: () => {
          throw new Error('calculation failed');
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
              type: application.type,
              runIntervalMs: 100,
              datafeeds: { temperature: 'device-1/temperature' },
            },
          ],
        },
      },
    };
    const engine = await Engine.create(configuration, {
      clock: new FakeClock(1_000, 0),
      timers: new FakeTimerScheduler(),
      plugins,
      stateStore: new InMemoryStateStore(),
    });

    await expect(engine.runApplication(asApplicationId('asset-1/application-1'))).resolves.toBe(
      'failed',
    );

    expect(engine.isReady).toBe(true);
    expect(engine.lifecycleState).toBe('ready');
    expect(
      engine.snapshot({ diagnostics: [{ type: EntityKind.Application, ids: '*' }] }).diagnostics
        .application['asset-1/application-1'],
    ).toEqual([expect.objectContaining({ code: 'APPLICATION_EXECUTION_ERROR' })]);
  });
});
