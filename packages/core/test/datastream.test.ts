import { describe, expect, it } from 'vitest';

import {
  Datastream,
  DiagnosticRegistry,
  EntityKind,
  InMemoryEventBus,
  asDatastreamId,
  asEngineId,
  type Diagnostic,
  type EngineEvent,
  type ParentRecomputationRequester,
  type PersistenceMarker,
  type RestoredDatastreamState,
} from '../src';
import { FakeClock } from './support/fake-clock';

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
  restored: RestoredDatastreamState = {},
  restoredDiagnostics: readonly Diagnostic[] = [],
) => {
  const clock = new FakeClock(1_000, 0);
  const eventBus = new InMemoryEventBus();
  const events: EngineEvent[] = [];
  eventBus.subscribe('*', (event) => events.push(event));
  const diagnostics = new DiagnosticRegistry(clock, eventBus, restoredDiagnostics);
  const persistence = new FakePersistenceMarker();
  const parent = new FakeParentRequester();
  const datastream = new Datastream(
    {
      id: asDatastreamId('device-1/temperature'),
      engineId: asEngineId('engine-1'),
      maxBufferLength: 3,
      maxBufferAgeMs: 10_000,
      expectedIntervalMs: 100,
      sessionStartTimestamp: 1_000,
    },
    clock,
    eventBus,
    diagnostics,
    persistence,
    restored,
    parent,
  );
  return { clock, datastream, diagnostics, events, parent, persistence };
};

describe('DS-05 valid input', () => {
  it('updates timestamps, due time, buffer, persistence, and entity event', () => {
    const { datastream, events, parent, persistence } = setup();

    datastream.acceptSample({ timestamp: 950, value: 21.5 });

    expect(datastream.state()).toEqual({
      lastUpdateTimestamp: 1_000,
      nextUpdateTimestamp: 1_150,
      noDataError: false,
      hwError: false,
      samples: [{ timestamp: 950, value: 21.5 }],
    });
    expect(persistence.dirtyCount).toBe(1);
    expect(parent.requestCount).toBe(1);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'entity.updated',
        timestamp: 1_000,
      }),
    );
  });
});

describe('DS-06 invalid input', () => {
  it('sets hardware error and its diagnostic without inserting a sample', () => {
    const { datastream, diagnostics, events } = setup();

    datastream.rejectInput('Sensor sentinel value', { rawValue: 3272.7 });

    expect(datastream.state()).toMatchObject({ hwError: true, samples: [] });
    expect(diagnostics.records()).toEqual([
      expect.objectContaining({
        category: 'Datastream',
        ownerScope: 'datastream-input',
        code: 'INVALID_INPUT',
        details: { rawValue: 3272.7 },
      }),
    ]);
    expect(events.map((event) => event.type)).toEqual(['diagnostic.raised', 'entity.updated']);
  });
});

describe('DS-07 startup grace and interval margin', () => {
  it('marks an empty buffer stale no earlier than the grace period', () => {
    const { clock, datastream } = setup();

    clock.advanceWallBy(149);
    expect(datastream.evaluateStale()).toBe(false);
    expect(datastream.state().noDataError).toBe(false);

    clock.advanceWallBy(1);
    expect(datastream.evaluateStale()).toBe(false);
    expect(datastream.state().noDataError).toBe(false);

    clock.advanceWallBy(150);
    expect(datastream.evaluateStale()).toBe(true);
    expect(datastream.state().noDataError).toBe(true);
  });

  it('retains a restored no-data condition during the new session grace period', () => {
    const restoredDiagnostic: Diagnostic = {
      category: 'Datastream',
      sourceId: 'device-1/temperature',
      ownerScope: 'datastream-stale',
      code: 'NO_DATA',
      severity: 'error',
      message: 'Datastream has no current data',
      retention: 'condition',
      source: {
        engineId: asEngineId('engine-1'),
        entityType: EntityKind.Datastream,
        entityId: asDatastreamId('device-1/temperature'),
      },
      firstRaisedTs: 800,
      lastUpdatedTs: 800,
      lastObservedTs: 900,
      occurrenceCount: 1,
    };
    const { clock, datastream, diagnostics, events } = setup({ noDataError: true }, [
      restoredDiagnostic,
    ]);

    clock.advanceWallBy(150);

    expect(datastream.evaluateStale()).toBe(true);
    expect(datastream.state().noDataError).toBe(true);
    expect(diagnostics.records()).toEqual([expect.objectContaining({ code: 'NO_DATA' })]);
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'diagnostic.cleared' }));
  });

  it('derives a restored deadline from the active configured interval', () => {
    const { datastream } = setup({ lastUpdateTimestamp: 900, nextUpdateTimestamp: 9_000 });

    expect(datastream.nextStaleCheckTimestamp()).toBe(1_050);
  });
});

describe('DS-08 fresh data recovery', () => {
  it('clears no-data and hardware diagnostics when fresh data arrives', () => {
    const { clock, datastream, diagnostics, events } = setup();
    clock.advanceWallBy(300);
    datastream.evaluateStale();
    datastream.rejectInput('Invalid input');
    clock.advanceWallBy(10);

    datastream.acceptSample({ timestamp: 1_160, value: 22 });

    expect(datastream.state()).toMatchObject({ noDataError: false, hwError: false });
    expect(diagnostics.records()).toEqual([]);
    expect(events.filter((event) => event.type === 'diagnostic.cleared')).toHaveLength(2);
  });
});

describe('DS-09 independent stale evaluation', () => {
  it('becomes stale through an explicit check without input or Application access', () => {
    const { clock, datastream, diagnostics, persistence } = setup();
    clock.advanceWallBy(300);

    expect(datastream.evaluateStale()).toBe(true);

    expect(diagnostics.records()).toEqual([
      expect.objectContaining({ code: 'NO_DATA', ownerScope: 'datastream-stale' }),
    ]);
    expect(persistence.dirtyCount).toBe(1);
  });
});
