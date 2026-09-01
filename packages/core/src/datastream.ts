import {
  DatastreamValueBuffer,
  type DatastreamSample,
  type DatastreamValueRange,
} from './datastream-values';
import type { DiagnosticRegistry, DiagnosticScopeIdentity } from './diagnostics';
import type { EntityEventSource, EventSink } from './events';
import type { DatastreamId, EngineId, PluginTypeId } from './identifiers';
import { EntityKind } from './model';
import type { ParentRecomputationRequester } from './parent-recomputation';
import type { Clock } from './time';

export const DEFAULT_INTERVAL_MARGIN_COEFFICIENT = 1.5;

export interface PersistenceMarker {
  markDirty(): void;
}

export interface DatastreamOptions {
  readonly id: DatastreamId;
  readonly engineId: EngineId;
  readonly pluginType?: PluginTypeId;
  readonly maxBufferLength: number;
  readonly maxBufferAgeMs: number;
  readonly expectedIntervalMs: number;
  readonly sessionStartTimestamp: number;
  readonly intervalMarginCoefficient?: number;
}

export interface DatastreamState {
  readonly lastUpdateTimestamp: number;
  readonly nextUpdateTimestamp: number;
  readonly noDataError: boolean;
  readonly hwError: boolean;
  readonly samples: readonly DatastreamSample[];
}

export interface RestoredDatastreamState {
  readonly lastUpdateTimestamp?: number;
  readonly nextUpdateTimestamp?: number;
  readonly noDataError?: boolean;
  readonly hwError?: boolean;
  readonly samples?: readonly DatastreamSample[];
}

export class Datastream {
  readonly #source: EntityEventSource;
  readonly #staleAfterMs: number;
  readonly #values: DatastreamValueBuffer;
  #lastUpdateTimestamp: number;
  #nextUpdateTimestamp: number;
  #noDataError: boolean;
  #hwError: boolean;

  public get id(): DatastreamId {
    return this.options.id;
  }

  public constructor(
    private readonly options: DatastreamOptions,
    private readonly clock: Clock,
    private readonly eventSink: EventSink,
    private readonly diagnostics: DiagnosticRegistry,
    private readonly persistence: PersistenceMarker,
    restored: RestoredDatastreamState = {},
    private readonly parent?: ParentRecomputationRequester,
  ) {
    this.#source = {
      engineId: options.engineId,
      entityType: EntityKind.Datastream,
      entityId: options.id,
      ...(options.pluginType === undefined ? {} : { pluginType: options.pluginType }),
    };
    this.#staleAfterMs =
      options.expectedIntervalMs *
      (options.intervalMarginCoefficient ?? DEFAULT_INTERVAL_MARGIN_COEFFICIENT);
    this.#values = new DatastreamValueBuffer(
      {
        maxBufferLength: options.maxBufferLength,
        maxBufferAgeMs: options.maxBufferAgeMs,
      },
      restored.samples,
    );
    this.#lastUpdateTimestamp = restored.lastUpdateTimestamp ?? 0;
    this.#nextUpdateTimestamp =
      restored.nextUpdateTimestamp ??
      Math.max(options.sessionStartTimestamp, this.#lastUpdateTimestamp) + this.#staleAfterMs;
    this.#noDataError = restored.noDataError ?? false;
    this.#hwError = restored.hwError ?? false;
  }

  public acceptSample(sample: DatastreamSample): void {
    const now = this.clock.wallTimeMs();
    this.#values.upsert(sample, now);
    this.#hwError = false;
    this.#noDataError = false;
    this.reconcileHardware();
    this.reconcileStale();
    this.commitUpdate(now);
  }

  public rejectInput(
    message: string,
    details?: Readonly<Record<string, unknown>>,
    code = 'INVALID_INPUT',
  ): void {
    const now = this.clock.wallTimeMs();
    this.#values.prune(now);
    this.#hwError = true;
    const scope = this.diagnostics.createScope(this.scopeIdentity('datastream-input'));
    scope.report({
      code,
      severity: 'error',
      message,
      ...(details === undefined ? {} : { details }),
    });
    scope.complete();
    this.reconcileStale();
    this.commitUpdate(now);
  }

  public evaluateStale(): boolean {
    const now = this.clock.wallTimeMs();
    if (now < this.#nextUpdateTimestamp) {
      return this.#noDataError;
    }

    this.#values.prune(now);
    const stale = this.#values.values().length === 0;
    this.#noDataError = stale;
    this.reconcileStale();
    this.commitUpdate(now);
    return stale;
  }

  public nextStaleCheckTimestamp(): number {
    return this.#nextUpdateTimestamp;
  }

  public state(): DatastreamState {
    return {
      lastUpdateTimestamp: this.#lastUpdateTimestamp,
      nextUpdateTimestamp: this.#nextUpdateTimestamp,
      noDataError: this.#noDataError,
      hwError: this.#hwError,
      samples: this.#values.values(),
    };
  }

  public values(range: DatastreamValueRange = {}): readonly DatastreamSample[] {
    return this.#values.values(range);
  }

  public lastValue(range: DatastreamValueRange = {}): DatastreamSample | null {
    return this.#values.lastValue(range);
  }

  public averageValue(range: DatastreamValueRange = {}): DatastreamSample | null {
    return this.#values.averageValue(range);
  }

  private commitUpdate(now: number): void {
    this.#lastUpdateTimestamp = now;
    this.#nextUpdateTimestamp = now + this.#staleAfterMs;
    this.persistence.markDirty();
    this.eventSink.publish({ type: 'entity.updated', timestamp: now, source: this.#source });
    this.parent?.requestRecompute();
  }

  private reconcileHardware(): void {
    if (!this.#hwError) {
      this.diagnostics.createScope(this.scopeIdentity('datastream-input')).complete();
    }
  }

  private reconcileStale(): void {
    const scope = this.diagnostics.createScope(this.scopeIdentity('datastream-stale'));
    if (this.#noDataError) {
      scope.report({
        code: 'NO_DATA',
        severity: 'error',
        message: 'Datastream has no current data',
      });
    }
    scope.complete();
  }

  private scopeIdentity(ownerScope: string): DiagnosticScopeIdentity {
    return {
      category: 'Datastream',
      sourceId: this.options.id,
      ownerScope,
      source: this.#source,
    };
  }
}
