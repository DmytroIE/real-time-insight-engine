import {
  InMemoryEventBus,
  matchesEventPattern,
  type EngineLifecycleEvent,
  type EngineLifecycleState,
  type EventListener,
  type EventPattern,
  type Unsubscribe,
} from './events';
import type { EngineId } from './identifiers';
import type { Clock } from './time';

const includesLifecycle = (patterns: EventPattern | readonly EventPattern[]): boolean =>
  (typeof patterns === 'string' ? [patterns] : patterns).some((pattern) =>
    matchesEventPattern(pattern, 'engine.lifecycle'),
  );

export class EngineLifecycleController {
  readonly #eventBus = new InMemoryEventBus();
  readonly #engineId: EngineId;
  readonly #clock: Clock;
  #current: EngineLifecycleEvent;

  #sessionId: string;
  #sessionStartTs: number;
  #cleanSession: boolean;

  public constructor(
    engineId: EngineId,
    clock: Clock,
    listener?: EventListener,
    cleanSession = false,
  ) {
    this.#engineId = engineId;
    this.#clock = clock;
    this.#sessionStartTs = clock.wallTimeMs();
    this.#sessionId = String(this.#sessionStartTs);
    this.#cleanSession = cleanSession;
    this.#current = this.lifecycleEvent('starting');
    if (listener !== undefined) {
      this.#eventBus.subscribe(['engine.lifecycle', 'engine.ready'], listener);
    }
    this.#eventBus.publish(this.#current);
  }

  public get eventBus(): InMemoryEventBus {
    return this.#eventBus;
  }

  public get sessionId(): string {
    return this.#sessionId;
  }

  public get sessionStartTs(): number {
    return this.#sessionStartTs;
  }

  public get state(): EngineLifecycleState {
    return this.#current.data.state;
  }

  public get isReady(): boolean {
    return this.state === 'ready';
  }

  public subscribe(
    patterns: EventPattern | readonly EventPattern[],
    listener: EventListener,
  ): Unsubscribe {
    const unsubscribe = this.#eventBus.subscribe(patterns, listener);
    if (includesLifecycle(patterns)) {
      try {
        listener(structuredClone(this.#current));
      } catch {
        // Replay follows the bus contract: one listener cannot affect Engine behavior.
      }
    }
    return unsubscribe;
  }

  public transition(state: EngineLifecycleState): void {
    if (state === this.state) {
      return;
    }
    this.#current = this.lifecycleEvent(state);
    this.#eventBus.publish(this.#current);
    if (state === 'ready') {
      this.#eventBus.publish({
        type: 'engine.ready',
        timestamp: this.#clock.wallTimeMs(),
        source: { engineId: this.#engineId },
        data: { ready: true, sessionId: this.sessionId, cleanSession: this.#cleanSession },
      });
    }
  }

  public beginSession(): void {
    this.#sessionStartTs = this.#clock.wallTimeMs();
    this.#sessionId = String(this.#sessionStartTs);
    this.#cleanSession = false;
  }

  public close(): void {
    this.#eventBus.close();
  }

  private lifecycleEvent(state: EngineLifecycleState): EngineLifecycleEvent {
    const data =
      state === 'ready'
        ? {
            state,
            ready: true as const,
            sessionId: this.sessionId,
            cleanSession: this.#cleanSession,
          }
        : {
            state,
            ready: false as const,
            sessionId: this.sessionId,
            cleanSession: this.#cleanSession,
          };
    return {
      type: 'engine.lifecycle',
      timestamp: this.#clock.wallTimeMs(),
      source: { engineId: this.#engineId },
      data,
    };
  }
}
