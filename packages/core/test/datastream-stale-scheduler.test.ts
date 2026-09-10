import { describe, expect, it } from 'vitest';

import {
  DatastreamStaleScheduler,
  Engine,
  EntityKind,
  InMemoryStateStore,
  PluginRegistry,
  ProcessState,
  asApplicationId,
  asDatastreamId,
  asEngineId,
  asPluginTypeId,
  type ApplicationPlugin,
  type DatastreamStaleTask,
  type DevicePlugin,
  type EngineConfiguration,
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
    datastreams: ['mapped', 'unmapped'],
    settingsSchema,
    defaultSettings: {},
    create: () => ({ parse: () => ({ accepted: true }) }),
  };
  const application: ApplicationPlugin<unknown, Record<string, never>> = {
    kind: 'application',
    type: asPluginTypeId('sxs.test-application'),
    version: 1,
    displayName: 'Test Application',
    requiredDatafeeds: ['input'],
    settingsSchema,
    defaultSettings: {},
    defaultState: {},
    create: () => ({
      evaluate: () => ({
        pluginState: {},
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
  devices: {
    'device-1': {
      type: asPluginTypeId('sxs.test-device'),
      datastreams: {
        mapped: { maxBufferLength: 2, maxBufferAgeMs: 1_000, expectedIntervalMs: 100 },
        unmapped: { maxBufferLength: 2, maxBufferAgeMs: 1_000, expectedIntervalMs: 100 },
      },
    },
  },
  assets: {
    'asset-1': {
      applications: [
        {
          id: 'application-1',
          type: asPluginTypeId('sxs.test-application'),
          runIntervalMs: 1_000,
          datafeeds: { input: 'device-1/mapped' },
        },
      ],
    },
  },
});

describe('SCHED-01 complete Datastream scheduling', () => {
  it('checks every configured Datastream, including an unmapped one', async () => {
    const clock = new FakeClock(1_000, 0);
    const timers = new FakeTimerScheduler();
    const engine = await Engine.create(configuration(), {
      clock,
      timers,
      plugins: createPlugins(),
      stateStore: new InMemoryStateStore(),
    });

    expect(timers.pendingCount).toBe(3);
    expect(timers.nextDelayMs).toBe(150);
    clock.advanceBy(150);
    timers.runNext();

    const datastreams = engine.snapshot({
      entities: [{ type: EntityKind.Device, ids: 'device-1', children: true }],
    }).entities.datastream;
    expect(Object.values(datastreams).map(({ state }) => state)).toEqual([
      expect.objectContaining({ noDataError: false }),
      expect.objectContaining({ noDataError: false }),
    ]);
  });
});

describe('SCHED-02 independent stale timing', () => {
  it('checks a Datastream before its consuming Application is due without bypassing grace', async () => {
    const clock = new FakeClock(1_000, 0);
    const timers = new FakeTimerScheduler();
    const engine = await Engine.create(configuration(), {
      clock,
      timers,
      plugins: createPlugins(),
      stateStore: new InMemoryStateStore(),
    });
    await engine.runApplication(asApplicationId('asset-1/application-1'));

    clock.advanceBy(150);
    timers.runNext();

    const snapshot = engine.snapshot({
      entities: [
        { type: EntityKind.Datastream, ids: '*' },
        { type: EntityKind.Application, ids: '*' },
      ],
    });
    const mapped = snapshot.entities.datastream['device-1/mapped'];
    const application = snapshot.entities.application['asset-1/application-1'];
    expect(mapped?.state).toMatchObject({ noDataError: false });
    expect(application?.state).toMatchObject({ nextRunTimestamp: 2_000, noDataError: false });
  });
});

class TestStaleTask implements DatastreamStaleTask {
  public runs = 0;

  public constructor(
    public readonly id: ReturnType<typeof asDatastreamId>,
    public nextDue: number,
    private readonly failure?: Error,
  ) {}

  public nextStaleCheckTimestamp(): number {
    return this.nextDue;
  }

  public evaluateStale(): boolean {
    this.runs += 1;
    if (this.failure !== undefined) {
      throw this.failure;
    }
    this.nextDue += 100;
    return true;
  }
}

describe('SCHED-03 stale-task isolation', () => {
  it('continues later due tasks and reschedules after one task throws', () => {
    const clock = new FakeClock(100, 0);
    const timers = new FakeTimerScheduler();
    const failing = new TestStaleTask(asDatastreamId('device/failing'), 100, new Error('boom'));
    const succeeding = new TestStaleTask(asDatastreamId('device/succeeding'), 100);
    const results: Array<{ readonly id: string; readonly failed: boolean }> = [];
    const scheduler = new DatastreamStaleScheduler(
      clock,
      timers,
      () => [failing, succeeding],
      ({ task, error }) => results.push({ id: task.id, failed: error !== undefined }),
    );

    scheduler.start();

    expect(failing.runs).toBe(1);
    expect(succeeding.runs).toBe(1);
    expect(results).toEqual([
      { id: 'device/failing', failed: true },
      { id: 'device/succeeding', failed: false },
    ]);
    expect(timers.pendingCount).toBe(1);
  });
});

describe('SCHED-04 timer lifecycle', () => {
  it('reschedules from the next due timestamp and removes its timer on stop', () => {
    const clock = new FakeClock(100, 0);
    const timers = new FakeTimerScheduler();
    const task = new TestStaleTask(asDatastreamId('device/temperature'), 150);
    const scheduler = new DatastreamStaleScheduler(clock, timers, () => [task]);

    scheduler.start();
    expect(timers.nextDelayMs).toBe(50);

    clock.advanceBy(50);
    timers.runNext();
    expect(task.runs).toBe(1);
    expect(timers.nextDelayMs).toBe(100);

    scheduler.stop();
    scheduler.stop();
    expect(timers.pendingCount).toBe(0);
  });
});
