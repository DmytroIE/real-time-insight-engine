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
  state(): AssetApplicationState;
}

export interface AssetOptions {
  readonly id: AssetId;
  readonly engineId: EngineId;
  readonly parentRecomputationDelayMs?: number;
}

export interface AssetState {
  readonly lastUpdateTimestamp: number;
  readonly currState: ProcessState;
  readonly error: boolean;
}

export interface RestoredAssetState {
  readonly lastUpdateTimestamp?: number;
  readonly currState?: ProcessState;
  readonly error?: boolean;
}

export class Asset implements ParentRecomputationRequester {
  readonly #source: EntityEventSource;
  readonly #applications = new Map<ApplicationId, AssetApplication>();
  readonly #recomputation: ParentRecomputationController;
  #lastUpdateTimestamp: number;
  #currState: ProcessState;
  #error: boolean;

  public constructor(
    private readonly options: AssetOptions,
    private readonly clock: Clock,
    private readonly eventSink: EventSink,
    private readonly persistence: PersistenceMarker,
    timers: TimerScheduler,
    restored: RestoredAssetState = {},
  ) {
    this.#source = {
      engineId: options.engineId,
      entityType: EntityKind.Asset,
      entityId: options.id,
    };
    this.#lastUpdateTimestamp = restored.lastUpdateTimestamp ?? 0;
    this.#currState = restored.currState ?? ProcessState.Undefined;
    this.#error = restored.error ?? false;
    this.#recomputation = new ParentRecomputationController(
      timers,
      () => this.recomputeState(),
      options.parentRecomputationDelayMs,
    );
  }

  public registerApplication(application: AssetApplication): void {
    if (this.#applications.has(application.id)) {
      throw new Error(`Duplicate Application ID for Asset ${this.options.id}: ${application.id}`);
    }
    this.#applications.set(application.id, application);
  }

  public application(id: ApplicationId): AssetApplication | undefined {
    return this.#applications.get(id);
  }

  public recompute(): AssetState {
    this.#recomputation.recomputeNow();
    return this.state();
  }

  public requestRecompute(): void {
    this.#recomputation.requestRecompute();
  }

  public close(): AssetState {
    this.#recomputation.flushAndClose();
    return this.state();
  }

  public state(): AssetState {
    return {
      lastUpdateTimestamp: this.#lastUpdateTimestamp,
      currState: this.#currState,
      error: this.#error,
    };
  }

  private recomputeState(): void {
    let currState = ProcessState.Undefined;
    let error = false;
    for (const application of this.#applications.values()) {
      const childState = application.state();
      currState = Math.max(currState, childState.currState) as ProcessState;
      error ||= childState.noDataError || childState.appError;
    }

    if (this.#currState === currState && this.#error === error) {
      return;
    }
    this.#currState = currState;
    this.#error = error;
    this.#lastUpdateTimestamp = this.clock.wallTimeMs();
    this.persistence.markDirty();
    this.eventSink.publish({
      type: 'entity.updated',
      timestamp: this.#lastUpdateTimestamp,
      source: this.#source,
    });
  }
}
