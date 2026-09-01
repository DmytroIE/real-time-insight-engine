import { isDeepStrictEqual } from 'node:util';

import type {
  DiagnosticEventData,
  DiagnosticSeverity,
  EngineEventSource,
  EntityEventSource,
  EventSink,
} from './events';
import type { Clock } from './time';

export type DiagnosticCategory = 'Common' | 'Device' | 'Datastream' | 'Application' | 'Asset';
export type DiagnosticRetention = 'condition' | 'session';
export type DiagnosticSource = EngineEventSource | EntityEventSource;

export interface DiagnosticIdentity {
  readonly category: DiagnosticCategory;
  readonly sourceId: string;
  readonly ownerScope: string;
  readonly code: string;
}

export interface DiagnosticScopeIdentity {
  readonly category: DiagnosticCategory;
  readonly sourceId: string;
  readonly ownerScope: string;
  readonly source: DiagnosticSource;
}

export interface DiagnosticReportInput {
  readonly code: string;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface DiagnosticReporter {
  report(input: DiagnosticReportInput): void;
}

export interface DiagnosticObservation extends DiagnosticIdentity {
  readonly source: DiagnosticSource;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  readonly retention: DiagnosticRetention;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface Diagnostic extends DiagnosticObservation {
  readonly firstRaisedTs: number;
  readonly lastUpdatedTs: number;
  readonly lastObservedTs: number;
  readonly occurrenceCount: number;
}

export type PersistedDiagnostic = Diagnostic;

const diagnosticKey = ({ category, sourceId, ownerScope, code }: DiagnosticIdentity): string =>
  JSON.stringify([category, sourceId, ownerScope, code]);

const clone = <Value>(value: Value): Value => structuredClone(value);

const eventData = (diagnostic: Diagnostic): DiagnosticEventData => ({
  category: diagnostic.category,
  sourceId: diagnostic.sourceId,
  ownerScope: diagnostic.ownerScope,
  code: diagnostic.code,
  severity: diagnostic.severity,
  message: diagnostic.message,
  retention: diagnostic.retention,
  ...(diagnostic.details === undefined ? {} : { details: clone(diagnostic.details) }),
});

const isMaterialChange = (previous: Diagnostic, observation: DiagnosticObservation): boolean =>
  previous.severity !== observation.severity ||
  previous.message !== observation.message ||
  previous.retention !== observation.retention ||
  !isDeepStrictEqual(previous.details, observation.details);

const belongsToScope = (diagnostic: Diagnostic, scope: DiagnosticScopeIdentity): boolean =>
  diagnostic.retention === 'condition' &&
  diagnostic.category === scope.category &&
  diagnostic.sourceId === scope.sourceId &&
  diagnostic.ownerScope === scope.ownerScope;

export class DiagnosticEvaluationScope implements DiagnosticReporter {
  readonly #reports = new Map<string, DiagnosticReportInput>();
  #active = true;

  public constructor(
    private readonly reconcile: (reports: readonly DiagnosticReportInput[]) => void,
  ) {}

  public report(input: DiagnosticReportInput): void {
    this.ensureActive();
    this.#reports.set(input.code, clone(input));
  }

  public complete(): void {
    this.ensureActive();
    this.#active = false;
    this.reconcile([...this.#reports.values()]);
    this.#reports.clear();
  }

  public discard(): void {
    if (!this.#active) {
      return;
    }
    this.#active = false;
    this.#reports.clear();
  }

  private ensureActive(): void {
    if (!this.#active) {
      throw new Error('Diagnostic evaluation scope is already closed');
    }
  }
}

export class DiagnosticRegistry {
  readonly #records = new Map<string, Diagnostic>();

  public constructor(
    private readonly clock: Clock,
    private readonly eventSink: EventSink,
    restored: readonly PersistedDiagnostic[] = [],
    private readonly onChange: () => void = () => undefined,
  ) {
    for (const diagnostic of restored) {
      if (diagnostic.retention === 'condition') {
        this.#records.set(diagnosticKey(diagnostic), clone(diagnostic));
      }
    }
  }

  public observe(observation: DiagnosticObservation): Diagnostic {
    const key = diagnosticKey(observation);
    const previous = this.#records.get(key);
    const now = this.clock.wallTimeMs();

    if (previous === undefined) {
      const diagnostic: Diagnostic = {
        ...clone(observation),
        firstRaisedTs: now,
        lastUpdatedTs: now,
        lastObservedTs: now,
        occurrenceCount: 1,
      };
      this.#records.set(key, diagnostic);
      if (diagnostic.retention === 'condition') {
        this.onChange();
      }
      this.publish(
        diagnostic.retention === 'condition' ? 'diagnostic.raised' : 'diagnostic.notified',
        diagnostic,
      );
      return clone(diagnostic);
    }

    const materialChange = isMaterialChange(previous, observation);
    const diagnostic: Diagnostic = {
      ...clone(observation),
      firstRaisedTs: previous.firstRaisedTs,
      lastUpdatedTs: materialChange ? now : previous.lastUpdatedTs,
      lastObservedTs: now,
      occurrenceCount: previous.occurrenceCount + 1,
    };
    this.#records.set(key, diagnostic);
    if (previous.retention === 'condition' || diagnostic.retention === 'condition') {
      this.onChange();
    }
    if (materialChange) {
      this.publish(
        diagnostic.retention === 'condition' ? 'diagnostic.updated' : 'diagnostic.notified',
        diagnostic,
      );
    }
    return clone(diagnostic);
  }

  public createScope(identity: DiagnosticScopeIdentity): DiagnosticEvaluationScope {
    return new DiagnosticEvaluationScope((reports) => this.reconcileConditions(identity, reports));
  }

  public async evaluateScope<Result>(
    identity: DiagnosticScopeIdentity,
    evaluate: (reporter: DiagnosticReporter) => Result | Promise<Result>,
  ): Promise<Result> {
    const scope = this.createScope(identity);
    try {
      const result = await evaluate(scope);
      scope.complete();
      return result;
    } catch (error) {
      scope.discard();
      throw error;
    }
  }

  public clear(identity: DiagnosticIdentity): boolean {
    const key = diagnosticKey(identity);
    const diagnostic = this.#records.get(key);
    if (diagnostic === undefined) {
      return false;
    }

    this.#records.delete(key);
    if (diagnostic.retention === 'condition') {
      this.onChange();
    }
    this.publish('diagnostic.cleared', diagnostic);
    return true;
  }

  public get(identity: DiagnosticIdentity): Diagnostic | undefined {
    const diagnostic = this.#records.get(diagnosticKey(identity));
    return diagnostic === undefined ? undefined : clone(diagnostic);
  }

  public records(category?: DiagnosticCategory): readonly Diagnostic[] {
    return [...this.#records.values()]
      .filter((diagnostic) => category === undefined || diagnostic.category === category)
      .map(clone);
  }

  public clearAll(): void {
    for (const diagnostic of [...this.#records.values()]) {
      this.clear(diagnostic);
    }
  }

  public toPersistence(): readonly PersistedDiagnostic[] {
    return [...this.#records.values()]
      .filter((diagnostic) => diagnostic.retention === 'condition')
      .map(clone);
  }

  private reconcileConditions(
    identity: DiagnosticScopeIdentity,
    reports: readonly DiagnosticReportInput[],
  ): void {
    const reportedCodes = new Set(reports.map((report) => report.code));
    for (const report of reports) {
      this.observe({ ...identity, ...report, retention: 'condition' });
    }

    const omitted = [...this.#records.values()].filter(
      (diagnostic) => belongsToScope(diagnostic, identity) && !reportedCodes.has(diagnostic.code),
    );
    for (const diagnostic of omitted) {
      this.clear(diagnostic);
    }
  }

  private publish(
    type: 'diagnostic.raised' | 'diagnostic.updated' | 'diagnostic.cleared' | 'diagnostic.notified',
    diagnostic: Diagnostic,
  ): void {
    this.eventSink.publish({
      type,
      timestamp: this.clock.wallTimeMs(),
      source: clone(diagnostic.source),
      data: eventData(diagnostic),
    });
  }
}
