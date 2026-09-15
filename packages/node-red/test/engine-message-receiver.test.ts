import { describe, expect, it, vi } from 'vitest';

import {
  asApplicationId,
  asEngineId,
  EntityKind,
  matchesEventPattern,
  type DiagnosticEvent,
  type EngineEvent,
  type EngineLifecycleEvent,
  type EventListener,
  type EventPattern,
  type Unsubscribe,
} from '@sxs/industrial-core';
import type { Node } from 'node-red';

import {
  createEngineMessageReceiver,
  parseEventPatterns,
  type EngineMessageReceiverOptions,
  type ReceiverTimerScheduler,
} from '../src/engine-message-receiver';

interface Subscription {
  readonly patterns: readonly EventPattern[];
  readonly listener: EventListener;
}

class ReplayEventSource {
  readonly #subscriptions = new Set<Subscription>();
  readonly #lifecycle: EngineLifecycleEvent = {
    type: 'engine.lifecycle',
    timestamp: 1_000,
    source: { engineId: asEngineId('engine-1') },
    data: {
      state: 'ready',
      ready: true,
      sessionId: 'session-1',
      sessionStartTimestamp: 1_000,
      cleanSession: false,
    },
  };

  public get activeSubscriptions(): number {
    return this.#subscriptions.size;
  }

  public subscribe(
    patterns: EventPattern | readonly EventPattern[],
    listener: EventListener,
  ): Unsubscribe {
    const subscription = {
      patterns: typeof patterns === 'string' ? [patterns] : [...patterns],
      listener,
    };
    this.#subscriptions.add(subscription);
    if (subscription.patterns.some((pattern) => matchesEventPattern(pattern, 'engine.lifecycle'))) {
      listener(structuredClone(this.#lifecycle));
    }
    return () => {
      this.#subscriptions.delete(subscription);
    };
  }

  public publish(event: EngineEvent): void {
    for (const subscription of this.#subscriptions) {
      if (subscription.patterns.some((pattern) => matchesEventPattern(pattern, event.type))) {
        subscription.listener(event);
      }
    }
  }
}

const entityEvent = (entityId = 'asset-1/application-1', timestamp = 1_100): EngineEvent => ({
  type: 'entity.updated',
  timestamp,
  source: {
    engineId: asEngineId('engine-1'),
    entityType: EntityKind.Application,
    entityId: asApplicationId(entityId),
  },
});

const diagnosticEvent = (): DiagnosticEvent => ({
  type: 'diagnostic.raised',
  timestamp: 1_200,
  source: { engineId: asEngineId('engine-1') },
  data: {
    category: 'Common',
    sourceId: 'engine-1',
    ownerScope: 'test',
    code: 'TEST',
    severity: 'warning',
    message: 'Test diagnostic',
    retention: 'condition',
    details: { count: 1 },
  },
});

const testNode = () => ({ send: vi.fn() });

interface ScheduledTask {
  readonly dueAt: number;
  readonly callback: () => void;
}

class TestDeliveryRuntime implements ReceiverTimerScheduler {
  readonly #tasks = new Map<number, ScheduledTask>();
  #nextHandle = 1;
  #now = 0;

  public readonly options: EngineMessageReceiverOptions = {
    timers: this,
  };

  public get pendingTimers(): number {
    return this.#tasks.size;
  }

  public setTimeout(callback: () => void, delayMs: number): number {
    const handle = this.#nextHandle++;
    this.#tasks.set(handle, { dueAt: this.#now + delayMs, callback });
    return handle;
  }

  public clearTimeout(handle: unknown): void {
    this.#tasks.delete(handle as number);
  }

  public advanceBy(durationMs: number): void {
    const target = this.#now + durationMs;
    while (true) {
      const next = [...this.#tasks.entries()]
        .filter(([, task]) => task.dueAt <= target)
        .sort(([leftHandle, left], [rightHandle, right]) =>
          left.dueAt === right.dueAt ? leftHandle - rightHandle : left.dueAt - right.dueAt,
        )[0];
      if (next === undefined) {
        break;
      }
      const [handle, task] = next;
      this.#tasks.delete(handle);
      this.#now = task.dueAt;
      task.callback();
    }
    this.#now = target;
  }
}

describe('Engine Message Receiver', () => {
  it('NR-13 filters exact and wildcard patterns through one output', () => {
    const source = new ReplayEventSource();
    const node = testNode();
    const runtime = new TestDeliveryRuntime();
    createEngineMessageReceiver(
      node as unknown as Pick<Node, 'send'>,
      source,
      parseEventPatterns('entity.updated, diagnostic.*'),
      runtime.options,
    );

    source.publish(diagnosticEvent());
    source.publish(entityEvent());
    source.publish({
      type: 'engine.error',
      timestamp: 1_300,
      source: { engineId: asEngineId('engine-1') },
      data: { message: 'ignored' },
    });
    expect(node.send).toHaveBeenCalledTimes(2);
    expect(node.send.mock.calls.map(([message]) => message.topic)).toEqual([
      'diagnostic.raised',
      'entity.updated',
    ]);
    expect(node.send.mock.calls.every(([message]) => !Array.isArray(message))).toBe(true);
  });

  it('NR-14 emits only a detached serializable event envelope', () => {
    const source = new ReplayEventSource();
    const node = testNode();
    createEngineMessageReceiver(node as unknown as Pick<Node, 'send'>, source, 'diagnostic.*');
    const event = diagnosticEvent();

    source.publish(
      Object.assign(event, {
        state: { currState: 2 },
        liveInstance: new Map([['unsafe', true]]),
      }) as EngineEvent,
    );
    const message = node.send.mock.calls[0]?.[0];

    expect(message).toEqual({
      topic: 'diagnostic.raised',
      event: {
        type: 'diagnostic.raised',
        timestamp: 1_200,
        source: { engineId: 'engine-1' },
        data: event.data,
      },
    });
    expect(message.event).not.toHaveProperty('state');
    expect(message.event).not.toHaveProperty('liveInstance');
    expect(() => JSON.stringify(message)).not.toThrow();
    expect(message.event).not.toBe(event);
    expect(message.event.data).not.toBe(event.data);
  });

  it('NR-15 keeps multiple Receiver subscriptions independent', () => {
    const source = new ReplayEventSource();
    const entityNode = testNode();
    const diagnosticNode = testNode();
    const runtime = new TestDeliveryRuntime();
    const entityReceiver = createEngineMessageReceiver(
      entityNode as unknown as Pick<Node, 'send'>,
      source,
      'entity.updated',
      runtime.options,
    );
    createEngineMessageReceiver(
      diagnosticNode as unknown as Pick<Node, 'send'>,
      source,
      'diagnostic.*',
      runtime.options,
    );

    source.publish(entityEvent());
    source.publish(diagnosticEvent());
    entityReceiver.close();
    source.publish(diagnosticEvent());

    expect(entityNode.send).toHaveBeenCalledTimes(1);
    expect(diagnosticNode.send).toHaveBeenCalledTimes(2);
    expect(source.activeSubscriptions).toBe(1);
  });

  it('NR-16 immediately replays current engine.lifecycle', () => {
    const source = new ReplayEventSource();
    const node = testNode();

    createEngineMessageReceiver(node as unknown as Pick<Node, 'send'>, source, 'engine.lifecycle');

    expect(node.send).toHaveBeenCalledOnce();
    expect(node.send).toHaveBeenCalledWith({
      topic: 'engine.lifecycle',
      event: expect.objectContaining({
        type: 'engine.lifecycle',
        data: {
          state: 'ready',
          ready: true,
          sessionId: 'session-1',
          sessionStartTimestamp: 1_000,
          cleanSession: false,
        },
      }),
    });
  });

  it('NR-17 close removes its listener and clears its pending batch timer', () => {
    const source = new ReplayEventSource();
    const node = testNode();
    const runtime = new TestDeliveryRuntime();
    const receiver = createEngineMessageReceiver(
      node as unknown as Pick<Node, 'send'>,
      source,
      'entity.updated',
      { ...runtime.options, batchMode: true },
    );
    source.publish(entityEvent());

    expect(runtime.pendingTimers).toBe(1);
    receiver.close();
    receiver.close();
    runtime.advanceBy(500);

    expect(source.activeSubscriptions).toBe(0);
    expect(node.send).not.toHaveBeenCalled();
    expect(runtime.pendingTimers).toBe(0);
  });

  it('NR-18 immediately delivers every matching event in publication order', () => {
    const source = new ReplayEventSource();
    const node = testNode();
    const runtime = new TestDeliveryRuntime();
    createEngineMessageReceiver(
      node as unknown as Pick<Node, 'send'>,
      source,
      '*',
      runtime.options,
    );
    source.publish(entityEvent());
    for (const type of ['diagnostic.raised', 'diagnostic.updated', 'diagnostic.cleared'] as const) {
      source.publish({ ...diagnosticEvent(), type });
    }

    expect(node.send.mock.calls.map(([message]) => message.topic)).toEqual([
      'engine.lifecycle',
      'entity.updated',
      'diagnostic.raised',
      'diagnostic.updated',
      'diagnostic.cleared',
    ]);
    expect(node.send.mock.calls.at(-1)?.[0].topic).toBe('diagnostic.cleared');
  });

  it('NR-19 batches matching events in arrival order over a fixed window', () => {
    const source = new ReplayEventSource();
    const node = testNode();
    const runtime = new TestDeliveryRuntime();
    createEngineMessageReceiver(node as unknown as Pick<Node, 'send'>, source, '*', {
      ...runtime.options,
      batchMode: true,
      batchWindowMs: 1_000,
      batchMaxEvents: 10,
    });

    source.publish(entityEvent('asset-1/application-1', 1_100));
    runtime.advanceBy(50);
    source.publish(diagnosticEvent());
    runtime.advanceBy(949);
    expect(node.send).not.toHaveBeenCalled();
    runtime.advanceBy(1);

    expect(node.send).toHaveBeenCalledOnce();
    expect(node.send.mock.calls[0]?.[0]).toMatchObject({
      topic: 'engine.event-batch',
      event: {
        type: 'engine.event-batch',
        data: {
          droppedEventCount: 0,
          events: expect.arrayContaining([
            expect.objectContaining({ type: 'entity.updated' }),
            expect.objectContaining({ type: 'diagnostic.raised' }),
          ]),
        },
      },
    });
  });

  it('NR-20 removes oldest events and reports the count when a batch reaches its limit', () => {
    const source = new ReplayEventSource();
    const node = testNode();
    const runtime = new TestDeliveryRuntime();
    createEngineMessageReceiver(node as unknown as Pick<Node, 'send'>, source, 'entity.updated', {
      ...runtime.options,
      batchMode: true,
      batchWindowMs: 1_000,
      batchMaxEvents: 2,
    });

    source.publish(entityEvent('asset-1/application-1', 1));
    source.publish(entityEvent('asset-1/application-1', 2));
    source.publish(entityEvent('asset-1/application-1', 3));
    runtime.advanceBy(1_000);

    expect(node.send).toHaveBeenCalledOnce();
    expect(node.send.mock.calls[0]?.[0].event.data).toMatchObject({
      droppedEventCount: 1,
      events: [{ timestamp: 2 }, { timestamp: 3 }],
    });
  });

  it('NR-21 starts its next fixed window only after the previous batch is delivered', () => {
    const source = new ReplayEventSource();
    const node = testNode();
    const runtime = new TestDeliveryRuntime();
    createEngineMessageReceiver(node as unknown as Pick<Node, 'send'>, source, 'entity.updated', {
      ...runtime.options,
      batchMode: true,
      batchWindowMs: 1_000,
    });

    source.publish(entityEvent('asset-1/application-1', 1_100));
    runtime.advanceBy(1_000);
    source.publish(entityEvent('asset-2/application-1', 1_200));
    runtime.advanceBy(999);
    expect(node.send).toHaveBeenCalledOnce();
    runtime.advanceBy(1);
    expect(node.send).toHaveBeenCalledTimes(2);
  });

  it('rejects batch settings outside the configured limits', () => {
    const source = new ReplayEventSource();
    const node = testNode();
    const runtime = new TestDeliveryRuntime();

    expect(() =>
      createEngineMessageReceiver(node as unknown as Pick<Node, 'send'>, source, '*', {
        ...runtime.options,
        batchMode: true,
        batchWindowMs: 999,
      }),
    ).toThrow('Expected an integer between 1000 and 10000');
    expect(() =>
      createEngineMessageReceiver(node as unknown as Pick<Node, 'send'>, source, '*', {
        ...runtime.options,
        batchMode: true,
        batchMaxEvents: 101,
      }),
    ).toThrow('Expected an integer between 2 and 100');
  });
});
