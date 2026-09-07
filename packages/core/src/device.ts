import type { DatastreamSample } from './datastream-values';
import type { DatastreamState, PersistenceMarker } from './datastream';
import type { DiagnosticRegistry, DiagnosticScopeIdentity } from './diagnostics';
import type { EntityEventSource, EventSink } from './events';
import type { DatastreamId, DeviceId, EngineId, PluginTypeId } from './identifiers';
import { EntityKind } from './model';
import {
  ParentRecomputationController,
  type ParentRecomputationRequester,
} from './parent-recomputation';
import type { Clock, TimerScheduler } from './time';

export interface DeviceDatastream {
  readonly id: DatastreamId;
  readonly hasError: boolean;
  acceptSample(sample: DatastreamSample): void;
  rejectInput(message: string, details?: Readonly<Record<string, unknown>>, code?: string): void;
  state(): Pick<DatastreamState, 'hwError' | 'noDataError'>;
}

export interface DevicePayloadContext {
  readonly sourceTimestamp: number;
  readonly receivedTimestamp: number;
  datastream(name: string): DeviceDatastream | undefined;
}

export type DevicePayloadParseResult =
  | { readonly accepted: true }
  | {
      readonly accepted: false;
      readonly message: string;
      readonly details?: Readonly<Record<string, unknown>>;
    };

export interface DevicePayloadParser {
  parse(
    payload: unknown,
    context: DevicePayloadContext,
  ): DevicePayloadParseResult | Promise<DevicePayloadParseResult>;
}

export interface DevicePayloadInput {
  readonly rawPayload: unknown;
  readonly sourceTimestamp: number;
  readonly receivedTimestamp: number;
}

export interface DeviceOptions {
  readonly id: DeviceId;
  readonly name?: string;
  readonly engineId: EngineId;
  readonly pluginType: PluginTypeId;
  readonly settings: unknown;
  readonly parentRecomputationDelayMs?: number;
}

export interface DeviceState {
  readonly lastUpdateTimestamp: number;
  readonly hwError: boolean;
}

export interface RestoredDeviceState {
  readonly lastUpdateTimestamp?: number;
  readonly hwError?: boolean;
}

export class Device implements ParentRecomputationRequester {
  readonly #source: EntityEventSource;
  readonly #datastreams = new Map<string, DeviceDatastream>();
  readonly #recomputation: ParentRecomputationController;
  readonly #options: DeviceOptions;
  readonly #parser: DevicePayloadParser;
  readonly #clock: Clock;
  readonly #eventSink: EventSink;
  readonly #diagnostics: DiagnosticRegistry;
  readonly #persistence: PersistenceMarker;
  #lastUpdateTimestamp: number;
  #hwError: boolean;
  #lastChildError = false;
  #ownStateDirty = false;

  public constructor(
    options: DeviceOptions,
    parser: DevicePayloadParser,
    clock: Clock,
    eventSink: EventSink,
    diagnostics: DiagnosticRegistry,
    persistence: PersistenceMarker,
    timers: TimerScheduler,
    restored: RestoredDeviceState = {},
  ) {
    this.#options = options;
    this.#parser = parser;
    this.#clock = clock;
    this.#eventSink = eventSink;
    this.#diagnostics = diagnostics;
    this.#persistence = persistence;
    this.#source = {
      engineId: options.engineId,
      entityType: EntityKind.Device,
      entityId: options.id,
      ...(options.name === undefined ? {} : { entityName: options.name }),
      pluginType: options.pluginType,
    };
    this.#lastUpdateTimestamp = restored.lastUpdateTimestamp ?? 0;
    this.#hwError = restored.hwError ?? false;
    this.#recomputation = new ParentRecomputationController(
      timers,
      () => this.recomputeState(),
      options.parentRecomputationDelayMs,
    );
  }

  public registerDatastream(name: string, datastream: DeviceDatastream): void {
    if (this.#datastreams.has(name)) {
      throw new Error(`Duplicate Datastream name for Device ${this.#options.id}: ${name}`);
    }
    this.#datastreams.set(name, datastream);
  }

  public datastream(name: string): DeviceDatastream | undefined {
    return this.#datastreams.get(name);
  }

  public get settings(): unknown {
    return structuredClone(this.#options.settings);
  }

  public get name(): string {
    return this.#options.name ?? this.#options.id;
  }

  public get chldError(): boolean {
    return [...this.#datastreams.values()].some((datastream) => datastream.hasError);
  }

  public get hasError(): boolean {
    return this.#hwError || this.chldError;
  }

  public async parsePayload(input: DevicePayloadInput): Promise<boolean> {
    const scope = this.#diagnostics.createScope(this.scopeIdentity('device-payload'));
    try {
      const result = await this.#parser.parse(input.rawPayload, {
        sourceTimestamp: input.sourceTimestamp,
        receivedTimestamp: input.receivedTimestamp,
        datastream: (name) => this.#datastreams.get(name),
      });
      if (!result.accepted) {
        scope.report({
          code: 'INVALID_PAYLOAD',
          severity: 'error',
          message: result.message,
          ...(result.details === undefined ? {} : { details: result.details }),
        });
      }
      scope.complete();
      this.#persistence.markDirty();
      return result.accepted;
    } catch (error) {
      scope.discard();
      throw error;
    }
  }

  public setHardwareError(
    hwError: boolean,
    message = 'Device hardware fault',
    details?: Readonly<Record<string, unknown>>,
  ): void {
    this.#ownStateDirty ||= this.#hwError !== hwError;
    this.#hwError = hwError;
    const scope = this.#diagnostics.createScope(this.scopeIdentity('device-hardware'));
    if (hwError) {
      scope.report({
        code: 'DEVICE_HARDWARE_ERROR',
        severity: 'error',
        message,
        ...(details === undefined ? {} : { details }),
      });
    }
    scope.complete();
    this.recompute();
  }

  public recompute(): DeviceState {
    this.#recomputation.recomputeNow();
    return this.state();
  }

  public requestRecompute(): void {
    this.#recomputation.requestRecompute();
  }

  public close(): DeviceState {
    this.#recomputation.flushAndClose();
    return this.state();
  }

  public state(): DeviceState {
    return {
      lastUpdateTimestamp: this.#lastUpdateTimestamp,
      hwError: this.#hwError,
    };
  }

  private recomputeState(): void {
    const childError = this.chldError;
    const changed = this.#ownStateDirty || this.#lastChildError !== childError;
    this.#ownStateDirty = false;
    this.#lastChildError = childError;
    if (!changed) {
      return;
    }
    this.#lastUpdateTimestamp = this.#clock.wallTimeMs();
    this.#persistence.markDirty();
    this.#eventSink.publish({
      type: 'entity.updated',
      timestamp: this.#lastUpdateTimestamp,
      source: this.#source,
    });
  }

  private scopeIdentity(ownerScope: string): DiagnosticScopeIdentity {
    return {
      category: 'Device',
      sourceId: this.#options.id,
      ownerScope,
      source: this.#source,
    };
  }
}
