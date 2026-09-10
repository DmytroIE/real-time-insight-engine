import { describe, expect, it } from 'vitest';

import { InMemoryEventBus, asEngineId, matchesEventPattern, type EngineEvent } from '../src';

const lifecycleEvent = (engineId: string, timestamp: number): EngineEvent => ({
  type: 'engine.lifecycle',
  timestamp,
  source: { engineId: asEngineId(engineId) },
  data: { state: 'starting', ready: false, sessionId: 'session-1', cleanSession: false },
});

describe('EVT-01 Engine event delivery', () => {
  it('preserves publication order, including reentrant publication, and isolates listener failures', () => {
    const bus = new InMemoryEventBus();
    const received: string[] = [];

    bus.subscribe('*', (event) => {
      received.push(`first:${event.timestamp}`);
      if (event.timestamp === 1) {
        bus.publish(lifecycleEvent('engine-1', 2));
      }
    });
    bus.subscribe('*', () => {
      throw new Error('listener failed');
    });
    bus.subscribe('*', (event) => received.push(`last:${event.timestamp}`));

    expect(() => bus.publish(lifecycleEvent('engine-1', 1))).not.toThrow();
    expect(received).toEqual(['first:1', 'last:1', 'first:2', 'last:2']);
  });

  it('matches exact, namespace wildcard, and global wildcard patterns', () => {
    expect(matchesEventPattern('entity.updated', 'entity.updated')).toBe(true);
    expect(matchesEventPattern('diagnostic.*', 'diagnostic.raised')).toBe(true);
    expect(matchesEventPattern('diagnostic.*', 'engine.error')).toBe(false);
    expect(matchesEventPattern('*', 'engine.ready')).toBe(true);
  });
});

describe('EVT-02 Engine event cleanup and isolation', () => {
  it('unsubscribes listeners and removes all listeners on close', () => {
    const bus = new InMemoryEventBus();
    const timestamps: number[] = [];
    const unsubscribe = bus.subscribe('*', (event) => timestamps.push(event.timestamp));

    bus.publish(lifecycleEvent('engine-1', 1));
    unsubscribe();
    unsubscribe();
    bus.publish(lifecycleEvent('engine-1', 2));

    const closeOnlyTimestamps: number[] = [];
    bus.subscribe('*', (event) => closeOnlyTimestamps.push(event.timestamp));
    bus.close();
    bus.close();
    bus.publish(lifecycleEvent('engine-1', 3));

    expect(timestamps).toEqual([1]);
    expect(closeOnlyTimestamps).toEqual([]);
    expect(() => bus.subscribe('*', () => undefined)).toThrow(/closed event bus/);
  });

  it('keeps event delivery scoped to each bus instance', () => {
    const firstBus = new InMemoryEventBus();
    const secondBus = new InMemoryEventBus();
    const firstEvents: EngineEvent[] = [];
    const secondEvents: EngineEvent[] = [];
    firstBus.subscribe('*', (event) => firstEvents.push(event));
    secondBus.subscribe('*', (event) => secondEvents.push(event));

    firstBus.publish(lifecycleEvent('engine-1', 1));

    expect(firstEvents).toHaveLength(1);
    expect(secondEvents).toHaveLength(0);
  });
});
