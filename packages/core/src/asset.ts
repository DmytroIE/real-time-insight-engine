import type { PersistenceMarker } from './datastream';
import type { EntityEventSource, EventSink } from './events';
import type { ApplicationId, AssetId, EngineId } from './identifiers';
import { EntityKind, ProcessState } from './model';
import {
  ParentRecomputationController,
  type ParentRecomputationRequester,
} from './parent-recomputation';
import type { Clock, TimerScheduler } from './time';

export interface AssetApplicationState {
  readonly currState: ProcessState;
  readonly noDataError: boolean;
  readonly appError: boolean;
}

export interface AssetApplication {
  readonly id: ApplicationId;
  readonly hasError: boolean;
  state(): AssetApplicationState;
}

export interface AssetOptions {
  readonly id: AssetId;
  readonly name?: string;
  readonly engineId: EngineId;
  readonly parentRecomputationDelayMs?: number;
}

export interface AssetState {
  readonly lastUpdateTimestamp: number;
  readonly currState: ProcessState;
}

export interface RestoredAssetState {
  readonly lastUpdateTimestamp?: number;
  readonly currState?: ProcessState;
}

export class Asset implements ParentRecomputationRequester {
  readonly #source: EntityEventSource;
  readonly #applications = new Map<ApplicationId, AssetApplication>();
  readonly #recomputation: ParentRecomputationController;
  readonly #options: AssetOptions;
  readonly #clock: Clock;
  readonly #eventSink: EventSink;
  readonly #persistence: PersistenceMarker;
  #lastUpdateTimestamp: number;
  #currState: ProcessState;
  #lastChildrenError = false;

  public constructor(
    options: AssetOptions,
    clock: Clock,
    eventSink: EventSink,
    persistence: PersistenceMarker,
    timers: TimerScheduler,
    restored: RestoredAssetState = {},
  ) {
    this.#options = options;
    this.#clock = clock;
    this.#eventSink = eventSink;
    this.#persistence = persistence;
    this.#source = {
      engineId: options.engineId,
      entityType: EntityKind.Asset,
      entityId: options.id,
      ...(options.name === undefined ? {} : { entityName: options.name }),
    };
    this.#lastUpdateTimestamp = restored.lastUpdateTimestamp ?? 0;
    this.#currState = restored.currState ?? ProcessState.Undefined;
    this.#recomputation = new ParentRecomputationController(
      timers,
      () => this.recomputeState(),
      options.parentRecomputationDelayMs,
    );
  }

  public registerApplication(application: AssetApplication): void {
    if (this.#applications.has(application.id)) {
      throw new Error(`Duplicate Application ID for Asset ${this.#options.id}: ${application.id}`);
    }
    this.#applications.set(application.id, application);
  }

  public application(id: ApplicationId): AssetApplication | undefined {
    return this.#applications.get(id);
  }

  public get name(): string {
    return this.#options.name ?? this.#options.id;
  }

  public recompute(): AssetState {
    this.#recomputation.recomputeNow();
    return this.state();
  }

  public requestRecompute(): void {
    this.#recomputation.requestRecompute();
  }

  public get childrenError(): boolean {
    return [...this.#applications.values()].some((application) => application.hasError);
  }

  public get hasError(): boolean {
    return this.childrenError;
  }

  public close(): AssetState {
    this.#recomputation.flushAndClose();
    return this.state();
  }

  public state(): AssetState {
    return {
      lastUpdateTimestamp: this.#lastUpdateTimestamp,
      currState: this.#currState,
    };
  }

  private recomputeState(): void {
    let currState = ProcessState.Undefined;
    for (const application of this.#applications.values()) {
      const childState = application.state();
      currState = Math.max(currState, childState.currState) as ProcessState;
    }
    const childrenError = this.childrenError;

    if (this.#currState === currState && this.#lastChildrenError === childrenError) {
      return;
    }
    this.#currState = currState;
    this.#lastChildrenError = childrenError;
    this.#lastUpdateTimestamp = this.#clock.wallTimeMs();
    this.#persistence.markDirty();
    this.#eventSink.publish({
      type: 'entity.updated',
      timestamp: this.#lastUpdateTimestamp,
      source: this.#source,
    });
  }
}
