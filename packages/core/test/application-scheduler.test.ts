import { describe, expect, it } from 'vitest';

import {
  Application,
  ApplicationScheduler,
  DiagnosticRegistry,
  InMemoryEventBus,
  ProcessState,
  asApplicationId,
  asAssetId,
  asEngineId,
  asPluginTypeId,
  type ApplicationResult,
  type ApplicationRunOutcome,
  type ApplicationTask,
  type PersistenceMarker,
} from '../src';
import { FakeClock } from './support/fake-clock';
import { FakeTimerScheduler } from './support/fake-timer-scheduler';

const createApplication = (
  clock: FakeClock,
  evaluate: () =>
    ApplicationResult<{ runs: number }> | Promise<ApplicationResult<{ runs: number }>>,
  nextRunTimestamp: number,
): Application<{ runs: number }> => {
  const events = new InMemoryEventBus();
  const persistence: PersistenceMarker = { markDirty: () => undefined };
  return new Application(
    {
      id: asApplicationId('asset/application'),
      assetId: asAssetId('asset'),
      engineId: asEngineId('engine-1'),
      pluginType: asPluginTypeId('sxs.test-application'),
      runIntervalMs: 100,
      sessionStartTimestamp: 0,
    },
    {},
    { evaluate },
    clock,
    events,
    new DiagnosticRegistry(clock, events),
    persistence,
    { runs: 0 },
    { nextRunTimestamp },
  );
};

describe('SCHED-05 overdue Application execution', () => {
  it('runs an overdue Application once and sets next due from current time', async () => {
    const clock = new FakeClock(1_000, 0);
    const timers = new FakeTimerScheduler();
    let executions = 0;
    const application = createApplication(
      clock,
      () => ({
        pluginState: { runs: ++executions },
        currState: ProcessState.Ok,
        noDataError: false,
        appError: false,
      }),
      900,
    );
    const scheduler = new ApplicationScheduler(clock, timers, () => [application]);

    scheduler.start();
    expect(timers.nextDelayMs).toBe(0);
    await timers.runNextAsync();

    expect(executions).toBe(1);
    expect(application.state()).toMatchObject({
      lastRunTimestamp: 1_000,
      nextRunTimestamp: 1_100,
      pluginState: { runs: 1 },
    });
  });
});

describe('SCHED-06 missed interval policy', () => {
  it('does not replay historical intervals after an overdue restart', async () => {
    const clock = new FakeClock(10_000, 0);
    const timers = new FakeTimerScheduler();
    let executions = 0;
    const application = createApplication(
      clock,
      () => ({
        pluginState: { runs: ++executions },
        currState: ProcessState.Undefined,
        noDataError: false,
        appError: false,
      }),
      1_000,
    );
    const scheduler = new ApplicationScheduler(clock, timers, () => [application]);

    scheduler.start();
    await timers.runNextAsync();

    expect(executions).toBe(1);
    expect(application.nextApplicationRunTimestamp()).toBe(10_100);
    expect(timers.nextDelayMs).toBe(100);
  });
});

class TestApplicationTask implements ApplicationTask {
  public runs = 0;

  public constructor(
    public readonly id: ReturnType<typeof asApplicationId>,
    public nextDue: number,
    private readonly result: ApplicationRunOutcome | Error,
  ) {}

  public nextApplicationRunTimestamp(): number {
    return this.nextDue;
  }

  public async runIfDue(): Promise<ApplicationRunOutcome> {
    this.runs += 1;
    if (this.result instanceof Error) {
      throw this.result;
    }
    this.nextDue += 100;
    return this.result;
  }
}

describe('SCHED-07 Application failure isolation', () => {
  it('continues later due Applications after an unexpected task failure', async () => {
    const clock = new FakeClock(1_000, 0);
    const timers = new FakeTimerScheduler();
    const failing = new TestApplicationTask(
      asApplicationId('asset/failing'),
      1_000,
      new Error('boom'),
    );
    const succeeding = new TestApplicationTask(
      asApplicationId('asset/succeeding'),
      1_000,
      'completed',
    );
    const results: Array<{ readonly id: string; readonly failed: boolean }> = [];
    const scheduler = new ApplicationScheduler(
      clock,
      timers,
      () => [failing, succeeding],
      ({ task, error }) => results.push({ id: task.id, failed: error !== undefined }),
    );

    scheduler.start();
    await timers.runNextAsync();

    expect(failing.runs).toBe(1);
    expect(succeeding.runs).toBe(1);
    expect(results).toEqual([
      { id: 'asset/failing', failed: true },
      { id: 'asset/succeeding', failed: false },
    ]);
    expect(timers.pendingCount).toBe(1);
  });
});

describe('SCHED-08 overlap and cleanup', () => {
  it('skips overlap deterministically, retries later, and removes its timer on stop', async () => {
    const clock = new FakeClock(1_000, 0);
    const timers = new FakeTimerScheduler();
    let executions = 0;
    let resolveEvaluation: ((result: ApplicationResult<{ runs: number }>) => void) | undefined;
    const application = createApplication(
      clock,
      () =>
        new Promise((resolve) => {
          executions += 1;
          resolveEvaluation = resolve;
        }),
      1_000,
    );
    const firstRun = application.runIfDue();
    const outcomes: ApplicationRunOutcome[] = [];
    const scheduler = new ApplicationScheduler(
      clock,
      timers,
      () => [application],
      ({ outcome }) => {
        if (outcome !== undefined) {
          outcomes.push(outcome);
        }
      },
    );

    scheduler.start();
    clock.advanceBy(100);
    await timers.runNextAsync();

    expect(executions).toBe(1);
    expect(outcomes).toEqual(['skipped-overlap']);
    expect(timers.nextDelayMs).toBe(1_000);

    resolveEvaluation?.({
      pluginState: { runs: 1 },
      currState: ProcessState.Undefined,
      noDataError: false,
      appError: false,
    });
    await expect(firstRun).resolves.toBe('completed');
    scheduler.stop();
    scheduler.stop();
    expect(timers.pendingCount).toBe(0);
  });
});
