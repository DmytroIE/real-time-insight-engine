import { describe, expect, it } from 'vitest';

import {
  DiagnosticRegistry,
  EntityKind,
  InMemoryEventBus,
  asApplicationId,
  asEngineId,
  type DiagnosticObservation,
  type EngineEvent,
} from '../src';
import { FakeClock } from './support/fake-clock';

const engineId = asEngineId('engine-1');
const source = {
  engineId,
  entityType: EntityKind.Application,
  entityId: asApplicationId('application-1'),
} as const;

const observation = (overrides: Partial<DiagnosticObservation> = {}): DiagnosticObservation => ({
  category: 'Application',
  sourceId: 'application-1',
  ownerScope: 'application-calculation',
  code: 'FAILED_CLOSED',
  severity: 'warning',
  message: 'Failed closed condition detected',
  retention: 'condition',
  source,
  details: { difference: 42 },
  ...overrides,
});

const setup = () => {
  const clock = new FakeClock(1_000, 0);
  const bus = new InMemoryEventBus();
  const events: EngineEvent[] = [];
  bus.subscribe('diagnostic.*', (event) => events.push(event));
  return { clock, events, registry: new DiagnosticRegistry(clock, bus) };
};

describe('DIAG-01 first condition observation', () => {
  it('creates one active record and emits diagnostic.raised', () => {
    const { events, registry } = setup();

    const diagnostic = registry.observe(observation());

    expect(diagnostic).toMatchObject({
      firstRaisedTs: 1_000,
      lastUpdatedTs: 1_000,
      lastObservedTs: 1_000,
      occurrenceCount: 1,
    });
    expect(registry.records()).toEqual([diagnostic]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'diagnostic.raised',
      timestamp: 1_000,
      data: { category: 'Application', code: 'FAILED_CLOSED' },
    });
  });
});

describe('DIAG-02 material condition updates', () => {
  it('updates severity, message, and details and emits diagnostic.updated', () => {
    const { clock, events, registry } = setup();
    registry.observe(observation());
    clock.advanceWallBy(50);

    const diagnostic = registry.observe(
      observation({
        severity: 'error',
        message: 'Failed closed threshold exceeded',
        details: { difference: 55 },
      }),
    );

    expect(diagnostic).toMatchObject({
      severity: 'error',
      lastUpdatedTs: 1_050,
      lastObservedTs: 1_050,
      occurrenceCount: 2,
    });
    expect(events.map((event) => event.type)).toEqual(['diagnostic.raised', 'diagnostic.updated']);
  });
});

describe('DIAG-03 identical observations', () => {
  it('updates observation metadata without publishing another event', () => {
    const { clock, events, registry } = setup();
    registry.observe(observation());
    clock.advanceWallBy(50);

    const diagnostic = registry.observe(observation({ details: { difference: 42 } }));

    expect(diagnostic).toMatchObject({
      firstRaisedTs: 1_000,
      lastUpdatedTs: 1_000,
      lastObservedTs: 1_050,
      occurrenceCount: 2,
    });
    expect(events.map((event) => event.type)).toEqual(['diagnostic.raised']);
  });
});

describe('DIAG-04 explicit clear', () => {
  it('removes a condition and emits diagnostic.cleared only once', () => {
    const { clock, events, registry } = setup();
    const input = observation();
    registry.observe(input);
    clock.advanceWallBy(50);

    expect(registry.clear(input)).toBe(true);
    expect(registry.clear(input)).toBe(false);
    expect(registry.records()).toEqual([]);
    expect(events.map((event) => event.type)).toEqual(['diagnostic.raised', 'diagnostic.cleared']);
    expect(events[1]).toMatchObject({ timestamp: 1_050, data: { code: 'FAILED_CLOSED' } });
  });
});

describe('diagnostic persistence DTOs', () => {
  it('clones condition records and excludes session records', () => {
    const { registry } = setup();
    registry.observe(observation());
    registry.observe(
      observation({
        category: 'Common',
        sourceId: 'engine-1',
        ownerScope: 'engine-lifecycle',
        code: 'SYSTEM_STARTED',
        retention: 'session',
        source: { engineId },
      }),
    );

    const persisted = registry.toPersistence();
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.retention).toBe('condition');

    const mutableDetails = persisted[0]?.details as { difference?: number } | undefined;
    if (mutableDetails !== undefined) {
      mutableDetails.difference = 0;
    }
    expect(registry.toPersistence()[0]?.details).toEqual({ difference: 42 });
  });
});
