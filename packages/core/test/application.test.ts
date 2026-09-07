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
    {
      lastRunTimestamp,
      nextRunTimestamp,
      currState: ProcessState.Warning,
      noDataError: true,
      appError: true,
    },
    parent,
  );
  return { application, clock, datastream, diagnostics, events, parent, persistence };
};

describe('APP-01 due and overlap policy', () => {
  it('does not execute or mutate timestamps before it is due', async () => {
    let executions = 0;
    const { application, persistence } = setup(() => {
      executions += 1;
      return { state: {} };
    }, 1_100);
    const before = application.state();

    await expect(application.runIfDue()).resolves.toBe('not-due');

    expect(executions).toBe(0);
    expect(application.state()).toEqual(before);
    expect(persistence.dirtyCount).toBe(0);
  });

  it('derives a restored deadline from the active configured interval', async () => {
    const { application } = setup(() => ({ state: {} }), 9_000, 900);

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
    resolveEvaluation?.({ state: { value: 2 } });
    await expect(firstRun).resolves.toBe('completed');
    expect(executions).toBe(1);
  });
});

describe('APP-02 common reset and stale refresh', () => {
  it('resets common state and refreshes Datastreams before plugin evaluation', async () => {
    let observedState: unknown;
    let staleChecksAtEvaluation = 0;
    let observedSessionStartTs = 0;
    let observedPreviousNoDataError = false;
    let observedDatafeedState: unknown;
    const setupResult = setup((context) => {
      observedState = context.state;
      staleChecksAtEvaluation = setupResult.datastream.staleChecks;
      observedSessionStartTs = context.sessionStartTs;
      observedPreviousNoDataError = context.previousNoDataError;
      observedDatafeedState = context.datafeeds.temperature?.state();
      return { state: {} };
    });

    await setupResult.application.runIfDue();

    expect(staleChecksAtEvaluation).toBe(1);
    expect(observedState).toMatchObject({
      currState: ProcessState.Undefined,
      noDataError: false,
      appError: false,
    });
    expect(observedSessionStartTs).toBe(1_000);
    expect(observedPreviousNoDataError).toBe(true);
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
      state: { value: 7, label: 'complete' },
      currState: ProcessState.Ok,
    }));

    await expect(application.runIfDue()).resolves.toBe('completed');

    expect(application.state()).toEqual({
      lastRunTimestamp: 1_000,
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
        state: { value: 9, label: 'recovered' },
        currState: ProcessState.Warning,
        noDataError: true,
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
      return { state: {} };
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
