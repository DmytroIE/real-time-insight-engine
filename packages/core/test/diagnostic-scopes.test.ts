import { describe, expect, it } from 'vitest';

import {
  DiagnosticRegistry,
  EntityKind,
  InMemoryEventBus,
  asApplicationId,
  asEngineId,
  type DiagnosticObservation,
  type DiagnosticScopeIdentity,
  type EngineEvent,
} from '../src';
import { FakeClock } from './support/fake-clock';

const engineId = asEngineId('engine-1');
const source = {
  engineId,
  entityType: EntityKind.Application,
  entityId: asApplicationId('application-1'),
} as const;

const scopeIdentity = (ownerScope: string): DiagnosticScopeIdentity => ({
  category: 'Application',
  sourceId: 'application-1',
  ownerScope,
  source,
});

const observation = (
  ownerScope: string,
  code: string,
  overrides: Partial<DiagnosticObservation> = {},
): DiagnosticObservation => ({
  ...scopeIdentity(ownerScope),
  code,
  severity: 'warning',
  message: `${code} detected`,
  retention: 'condition',
  ...overrides,
});

const setup = () => {
  const clock = new FakeClock(1_000, 0);
  const bus = new InMemoryEventBus();
  const events: EngineEvent[] = [];
  bus.subscribe('diagnostic.*', (event) => events.push(event));
  return { bus, clock, events, registry: new DiagnosticRegistry(clock, bus) };
};

describe('DIAG-05 successful scope reconciliation', () => {
  it('clears every omitted condition previously owned by an empty successful scope', () => {
    const { events, registry } = setup();
    registry.observe(observation('plugin', 'FAILED_CLOSED'));
    registry.observe(observation('plugin', 'NO_DATA'));

    registry.createScope(scopeIdentity('plugin')).complete();

    expect(registry.records()).toEqual([]);
    expect(events.map((event) => event.type)).toEqual([
      'diagnostic.raised',
      'diagnostic.raised',
      'diagnostic.cleared',
      'diagnostic.cleared',
    ]);
  });
});

describe('DIAG-06 failed scope evaluation', () => {
  it('discards incomplete reports and retains prior conditions when evaluation throws', async () => {
    const { events, registry } = setup();
    registry.observe(observation('plugin', 'FAILED_CLOSED'));

    await expect(
      registry.evaluateScope(scopeIdentity('plugin'), (reporter) => {
        reporter.report({ code: 'NO_DATA', severity: 'error', message: 'No data' });
        throw new Error('evaluation failed');
      }),
    ).rejects.toThrow('evaluation failed');

    expect(registry.records().map(({ code }) => code)).toEqual(['FAILED_CLOSED']);
    expect(events.map((event) => event.type)).toEqual(['diagnostic.raised']);
  });
});

describe('DIAG-07 owner-scope isolation', () => {
  it('cannot update or clear another owner scope with the same diagnostic code', () => {
    const { registry } = setup();
    const first = registry.observe(observation('plugin', 'NO_DATA'));

    const schedulerScope = registry.createScope(scopeIdentity('scheduler'));
    schedulerScope.report({
      code: 'NO_DATA',
      severity: 'error',
      message: 'Scheduler found no data',
    });
    schedulerScope.complete();

    expect(registry.get(observation('plugin', 'NO_DATA'))).toEqual(first);
    expect(registry.records()).toHaveLength(2);

    registry.createScope(scopeIdentity('scheduler')).complete();
    expect(registry.records()).toEqual([first]);
  });
});

describe('DIAG-08 session restart retention', () => {
  it('restores condition diagnostics and discards session diagnostics', () => {
    const { bus, clock, registry } = setup();
    const condition = registry.observe(observation('plugin', 'FAILED_CLOSED'));
    registry.observe(
      observation('engine-lifecycle', 'SYSTEM_STARTED', {
        category: 'Common',
        sourceId: 'engine-1',
        source: { engineId },
        retention: 'session',
      }),
    );

    const restored = new DiagnosticRegistry(clock, bus, registry.records());

    expect(restored.records()).toEqual([condition]);
    expect(restored.toPersistence()).toEqual([condition]);
  });
});
