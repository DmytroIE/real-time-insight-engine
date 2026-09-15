import type { Engine, EngineEvent, EventPattern, Unsubscribe } from '@sxs/industrial-core';
import type { Node, NodeAPI, NodeDef, NodeMessage } from 'node-red';

import type { IndustrialEngineNode } from './industrial-engine';
import { ENGINE_MESSAGE_RECEIVER_NODE_TYPE } from './node-types';

export interface EngineMessageReceiverNodeConfiguration extends NodeDef {
  readonly engine: string;
  readonly eventPatterns?: string | readonly string[];
  readonly batchMode?: boolean;
  readonly batchWindowMs?: number;
  readonly batchMaxEvents?: number;
}

export interface EngineMessageReceiver {
  close(): void;
}

export interface ReceiverTimerScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface EngineMessageReceiverOptions {
  readonly timers?: ReceiverTimerScheduler;
  readonly batchMode?: boolean;
  readonly batchWindowMs?: number;
  readonly batchMaxEvents?: number;
}

export const MIN_RECEIVER_BATCH_WINDOW_MS = 1_000;
export const MAX_RECEIVER_BATCH_WINDOW_MS = 10_000;
export const DEFAULT_RECEIVER_BATCH_WINDOW_MS = 1_000;
export const MIN_RECEIVER_BATCH_MAX_EVENTS = 2;
export const MAX_RECEIVER_BATCH_MAX_EVENTS = 100;
export const DEFAULT_RECEIVER_BATCH_MAX_EVENTS = 100;

const systemTimers: ReceiverTimerScheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

interface PendingBatch {
  readonly events: EngineEvent[];
  droppedEventCount: number;
  timer: unknown;
}

const boundedInteger = (
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number => {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < min || resolved > max) {
    throw new Error(`Expected an integer between ${min} and ${max}`);
  }
  return resolved;
};

const configuredInteger = (value: number): number => Number(value);

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

const toBatchReceiverMessage = (batch: PendingBatch): NodeMessage => {
  const first = batch.events[0];
  const last = batch.events.at(-1);
  if (first === undefined || last === undefined) {
    throw new Error('Cannot send an empty Engine event batch');
  }
  return {
    topic: 'engine.event-batch',
    event: {
      type: 'engine.event-batch',
      timestamp: last.timestamp,
      source: { engineId: first.source.engineId },
      data: {
        droppedEventCount: batch.droppedEventCount,
        events: batch.events.map((event) => toReceiverMessage(event).event),
      },
    },
  };
};

export const createEngineMessageReceiver = (
  node: Pick<Node, 'send'>,
  engine: Pick<Engine, 'subscribe'>,
  patterns: EventPattern | readonly EventPattern[],
  options: EngineMessageReceiverOptions = {},
): EngineMessageReceiver => {
  const timers = options.timers ?? systemTimers;
  const batchMode = options.batchMode ?? false;
  const batchWindowMs = boundedInteger(
    options.batchWindowMs,
    DEFAULT_RECEIVER_BATCH_WINDOW_MS,
    MIN_RECEIVER_BATCH_WINDOW_MS,
    MAX_RECEIVER_BATCH_WINDOW_MS,
  );
  const batchMaxEvents = boundedInteger(
    options.batchMaxEvents,
    DEFAULT_RECEIVER_BATCH_MAX_EVENTS,
    MIN_RECEIVER_BATCH_MAX_EVENTS,
    MAX_RECEIVER_BATCH_MAX_EVENTS,
  );
  let pending: PendingBatch | undefined;
  const send = (event: EngineEvent): void => {
    node.send(toReceiverMessage(event));
  };
  const flush = (): void => {
    const batch = pending;
    pending = undefined;
    if (batch === undefined) {
      return;
    }
    node.send(toBatchReceiverMessage(batch));
  };
  let unsubscribe: Unsubscribe | undefined = engine.subscribe(patterns, (event) => {
    if (!batchMode) {
      send(event);
      return;
    }

    if (pending === undefined) {
      pending = {
        events: [],
        droppedEventCount: 0,
        timer: timers.setTimeout(flush, batchWindowMs),
      };
    }
    pending.events.push(event);
    if (pending.events.length > batchMaxEvents) {
      pending.events.shift();
      pending.droppedEventCount += 1;
    }
  });
  return {
    close: () => {
      unsubscribe?.();
      unsubscribe = undefined;
      if (pending !== undefined) {
        timers.clearTimeout(pending.timer);
        pending = undefined;
      }
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
            {
              batchMode: config.batchMode === true,
              ...(config.batchWindowMs === undefined
                ? {}
                : { batchWindowMs: configuredInteger(config.batchWindowMs) }),
              ...(config.batchMaxEvents === undefined
                ? {}
                : { batchMaxEvents: configuredInteger(config.batchMaxEvents) }),
            },
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
