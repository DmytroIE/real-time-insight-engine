import type { Engine, EngineEvent, EventPattern, Unsubscribe } from '@sxs/industrial-core';
import type { Node, NodeAPI, NodeDef, NodeMessage } from 'node-red';

import type { IndustrialEngineNode } from './industrial-engine';
import { ENGINE_MESSAGE_RECEIVER_NODE_TYPE } from './node-types';

export interface EngineMessageReceiverNodeConfiguration extends NodeDef {
  readonly engine: string;
  readonly eventPatterns?: string | readonly string[];
}

export interface EngineMessageReceiver {
  close(): void;
}

export interface ReceiverTimerScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface EngineMessageReceiverOptions {
  readonly now?: () => number;
  readonly timers?: ReceiverTimerScheduler;
  readonly trailingDelayMs?: number;
  readonly maximumDelayMs?: number;
}

export const DEFAULT_RECEIVER_TRAILING_DELAY_MS = 100;
export const DEFAULT_RECEIVER_MAXIMUM_DELAY_MS = 500;

const systemTimers: ReceiverTimerScheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

interface PendingDelivery {
  event: EngineEvent;
  readonly firstObservedAt: number;
  timer: unknown;
}

const isCoalescible = (event: EngineEvent): boolean => event.type === 'entity.updated';

const deliveryKey = (event: EngineEvent): string => {
  if (!('entityType' in event.source)) {
    throw new Error(`Event ${event.type} does not have an entity source`);
  }
  return JSON.stringify([event.type, event.source.entityType, event.source.entityId]);
};

export const parseEventPatterns = (
  value: string | readonly string[] | undefined,
): readonly EventPattern[] => {
  const patterns = (typeof value === 'string' ? value.split(/[\n,]/) : (value ?? []))
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern.length > 0);
  return patterns.length === 0 ? ['*'] : ([...new Set(patterns)] as EventPattern[]);
};

export const toReceiverMessage = (event: EngineEvent): NodeMessage => {
  const source = {
    engineId: event.source.engineId,
    ...('entityType' in event.source
      ? {
          entityType: event.source.entityType,
          entityId: event.source.entityId,
          ...('pluginType' in event.source && event.source.pluginType !== undefined
            ? { pluginType: event.source.pluginType }
            : {}),
        }
      : {}),
  };
  return {
    topic: event.type,
    event: {
      type: event.type,
      timestamp: event.timestamp,
      source,
      ...('data' in event ? { data: structuredClone(event.data) } : {}),
    },
  };
};

export const createEngineMessageReceiver = (
  node: Pick<Node, 'send'>,
  engine: Pick<Engine, 'subscribe'>,
  patterns: EventPattern | readonly EventPattern[],
  options: EngineMessageReceiverOptions = {},
): EngineMessageReceiver => {
  const now = options.now ?? (() => performance.now());
  const timers = options.timers ?? systemTimers;
  const trailingDelayMs = options.trailingDelayMs ?? DEFAULT_RECEIVER_TRAILING_DELAY_MS;
  const maximumDelayMs = options.maximumDelayMs ?? DEFAULT_RECEIVER_MAXIMUM_DELAY_MS;
  const pending = new Map<string, PendingDelivery>();
  const send = (event: EngineEvent): void => {
    node.send(toReceiverMessage(event));
  };
  const flush = (key: string): void => {
    const delivery = pending.get(key);
    if (delivery === undefined) {
      return;
    }
    pending.delete(key);
    send(delivery.event);
  };
  let unsubscribe: Unsubscribe | undefined = engine.subscribe(patterns, (event) => {
    if (!isCoalescible(event)) {
      send(event);
      return;
    }

    const key = deliveryKey(event);
    const observedAt = now();
    const current = pending.get(key);
    if (current !== undefined) {
      timers.clearTimeout(current.timer);
    }
    const delivery: PendingDelivery = {
      event,
      firstObservedAt: current?.firstObservedAt ?? observedAt,
      timer: undefined,
    };
    pending.set(key, delivery);
    const maximumRemaining = delivery.firstObservedAt + maximumDelayMs - observedAt;
    delivery.timer = timers.setTimeout(
      () => flush(key),
      Math.max(0, Math.min(trailingDelayMs, maximumRemaining)),
    );
  });
  return {
    close: () => {
      unsubscribe?.();
      unsubscribe = undefined;
      for (const delivery of pending.values()) {
        timers.clearTimeout(delivery.timer);
      }
      pending.clear();
    },
  };
};

export const registerEngineMessageReceiverNode = (RED: NodeAPI): void => {
  function EngineMessageReceiverNode(
    this: Node,
    config: EngineMessageReceiverNodeConfiguration,
  ): void {
    RED.nodes.createNode(this, config);
    const engineNode = RED.nodes.getNode(config.engine) as IndustrialEngineNode | null;
    let receiver: EngineMessageReceiver | undefined;
    let closed = false;

    if (engineNode === null) {
      this.status({ fill: 'red', shape: 'ring', text: 'engine unavailable' });
      this.error('Configured Industrial Engine node is unavailable');
    } else {
      this.status({ fill: 'yellow', shape: 'ring', text: 'connecting' });
      void engineNode.ready
        .then((engine) => {
          if (closed) {
            return;
          }
          receiver = createEngineMessageReceiver(
            this,
            engine,
            parseEventPatterns(config.eventPatterns),
          );
          this.status({ fill: 'green', shape: 'dot', text: 'connected' });
        })
        .catch((error: unknown) => {
          if (!closed) {
            this.status({ fill: 'red', shape: 'ring', text: 'failed' });
            this.error(error instanceof Error ? error.message : String(error));
          }
        });
    }

    this.on('close', (_removed: boolean, done: () => void) => {
      closed = true;
      receiver?.close();
      done();
    });
  }

  RED.nodes.registerType(ENGINE_MESSAGE_RECEIVER_NODE_TYPE, EngineMessageReceiverNode);
};
