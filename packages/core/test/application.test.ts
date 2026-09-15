import { describe, expect, it } from 'vitest';

import {
  Application,
  DiagnosticRegistry,
  EntityKind,
  InMemoryEventBus,
  ProcessState,
  asApplicationId,
  asAssetId,
  asDatastreamId,
  asEngineId,
  asPluginTypeId,
  type ApplicationDatastream,
  type ApplicationEvaluationContext,
  type ApplicationResult,
  type EngineEvent,
  type ParentRecomputationRequester,
  type PersistenceMarker,
  type RestoredApplicationState,
} from '../src';
import { FakeClock } from './support/fake-clock';

interface CalculationState {
  value: number;
  label: string;
}

class FakeDatastream implements ApplicationDatastream {
  public readonly id = asDatastreamId('device-1/temperature');
  public staleChecks = 0;

  public evaluateStale(): boolean {
    this.staleChecks += 1;
    return false;
  }

  public state() {
    return {
      lastUpdateTimestamp: 0,
      nextUpdateTimestamp: 0,
      noDataError: false,
      hwError: false,
      samples: [],
    };
  }

  public averageValue(): null {
    return null;
  }
}

class FakePersistenceMarker implements PersistenceMarker {
  public dirtyCount = 0;

  public markDirty(): void {
    this.dirtyCount += 1;
  }
}

class FakeParentRequester implements ParentRecomputationRequester {
  public requestCount = 0;

  public requestRecompute(): void {
    this.requestCount += 1;
  }
}

const setup = (
  evaluate: (
    context: ApplicationEvaluationContext<CalculationState>,
  ) => ApplicationResult<CalculationState> | Promise<ApplicationResult<CalculationState>>,
  nextRunTimestamp = 1_000,
  lastRunTimestamp = nextRunTimestamp - 100,
  restored: RestoredApplicationState<CalculationState> = {
    lastRunTimestamp,
    nextRunTimestamp,
    currState: ProcessState.Warning,
    noDataError: true,
    appError: true,
  },
) => {
  const clock = new FakeClock(1_000, 0);
  const eventBus = new InMemoryEventBus();
  const events: EngineEvent[] = [];
  eventBus.subscribe('*', (event) => events.push(event));
  const diagnostics = new DiagnosticRegistry(clock, eventBus);
  const persistence = new FakePersistenceMarker();
  const parent = new FakeParentRequester();
  const datastream = new FakeDatastream();
  const application = new Application(
    {
      id: asApplicationId('asset-1/application-1'),
      assetId: asAssetId('asset-1'),
      engineId: asEngineId('engine-1'),
      pluginType: asPluginTypeId('sxs.test-application'),
      runIntervalMs: 100,
      sessionStartTimestamp: 1_000,
    },
    { temperature: datastream },
    { evaluate },
    clock,
    eventBus,
    diagnostics,
    persistence,
    { value: 1, label: 'initial' },
    restored,
    parent,
  );
  return { application, clock, datastream, diagnostics, events, parent, persistence };
};

describe('APP-01 due and overlap policy', () => {
  it('does not execute or mutate timestamps before it is due', async () => {
    let executions = 0;
    const { application, persistence } = setup(() => {
      executions += 1;
      return {
        pluginState: { value: 1, label: 'initial' },
        currState: ProcessState.Warning,
        noDataError: true,
        appError: true,
      };
    }, 1_100);
    const before = application.state();

    await expect(application.runIfDue()).resolves.toBe('not-due');

    expect(executions).toBe(0);
    expect(application.state()).toEqual(before);
    expect(persistence.dirtyCount).toBe(0);
  });

  it('uses the session start as the fresh Application scheduling baseline', async () => {
    let executions = 0;
    const { application, persistence } = setup(
      () => {
        executions += 1;
        return {
          pluginState: { value: 1, label: 'initial' },
          currState: ProcessState.Warning,
          noDataError: true,
          appError: true,
        };
      },
      1_000,
      900,
      {},
    );

    expect(application.state()).toMatchObject({
      lastRunTimestamp: 1_000,
      lastUpdateTimestamp: 1_000,
      nextRunTimestamp: 1_100,
    });
    await expect(application.runIfDue()).resolves.toBe('not-due');

    expect(executions).toBe(0);
    expect(persistence.dirtyCount).toBe(0);
  });

  it('derives a restored deadline from the active configured interval', async () => {
    const { application } = setup(
      () => ({
        pluginState: { value: 1, label: 'initial' },
        currState: ProcessState.Warning,
        noDataError: true,
        appError: true,
      }),
      9_000,
      900,
    );

    expect(application.nextApplicationRunTimestamp()).toBe(1_000);
  });

  it('skips an overlapping invocation without starting a second execution', async () => {
    let resolveEvaluation: ((result: ApplicationResult<CalculationState>) => void) | undefined;
    let executions = 0;
    const { application } = setup(
      () =>
        new Promise((resolve) => {
          executions += 1;
          resolveEvaluation = resolve;
        }),
    );

    const firstRun = application.runIfDue();
    await expect(application.runIfDue()).resolves.toBe('skipped-overlap');
    resolveEvaluation?.({
      pluginState: { value: 2, label: 'initial' },
      currState: ProcessState.Undefined,
      noDataError: false,
      appError: false,
    });
    await expect(firstRun).resolves.toBe('completed');
    expect(executions).toBe(1);
  });
});

describe('APP-02 complete context and stale refresh', () => {
  it('provides common/plugin state and refreshes Datastreams before plugin evaluation', async () => {
    let observedCommonState: unknown;
    let observedPluginState: unknown;
    let staleChecksAtEvaluation = 0;
    let observedSessionStartTs = 0;
    let observedDatafeedState: unknown;
    const setupResult = setup((context) => {
      observedCommonState = {
        currState: context.currState,
        noDataError: context.noDataError,
        appError: context.appError,
      };
      observedPluginState = context.pluginState;
      staleChecksAtEvaluation = setupResult.datastream.staleChecks;
      observedSessionStartTs = context.sessionStartTs;
      observedDatafeedState = context.datafeeds.temperature?.state();
      return {
        pluginState: { value: 1, label: 'initial' },
        currState: ProcessState.Warning,
        noDataError: true,
        appError: true,
      };
    });

    await setupResult.application.runIfDue();

    expect(staleChecksAtEvaluation).toBe(1);
    expect(observedCommonState).toEqual({
      currState: ProcessState.Warning,
      noDataError: true,
      appError: true,
    });
    expect(observedPluginState).toEqual({ value: 1, label: 'initial' });
    expect(observedSessionStartTs).toBe(1_000);
    expect(observedDatafeedState).toEqual({
      lastUpdateTimestamp: 0,
      nextUpdateTimestamp: 0,
      noDataError: false,
      hwError: false,
      samples: [],
    });
  });
});

describe('APP-03 successful atomic commit', () => {
  it('commits common and plugin-specific result state together', async () => {
    const { application, events, parent, persistence } = setup(() => ({
      pluginState: { value: 7, label: 'complete' },
      currState: ProcessState.Ok,
      noDataError: false,
      appError: false,
    }));

    await expect(application.runIfDue()).resolves.toBe('completed');

    expect(application.state()).toEqual({
      lastRunTimestamp: 1_000,
      lastUpdateTimestamp: 1_000,
      nextRunTimestamp: 1_100,
      currState: ProcessState.Ok,
      noDataError: false,
      appError: false,
      pluginState: { value: 7, label: 'complete' },
    });
    expect(persistence.dirtyCount).toBe(1);
    expect(parent.requestCount).toBe(1);
    expect(events).toContainEqual(expect.objectContaining({ type: 'entity.updated' }));
  });

  it('updates run metadata without publishing when the calculated state is unchanged', async () => {
    const { application, events, parent, persistence } = setup(() => ({
      pluginState: { value: 1, label: 'initial' },
      currState: ProcessState.Warning,
      noDataError: true,
      appError: true,
    }));

    await expect(application.runIfDue()).resolves.toBe('completed');

    expect(application.state()).toMatchObject({
      lastRunTimestamp: 1_000,
      lastUpdateTimestamp: 1_000,
      currState: ProcessState.Warning,
      noDataError: true,
      appError: true,
    });
    expect(persistence.dirtyCount).toBe(1);
    expect(parent.requestCount).toBe(0);
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'entity.updated' }));
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'application.executed',
        data: expect.objectContaining({ success: true, resultChanged: false }),
      }),
    );
  });
});

describe('APP-08 execution events', () => {
  it('publishes execution after a material update with the committed timestamps', async () => {
    const { application, events } = setup(() => ({
      pluginState: { value: 7, label: 'complete' },
      currState: ProcessState.Ok,
      noDataError: false,
      appError: false,
    }));

    await application.runIfDue();

    expect(events.filter((event) => event.type === 'entity.updated')).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      type: 'application.executed',
      data: {
        success: true,
        resultChanged: true,
        lastRunTimestamp: 1_000,
        lastUpdateTimestamp: 1_000,
      },
    });
  });

  it('publishes a failed execution after committing the runner failure state', async () => {
    const { application, events } = setup(() => {
      throw new Error('calculation failed');
    });

    await application.runIfDue();

    expect(events.at(-1)).toMatchObject({
      type: 'application.executed',
      data: {
        success: false,
        resultChanged: true,
        lastRunTimestamp: 1_000,
        lastUpdateTimestamp: 1_000,
      },
    });
  });
});

describe('APP-04 execution failure state', () => {
  it('finishes with exactly Undefined, no no-data error, and appError true', async () => {
    const { application } = setup(() => {
      throw new Error('calculation failed');
    });

    await expect(application.runIfDue()).resolves.toBe('failed');

    expect(application.state()).toMatchObject({
      currState: ProcessState.Undefined,
      noDataError: false,
      appError: true,
    });
  });
});

describe('APP-05 failed transactional evaluation', () => {
  it('does not partially commit plugin state or clear prior plugin diagnostics', async () => {
    const { application, diagnostics } = setup((context) => {
      context.diagnostics.report({
        code: 'NEW_PARTIAL_CONDITION',
        severity: 'warning',
        message: 'Partial condition',
      });
      throw new Error('calculation failed');
    });
    diagnostics.observe({
      category: 'Application',
      sourceId: application.id,
      ownerScope: 'application-calculation',
      code: 'EXISTING_CONDITION',
      severity: 'warning',
      message: 'Existing condition',
      retention: 'condition',
      source: {
        engineId: asEngineId('engine-1'),
        entityType: EntityKind.Application,
        entityId: application.id,
        pluginType: asPluginTypeId('sxs.test-application'),
      },
    });

    await application.runIfDue();

    expect(application.state().pluginState).toEqual({ value: 1, label: 'initial' });
    expect(
      diagnostics
        .records()
        .map(({ code }) => code)
        .sort(),
    ).toEqual(['APPLICATION_EXECUTION_ERROR', 'EXISTING_CONDITION']);
  });
});

describe('APP-06 recovery after failure', () => {
  it('clears the runner diagnostic and replaces calculation state on success', async () => {
    let fail = true;
    const { application, clock, diagnostics } = setup(() => {
      if (fail) {
        throw new Error('calculation failed');
      }
      return {
        pluginState: { value: 9, label: 'recovered' },
        currState: ProcessState.Warning,
        noDataError: true,
        appError: false,
      };
    });
    await application.runIfDue();
    fail = false;
    clock.advanceWallBy(100);

    await expect(application.runIfDue()).resolves.toBe('completed');

    expect(application.state()).toMatchObject({
      currState: ProcessState.Warning,
      noDataError: true,
      appError: false,
      pluginState: { value: 9, label: 'recovered' },
    });
    expect(diagnostics.records()).toEqual([]);
  });
});

describe('Application parent diagnostic scope', () => {
  it('reconciles Asset diagnostics independently on behalf of its parent Asset', async () => {
    const { application, diagnostics } = setup((context) => {
      context.assetDiagnostics.report({
        code: 'ASSET_CONDITION',
        severity: 'warning',
        message: 'Reported by application',
      });
      return {
        pluginState: { value: 1, label: 'initial' },
        currState: ProcessState.Warning,
        noDataError: true,
        appError: true,
      };
    });

    await expect(application.runIfDue()).resolves.toBe('completed');

    expect(diagnostics.records('Asset')).toEqual([
      expect.objectContaining({
        sourceId: 'asset-1',
        ownerScope: 'application:asset-1/application-1:application-calculation',
        code: 'ASSET_CONDITION',
      }),
    ]);
  });
});
