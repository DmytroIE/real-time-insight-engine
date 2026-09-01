import { describe, expect, it } from 'vitest';

import {
  Datastream,
  DiagnosticRegistry,
  InMemoryEventBus,
  asDatastreamId,
  asEngineId,
  type EngineEvent,
  type ParentRecomputationRequester,
  type PersistenceMarker,
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

const setup = () => {
  const clock = new FakeClock(1_000, 0);
  const eventBus = new InMemoryEventBus();
  const events: EngineEvent[] = [];
  eventBus.subscribe('*', (event) => events.push(event));
  const diagnostics = new DiagnosticRegistry(clock, eventBus);
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
    {},
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
  it('marks an empty buffer stale only at the margin-adjusted due time', () => {
    const { clock, datastream } = setup();

    clock.advanceWallBy(149);
    expect(datastream.evaluateStale()).toBe(false);
    expect(datastream.state().noDataError).toBe(false);

    clock.advanceWallBy(1);
    expect(datastream.evaluateStale()).toBe(true);
    expect(datastream.state().noDataError).toBe(true);
  });
});

describe('DS-08 fresh data recovery', () => {
  it('clears no-data and hardware diagnostics when fresh data arrives', () => {
    const { clock, datastream, diagnostics, events } = setup();
    clock.advanceWallBy(150);
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
    clock.advanceWallBy(150);

    expect(datastream.evaluateStale()).toBe(true);

    expect(diagnostics.records()).toEqual([
      expect.objectContaining({ code: 'NO_DATA', ownerScope: 'datastream-stale' }),
    ]);
    expect(persistence.dirtyCount).toBe(1);
  });
});
