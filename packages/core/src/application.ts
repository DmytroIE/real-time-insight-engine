import { isDeepStrictEqual } from 'node:util';

import type { AssetApplicationState } from './asset';
import type { DatastreamState, PersistenceMarker } from './datastream';
import type { DatastreamSample, DatastreamValueRange } from './datastream-values';
import type {
  DiagnosticRegistry,
  DiagnosticReporter,
  DiagnosticScopeIdentity,
} from './diagnostics';
import type { EntityEventSource, EventSink } from './events';
import type { ApplicationId, AssetId, DatastreamId, EngineId, PluginTypeId } from './identifiers';
import { EntityKind, ProcessState } from './model';
import type { ParentRecomputationRequester } from './parent-recomputation';
import type { Clock } from './time';

export interface ApplicationDatastream {
  readonly id: DatastreamId;
  evaluateStale(): boolean;
  state(): DatastreamState;
  averageValue(range?: DatastreamValueRange): DatastreamSample | null;
}

export interface ApplicationResult<PluginState extends object> {
  readonly pluginState: PluginState;
  readonly currState: ProcessState;
  readonly noDataError: boolean;
  readonly appError: boolean;
}

export interface ApplicationEvaluationContext<PluginState extends object> {
  readonly timestamp: number;
  readonly sessionStartTs: number;
  readonly currState: ProcessState;
  readonly noDataError: boolean;
  readonly appError: boolean;
  readonly pluginState: Readonly<PluginState>;
  readonly datafeeds: Readonly<Record<string, ApplicationDatastream>>;
  readonly diagnostics: DiagnosticReporter;
  readonly assetDiagnostics: DiagnosticReporter;
}

export interface ApplicationEvaluator<PluginState extends object> {
  evaluate(
    context: ApplicationEvaluationContext<PluginState>,
  ): ApplicationResult<PluginState> | Promise<ApplicationResult<PluginState>>;
}

export interface ApplicationOptions {
  readonly id: ApplicationId;
  readonly name?: string;
  readonly assetId: AssetId;
  readonly assetName?: string;
  readonly engineId: EngineId;
  readonly pluginType: PluginTypeId;
  readonly runIntervalMs: number;
  readonly sessionStartTimestamp: number;
}

export interface ApplicationState<PluginState extends object> extends AssetApplicationState {
  readonly lastRunTimestamp: number;
  readonly lastUpdateTimestamp: number;
  readonly nextRunTimestamp: number;
  readonly pluginState: Readonly<PluginState>;
}

export interface RestoredApplicationState<PluginState extends object> {
  readonly lastRunTimestamp?: number;
  readonly lastUpdateTimestamp?: number;
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
  readonly #options: ApplicationOptions;
  readonly #evaluator: ApplicationEvaluator<PluginState>;
  readonly #clock: Clock;
  readonly #eventSink: EventSink;
  readonly #diagnostics: DiagnosticRegistry;
  readonly #persistence: PersistenceMarker;
  readonly #parent: ParentRecomputationRequester | undefined;
  #lastRunTimestamp: number;
  #lastUpdateTimestamp: number;
  #nextRunTimestamp: number;
  #currState: ProcessState;
  #noDataError: boolean;
  #appError: boolean;
  #pluginState: PluginState;
  #running = false;

  public get id(): ApplicationId {
    return this.#options.id;
  }

  public get name(): string {
    return this.#options.name ?? this.#options.id;
  }

  public constructor(
    options: ApplicationOptions,
    datafeeds: Readonly<Record<string, ApplicationDatastream>>,
    evaluator: ApplicationEvaluator<PluginState>,
    clock: Clock,
    eventSink: EventSink,
    diagnostics: DiagnosticRegistry,
    persistence: PersistenceMarker,
    defaultPluginState: PluginState,
    restored: RestoredApplicationState<PluginState> = {},
    parent?: ParentRecomputationRequester,
  ) {
    this.#options = options;
    this.#evaluator = evaluator;
    this.#clock = clock;
    this.#eventSink = eventSink;
    this.#diagnostics = diagnostics;
    this.#persistence = persistence;
    this.#parent = parent;
    this.#source = {
      engineId: options.engineId,
      entityType: EntityKind.Application,
      entityId: options.id,
      ...(options.name === undefined ? {} : { entityName: options.name }),
      pluginType: options.pluginType,
    };
    this.#datafeeds = { ...datafeeds };
    this.#lastRunTimestamp = restored.lastRunTimestamp ?? options.sessionStartTimestamp;
    this.#lastUpdateTimestamp = restored.lastUpdateTimestamp ?? options.sessionStartTimestamp;
    this.#nextRunTimestamp = this.#lastRunTimestamp + options.runIntervalMs;
    this.#currState = restored.currState ?? ProcessState.Undefined;
    this.#noDataError = restored.noDataError ?? false;
    this.#appError = restored.appError ?? false;
    this.#pluginState = clone(restored.pluginState ?? defaultPluginState);
  }

  public async runIfDue(): Promise<ApplicationRunOutcome> {
    if (this.#running) {
      return 'skipped-overlap';
    }

    const now = this.#clock.wallTimeMs();
    if (now < this.#nextRunTimestamp) {
      return 'not-due';
    }

    this.#running = true;
    const previousResult = this.resultState();
    this.#lastRunTimestamp = now;
    this.#nextRunTimestamp = now + this.#options.runIntervalMs;
    for (const datastream of Object.values(this.#datafeeds)) {
      datastream.evaluateStale();
    }

    const calculationScope = this.#diagnostics.createScope(
      this.scopeIdentity('application-calculation'),
    );
    const assetCalculationScope = this.#diagnostics.createScope(
      this.assetScopeIdentity('application-calculation'),
    );
    try {
      const result = await this.#evaluator.evaluate({
        timestamp: now,
        sessionStartTs: this.#options.sessionStartTimestamp,
        currState: this.#currState,
        noDataError: this.#noDataError,
        appError: this.#appError,
        pluginState: clone(this.#pluginState),
        datafeeds: this.#datafeeds,
        diagnostics: calculationScope,
        assetDiagnostics: assetCalculationScope,
      });
      this.#pluginState = clone(result.pluginState);
      this.#currState = result.currState;
      this.#noDataError = result.noDataError;
      this.#appError = result.appError;
      calculationScope.complete();
      assetCalculationScope.complete();
      this.#diagnostics.createScope(this.scopeIdentity('application-runner')).complete();
      this.finishRun(now, !isDeepStrictEqual(previousResult, this.resultState()), true);
      return 'completed';
    } catch (error) {
      calculationScope.discard();
      assetCalculationScope.discard();
      this.#currState = ProcessState.Undefined;
      this.#noDataError = false;
      this.#appError = true;
      const runnerScope = this.#diagnostics.createScope(this.scopeIdentity('application-runner'));
      runnerScope.report({
        code: 'APPLICATION_EXECUTION_ERROR',
        severity: 'error',
        message: error instanceof Error ? error.message : 'Application execution failed',
      });
      runnerScope.complete();
      this.finishRun(now, !isDeepStrictEqual(previousResult, this.resultState()), false);
      return 'failed';
    } finally {
      this.#running = false;
    }
  }

  public nextApplicationRunTimestamp(): number {
    return this.#nextRunTimestamp;
  }

  public get hasError(): boolean {
    return this.#noDataError || this.#appError;
  }

  public state(): ApplicationState<PluginState> {
    return {
      lastRunTimestamp: this.#lastRunTimestamp,
      lastUpdateTimestamp: this.#lastUpdateTimestamp,
      nextRunTimestamp: this.#nextRunTimestamp,
      currState: this.#currState,
      noDataError: this.#noDataError,
      appError: this.#appError,
      pluginState: clone(this.#pluginState),
    };
  }

  private resultState(): Pick<
    ApplicationState<PluginState>,
    'currState' | 'noDataError' | 'appError' | 'pluginState'
  > {
    return {
      currState: this.#currState,
      noDataError: this.#noDataError,
      appError: this.#appError,
      pluginState: clone(this.#pluginState),
    };
  }

  private finishRun(timestamp: number, stateChanged: boolean, success: boolean): void {
    this.#persistence.markDirty();
    if (stateChanged) {
      this.#lastUpdateTimestamp = timestamp;
      this.#eventSink.publish({
        type: 'entity.updated',
        timestamp,
        source: this.#source,
      });
      this.#parent?.requestRecompute();
    }
    this.#eventSink.publish({
      type: 'application.executed',
      timestamp,
      source: this.#source,
      data: {
        success,
        resultChanged: stateChanged,
        lastRunTimestamp: this.#lastRunTimestamp,
        lastUpdateTimestamp: this.#lastUpdateTimestamp,
      },
    });
  }

  private scopeIdentity(ownerScope: string): DiagnosticScopeIdentity {
    return {
      category: 'Application',
      sourceId: this.#options.id,
      ownerScope,
      source: this.#source,
    };
  }

  private assetScopeIdentity(ownerScope: string): DiagnosticScopeIdentity {
    return {
      category: 'Asset',
      sourceId: this.#options.assetId,
      ownerScope: `application:${this.#options.id}:${ownerScope}`,
      source: {
        engineId: this.#options.engineId,
        entityType: EntityKind.Asset,
        entityId: this.#options.assetId,
        ...(this.#options.assetName === undefined ? {} : { entityName: this.#options.assetName }),
      },
    };
  }
}
