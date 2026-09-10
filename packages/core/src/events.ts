import type { EngineId, PluginTypeId } from './identifiers';
import type { EntityId, EntityKind } from './model';
import type { DiagnosticCategory, DiagnosticRetention } from './diagnostics';

export type EngineEventType = EngineEvent['type'];
export type EventPattern = EngineEventType | `${string}.*` | '*';

export interface EngineEventSource {
  readonly engineId: EngineId;
}

export interface EntityEventSource extends EngineEventSource {
  readonly entityType: EntityKind;
  readonly entityId: EntityId;
  readonly entityName?: string;
  readonly pluginType?: PluginTypeId;
}

export type EngineLifecycleState = 'starting' | 'ready' | 'resetting' | 'failed' | 'stopping';
export type DiagnosticSeverity = 'error' | 'warning' | 'info';

interface EventEnvelope<Type extends string, Source extends EngineEventSource> {
  readonly type: Type;
  readonly timestamp: number;
  readonly source: Source;
}

export type EntityUpdatedEvent = EventEnvelope<'entity.updated', EntityEventSource>;

export type EngineLifecycleData =
  | {
      readonly state: 'ready';
      readonly ready: true;
      readonly sessionId: string;
      readonly cleanSession: boolean;
    }
  | {
      readonly state: Exclude<EngineLifecycleState, 'ready'>;
      readonly ready: false;
      readonly sessionId: string;
      readonly cleanSession: boolean;
    };

export interface EngineLifecycleEvent extends EventEnvelope<'engine.lifecycle', EngineEventSource> {
  readonly data: EngineLifecycleData;
}

export interface EngineReadyEvent extends EventEnvelope<'engine.ready', EngineEventSource> {
  readonly data: {
    readonly ready: true;
    readonly sessionId: string;
    readonly cleanSession: boolean;
  };
}

export interface DiagnosticEventData {
  readonly category: DiagnosticCategory;
  readonly sourceId: string;
  readonly ownerScope: string;
  readonly code: string;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  readonly retention: DiagnosticRetention;
  readonly details?: Readonly<Record<string, unknown>>;
}

export type DiagnosticEvent =
  | (EventEnvelope<'diagnostic.raised', EngineEventSource | EntityEventSource> & {
      readonly data: DiagnosticEventData;
    })
  | (EventEnvelope<'diagnostic.updated', EngineEventSource | EntityEventSource> & {
      readonly data: DiagnosticEventData;
    })
  | (EventEnvelope<'diagnostic.cleared', EngineEventSource | EntityEventSource> & {
      readonly data: DiagnosticEventData;
    })
  | (EventEnvelope<'diagnostic.notified', EngineEventSource | EntityEventSource> & {
      readonly data: DiagnosticEventData;
    });

export interface EngineErrorEvent extends EventEnvelope<'engine.error', EngineEventSource> {
  readonly data: {
    readonly message: string;
  };
}

export type EngineEvent =
  EntityUpdatedEvent | EngineLifecycleEvent | EngineReadyEvent | DiagnosticEvent | EngineErrorEvent;

export type EventListener = (event: EngineEvent) => void;
export type Unsubscribe = () => void;

export interface EventSink {
  publish(event: EngineEvent): void;
}

export const matchesEventPattern = (pattern: EventPattern, eventType: EngineEventType): boolean => {
  if (pattern === '*' || pattern === eventType) {
    return true;
  }

  return pattern.endsWith('.*') && eventType.startsWith(pattern.slice(0, -1));
};

interface Subscription {
  readonly patterns: readonly EventPattern[];
  readonly listener: EventListener;
}

export class InMemoryEventBus implements EventSink {
  readonly #subscriptions = new Set<Subscription>();
  readonly #queue: EngineEvent[] = [];
  #publishing = false;
  #closed = false;

  public subscribe(
    patterns: EventPattern | readonly EventPattern[],
    listener: EventListener,
  ): Unsubscribe {
    if (this.#closed) {
      throw new Error('Cannot subscribe to a closed event bus');
    }

    const subscription: Subscription = {
      patterns: typeof patterns === 'string' ? [patterns] : [...patterns],
      listener,
    };
    this.#subscriptions.add(subscription);

    return () => {
      this.#subscriptions.delete(subscription);
    };
  }

  public publish(event: EngineEvent): void {
    if (this.#closed) {
      return;
    }

    this.#queue.push(event);
    if (this.#publishing) {
      return;
    }

    this.#publishing = true;
    try {
      while (this.#queue.length > 0) {
        const nextEvent = this.#queue.shift();
        if (nextEvent !== undefined) {
          this.deliver(nextEvent);
        }
      }
    } finally {
      this.#publishing = false;
    }
  }

  public close(): void {
    this.#closed = true;
    this.#queue.length = 0;
    this.#subscriptions.clear();
  }

  private deliver(event: EngineEvent): void {
    for (const subscription of [...this.#subscriptions]) {
      if (!subscription.patterns.some((pattern) => matchesEventPattern(pattern, event.type))) {
        continue;
      }

      try {
        subscription.listener(event);
      } catch {
        // One consumer must not interrupt ordered delivery to the remaining consumers.
      }
    }
  }
}
