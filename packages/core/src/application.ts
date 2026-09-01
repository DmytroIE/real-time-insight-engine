import type { AssetApplicationState } from './asset';
import type { DatastreamState, PersistenceMarker } from './datastream';
import type { DatastreamSample, DatastreamValueRange } from './datastream-values';
import type {
  DiagnosticRegistry,
  DiagnosticReporter,
  DiagnosticScopeIdentity,
} from './diagnostics';
import type { EntityEventSource, EventSink } from './events';
import type { ApplicationId, DatastreamId, EngineId, PluginTypeId } from './identifiers';
import { EntityKind, ProcessState } from './model';
import type { ParentRecomputationRequester } from './parent-recomputation';
import type { Clock } from './time';

export interface ApplicationDatastream {
  readonly id: DatastreamId;
  evaluateStale(): boolean;
  state(): Pick<DatastreamState, 'noDataError'>;
  averageValue(range?: DatastreamValueRange): DatastreamSample | null;
}

export interface ApplicationResult<PluginState extends object> {
  readonly state: Partial<PluginState>;
  readonly currState?: ProcessState;
  readonly noDataError?: boolean;
  readonly appError?: boolean;
}

export interface ApplicationEvaluationContext<PluginState extends object> {
  readonly timestamp: number;
  readonly state: Readonly<ApplicationState<PluginState>>;
  readonly datafeeds: Readonly<Record<string, ApplicationDatastream>>;
  readonly diagnostics: DiagnosticReporter;
}

export interface ApplicationEvaluator<PluginState extends object> {
  evaluate(
    context: ApplicationEvaluationContext<PluginState>,
  ): ApplicationResult<PluginState> | Promise<ApplicationResult<PluginState>>;
}

export interface ApplicationOptions {
  readonly id: ApplicationId;
  readonly engineId: EngineId;
  readonly pluginType: PluginTypeId;
  readonly runIntervalMs: number;
}

export interface ApplicationState<PluginState extends object> extends AssetApplicationState {
  readonly lastRunTimestamp: number;
  readonly nextRunTimestamp: number;
  readonly pluginState: Readonly<PluginState>;
}

export interface RestoredApplicationState<PluginState extends object> {
  readonly lastRunTimestamp?: number;
  readonly nextRunTimestamp?: number;
  readonly currState?: ProcessState;
  readonly noDataError?: boolean;
  readonly appError?: boolean;
  readonly pluginState?: PluginState;
}

export type ApplicationRunOutcome = 'not-due' | 'skipped-overlap' | 'completed' | 'failed';

const clone = <Value>(value: Value): Value => structuredClone(value);

export class Application<PluginState extends object = Record<string, unknown>> {
  readonly #source: EntityEventSource;
  readonly #datafeeds: Readonly<Record<string, ApplicationDatastream>>;
  #lastRunTimestamp: number;
  #nextRunTimestamp: number;
  #currState: ProcessState;
  #noDataError: boolean;
  #appError: boolean;
  #pluginState: PluginState;
  #running = false;

  public get id(): ApplicationId {
    return this.options.id;
  }

  public constructor(
    private readonly options: ApplicationOptions,
    datafeeds: Readonly<Record<string, ApplicationDatastream>>,
    private readonly evaluator: ApplicationEvaluator<PluginState>,
    private readonly clock: Clock,
    private readonly eventSink: EventSink,
    private readonly diagnostics: DiagnosticRegistry,
    private readonly persistence: PersistenceMarker,
    defaultPluginState: PluginState,
    restored: RestoredApplicationState<PluginState> = {},
    private readonly parent?: ParentRecomputationRequester,
  ) {
    this.#source = {
      engineId: options.engineId,
      entityType: EntityKind.Application,
      entityId: options.id,
      pluginType: options.pluginType,
    };
    this.#datafeeds = { ...datafeeds };
    this.#lastRunTimestamp = restored.lastRunTimestamp ?? 0;
    this.#nextRunTimestamp =
      restored.nextRunTimestamp ?? this.#lastRunTimestamp + options.runIntervalMs;
    this.#currState = restored.currState ?? ProcessState.Undefined;
    this.#noDataError = restored.noDataError ?? false;
    this.#appError = restored.appError ?? false;
    this.#pluginState = clone(restored.pluginState ?? defaultPluginState);
  }

  public async runIfDue(): Promise<ApplicationRunOutcome> {
    if (this.#running) {
      return 'skipped-overlap';
    }

    const now = this.clock.wallTimeMs();
    if (now < this.#nextRunTimestamp) {
      return 'not-due';
    }

    this.#running = true;
    this.#lastRunTimestamp = now;
    this.#nextRunTimestamp = now + this.options.runIntervalMs;
    this.#currState = ProcessState.Undefined;
    this.#noDataError = false;
    this.#appError = false;
    for (const datastream of Object.values(this.#datafeeds)) {
      datastream.evaluateStale();
    }

    const calculationScope = this.diagnostics.createScope(
      this.scopeIdentity('application-calculation'),
    );
    try {
      const result = await this.evaluator.evaluate({
        timestamp: now,
        state: this.state(),
        datafeeds: this.#datafeeds,
        diagnostics: calculationScope,
      });
      this.#pluginState = { ...this.#pluginState, ...clone(result.state) };
      this.#currState = result.currState ?? ProcessState.Undefined;
      this.#noDataError = result.noDataError ?? false;
      this.#appError = result.appError ?? false;
      calculationScope.complete();
      this.diagnostics.createScope(this.scopeIdentity('application-runner')).complete();
      this.commit(now);
      return 'completed';
    } catch (error) {
      calculationScope.discard();
      this.#currState = ProcessState.Undefined;
      this.#noDataError = false;
      this.#appError = true;
      const runnerScope = this.diagnostics.createScope(this.scopeIdentity('application-runner'));
      runnerScope.report({
        code: 'APPLICATION_EXECUTION_ERROR',
        severity: 'error',
        message: error instanceof Error ? error.message : 'Application execution failed',
      });
      runnerScope.complete();
      this.commit(now);
      return 'failed';
    } finally {
      this.#running = false;
    }
  }

  public nextApplicationRunTimestamp(): number {
    return this.#nextRunTimestamp;
  }

  public state(): ApplicationState<PluginState> {
    return {
      lastRunTimestamp: this.#lastRunTimestamp,
      nextRunTimestamp: this.#nextRunTimestamp,
      currState: this.#currState,
      noDataError: this.#noDataError,
      appError: this.#appError,
      pluginState: clone(this.#pluginState),
    };
  }

  private commit(timestamp: number): void {
    this.persistence.markDirty();
    this.eventSink.publish({
      type: 'entity.updated',
      timestamp,
      source: this.#source,
    });
    this.parent?.requestRecompute();
  }

  private scopeIdentity(ownerScope: string): DiagnosticScopeIdentity {
    return {
      category: 'Application',
      sourceId: this.options.id,
      ownerScope,
      source: this.#source,
    };
  }
}
