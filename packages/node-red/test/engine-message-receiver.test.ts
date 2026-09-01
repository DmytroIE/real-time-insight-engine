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
    data: { state: 'ready', ready: true, sessionId: 'session-1' },
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
    now: () => this.#now,
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
    runtime.advanceBy(100);

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
    runtime.advanceBy(100);
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
        data: { state: 'ready', ready: true, sessionId: 'session-1' },
      }),
    });
  });

  it('NR-17 close removes its listener and leaves no pending timers', () => {
    const source = new ReplayEventSource();
    const node = testNode();
    const runtime = new TestDeliveryRuntime();
    const receiver = createEngineMessageReceiver(
      node as unknown as Pick<Node, 'send'>,
      source,
      'entity.updated',
      runtime.options,
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

  it('NR-18 delivers lifecycle and diagnostic transitions immediately and in order', () => {
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
      'diagnostic.raised',
      'diagnostic.updated',
      'diagnostic.cleared',
    ]);
    runtime.advanceBy(100);
    expect(node.send.mock.calls.at(-1)?.[0].topic).toBe('entity.updated');
  });

  it('NR-19 retains only the latest eligible event for each event/source key', () => {
    const source = new ReplayEventSource();
    const node = testNode();
    const runtime = new TestDeliveryRuntime();
    createEngineMessageReceiver(
      node as unknown as Pick<Node, 'send'>,
      source,
      'entity.updated',
      runtime.options,
    );

    source.publish(entityEvent('asset-1/application-1', 1_100));
    runtime.advanceBy(50);
    source.publish(entityEvent('asset-1/application-1', 1_200));
    runtime.advanceBy(99);
    expect(node.send).not.toHaveBeenCalled();
    runtime.advanceBy(1);

    expect(node.send).toHaveBeenCalledOnce();
    expect(node.send.mock.calls[0]?.[0].event.timestamp).toBe(1_200);
  });

  it('NR-20 uses a 100 ms trailing delay capped at 500 ms', () => {
    const source = new ReplayEventSource();
    const node = testNode();
    const runtime = new TestDeliveryRuntime();
    createEngineMessageReceiver(
      node as unknown as Pick<Node, 'send'>,
      source,
      'entity.updated',
      runtime.options,
    );

    source.publish(entityEvent('asset-1/application-1', 1));
    runtime.advanceBy(99);
    expect(node.send).not.toHaveBeenCalled();
    runtime.advanceBy(1);
    expect(node.send).toHaveBeenCalledOnce();

    node.send.mockClear();
    source.publish(entityEvent('asset-1/application-1', 2));
    for (let index = 3; index <= 7; index += 1) {
      runtime.advanceBy(90);
      source.publish(entityEvent('asset-1/application-1', index));
    }
    runtime.advanceBy(49);
    expect(node.send).not.toHaveBeenCalled();
    runtime.advanceBy(1);

    expect(node.send).toHaveBeenCalledOnce();
    expect(node.send.mock.calls[0]?.[0].event.timestamp).toBe(7);
  });

  it('NR-21 isolates source buffers and never delays noncoalescible events', () => {
    const source = new ReplayEventSource();
    const node = testNode();
    const runtime = new TestDeliveryRuntime();
    createEngineMessageReceiver(
      node as unknown as Pick<Node, 'send'>,
      source,
      '*',
      runtime.options,
    );
    node.send.mockClear();

    source.publish(entityEvent('asset-1/application-1', 1_100));
    runtime.advanceBy(50);
    source.publish(entityEvent('asset-2/application-1', 1_200));
    source.publish(diagnosticEvent());
    expect(node.send.mock.calls.map(([message]) => message.topic)).toEqual(['diagnostic.raised']);

    runtime.advanceBy(50);
    expect(node.send.mock.calls[1]?.[0].event.source.entityId).toBe('asset-1/application-1');
    runtime.advanceBy(50);
    expect(node.send.mock.calls[2]?.[0].event.source.entityId).toBe('asset-2/application-1');
  });
});
