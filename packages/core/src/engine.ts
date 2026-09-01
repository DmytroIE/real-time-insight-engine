import {
  Application,
  type ApplicationEvaluator,
  type ApplicationRunOutcome,
  type RestoredApplicationState,
} from './application';
import { ApplicationScheduler, type ApplicationTaskResult } from './application-scheduler';
import { Asset, type RestoredAssetState } from './asset';
import {
  ClockJumpMonitor,
  DEFAULT_CLOCK_JUMP_THRESHOLD_MS,
  type ClockJump,
} from './clock-jump-monitor';
import type { EngineConfiguration } from './configuration';
import { Datastream, type PersistenceMarker, type RestoredDatastreamState } from './datastream';
import {
  DatastreamStaleScheduler,
  type DatastreamStaleTaskResult,
} from './datastream-stale-scheduler';
import { DiagnosticRegistry } from './diagnostics';
import {
  Device,
  type DevicePayloadInput,
  type DevicePayloadParser,
  type RestoredDeviceState,
} from './device';
import { EngineLifecycleController } from './engine-lifecycle';
import {
  type EntityEventSource,
  type EventListener,
  type EngineLifecycleState,
  type EventPattern,
  type Unsubscribe,
} from './events';
import {
  asApplicationId,
  asAssetId,
  asDatastreamId,
  asDeviceId,
  type ApplicationId,
  type AssetId,
  type DatastreamId,
  type DeviceId,
  type EngineId,
  type PluginTypeId,
} from './identifiers';
import { EntityKind, type EntityRef } from './model';
import type { PluginRegistry } from './plugins';
import {
  PERSISTED_STATE_RECOVERY_DIAGNOSTIC,
  StateMigrationError,
  preparePersistedSnapshot,
} from './state-migrations';
import {
  SnapshotPathError,
  SnapshotRequestError,
  deepFreezeSnapshot,
  projectSnapshotState,
  type EngineSnapshotResponse,
  type EntitySnapshot,
  type MissingStatePath,
  type SnapshotDiagnosticGroups,
  type SnapshotRequest,
} from './snapshots';
import {
  ENGINE_SNAPSHOT_SCHEMA_VERSION,
  engineCorruptSnapshotKey,
  engineSnapshotKey,
  engineStateKeyPrefix,
  entityStateKey,
  type EngineEntityStates,
  type EngineSnapshotMigration,
  type PersistedEngineSnapshot,
  type StateStore,
} from './state-store';
import type { Clock, TimerScheduler } from './time';

export interface EngineDependencies {
  readonly clock: Clock;
  readonly timers: TimerScheduler;
  readonly plugins: PluginRegistry;
  readonly stateStore?: StateStore;
}

export interface PersistentEngineDependencies extends EngineDependencies {
  readonly stateStore: StateStore;
  readonly snapshotMigrations?: readonly EngineSnapshotMigration[];
  readonly lifecycleListener?: EventListener;
}

export interface EngineRegistryView {
  readonly devices: readonly DeviceId[];
  readonly datastreams: readonly DatastreamId[];
  readonly assets: readonly AssetId[];
  readonly applications: readonly ApplicationId[];
}

export type EngineIngestIssue = 'NO_DEVICE_NAME' | 'NO_GATEWAY_TIME' | 'INVALID_GATEWAY_TIME';

export interface EngineIngestInput extends DevicePayloadInput {
  readonly deviceId?: DeviceId;
  readonly source?: string;
  readonly issues?: readonly EngineIngestIssue[];
}

const qualifiedId = (parentId: string, childId: string): string => `${parentId}/${childId}`;
const entityKey = ({ kind, id }: EntityRef): string => `${kind}:${id}`;
const lifecycleBootstrap = Symbol('engineLifecycleBootstrap');

interface InternalEngineDependencies extends EngineDependencies {
  readonly [lifecycleBootstrap]?: EngineLifecycleController;
}

const requireDeviceParser = (value: unknown, pluginType: string): DevicePayloadParser => {
  if (typeof value !== 'object' || value === null || !('parse' in value)) {
    throw new Error(`Device plugin ${pluginType} did not create a payload parser`);
  }
  const parser = value as { readonly parse?: unknown };
  if (typeof parser.parse !== 'function') {
    throw new Error(`Device plugin ${pluginType} did not create a payload parser`);
  }
  return value as DevicePayloadParser;
};

const requireApplicationEvaluator = (
  value: unknown,
  pluginType: string,
): ApplicationEvaluator<object> => {
  if (typeof value !== 'object' || value === null || !('evaluate' in value)) {
    throw new Error(`Application plugin ${pluginType} did not create an evaluator`);
  }
  const evaluator = value as { readonly evaluate?: unknown };
  if (typeof evaluator.evaluate !== 'function') {
    throw new Error(`Application plugin ${pluginType} did not create an evaluator`);
  }
  return value as ApplicationEvaluator<object>;
};

const freezeIds = <Id extends string>(ids: Iterable<Id>): readonly Id[] => Object.freeze([...ids]);

export class Engine implements PersistenceMarker {
  readonly #lifecycle: EngineLifecycleController;
  readonly #diagnostics: DiagnosticRegistry;
  readonly #datastreamStaleScheduler: DatastreamStaleScheduler;
  readonly #applicationScheduler: ApplicationScheduler;
  readonly #clockJumpMonitor: ClockJumpMonitor;
  readonly #devices = new Map<DeviceId, Device>();
  readonly #datastreams = new Map<DatastreamId, Datastream>();
  readonly #assets = new Map<AssetId, Asset>();
  readonly #applications = new Map<ApplicationId, Application<object>>();
  readonly #parents = new Map<string, EntityRef>();
  readonly #children = new Map<string, EntityRef[]>();
  readonly #datafeeds = new Map<string, Readonly<Record<string, EntityRef>>>();
  readonly #pluginTypes = new Map<string, PluginTypeId>();
  readonly #pluginVersions = new Map<string, number>();
  readonly #activeOperations = new Set<Promise<unknown>>();
  #dirty = false;
  #changeVersion = 0;
  #resetPromise: Promise<void> | undefined;
  #closePromise: Promise<void> | undefined;

  public readonly id: EngineId;
  readonly #configuration: EngineConfiguration;

  public constructor(
    configuration: EngineConfiguration,
    private readonly dependencies: EngineDependencies,
    restored?: PersistedEngineSnapshot,
  ) {
    this.id = configuration.engineId;
    this.#configuration = structuredClone(configuration);
    const suppliedLifecycle = (dependencies as InternalEngineDependencies)[lifecycleBootstrap];
    this.#lifecycle =
      suppliedLifecycle ?? new EngineLifecycleController(this.id, dependencies.clock);
    this.#diagnostics = new DiagnosticRegistry(
      dependencies.clock,
      this.#lifecycle.eventBus,
      restored?.diagnostics,
      () => this.markDirty(),
    );
    this.#datastreamStaleScheduler = new DatastreamStaleScheduler(
      dependencies.clock,
      dependencies.timers,
      () => [...this.#datastreams.values()],
      (result) => this.recordStaleTaskResult(result),
    );
    this.#applicationScheduler = new ApplicationScheduler(
      dependencies.clock,
      dependencies.timers,
      () => [...this.#applications.values()],
      (result) => this.recordApplicationTaskResult(result),
    );
    this.#clockJumpMonitor = new ClockJumpMonitor(
      dependencies.clock,
      dependencies.timers,
      this.clockJumpThresholdMs(),
      (jump) => this.coldReset(jump),
    );
    try {
      Engine.preflight(configuration, dependencies.plugins);
      this.recordSessionStarted();
      this.construct(configuration, restored?.entityStates);
      this.#datastreamStaleScheduler.start();
      this.#applicationScheduler.start();
      this.#clockJumpMonitor.start();
      if (suppliedLifecycle === undefined) {
        this.#lifecycle.transition('ready');
      }
    } catch (error) {
      this.stopSchedulers();
      this.#lifecycle.transition('failed');
      throw error;
    }
  }

  public static async create(
    configuration: EngineConfiguration,
    dependencies: PersistentEngineDependencies,
  ): Promise<Engine> {
    const lifecycle = new EngineLifecycleController(
      configuration.engineId,
      dependencies.clock,
      dependencies.lifecycleListener,
    );
    let engine: Engine | undefined;
    try {
      Engine.preflight(configuration, dependencies.plugins);
      const raw = await dependencies.stateStore.load<unknown>(
        engineSnapshotKey(configuration.engineId),
      );
      let restored: PersistedEngineSnapshot | undefined;
      let recoveryError: StateMigrationError | undefined;
      if (raw !== undefined) {
        try {
          restored = preparePersistedSnapshot(
            raw,
            configuration,
            dependencies.plugins,
            dependencies.snapshotMigrations,
          );
        } catch (error) {
          if (!(error instanceof StateMigrationError)) {
            throw error;
          }
          await dependencies.stateStore.save(engineCorruptSnapshotKey(configuration.engineId), raw);
          recoveryError = error;
        }
      }

      const engineDependencies: InternalEngineDependencies = {
        ...dependencies,
        [lifecycleBootstrap]: lifecycle,
      };
      engine = new Engine(configuration, engineDependencies, restored);
      if (recoveryError !== undefined) {
        engine.recordStateRecovery(recoveryError);
      }
      await engine.save();
      await engine.removeObsoleteEntityKeys();
      lifecycle.transition('ready');
      return engine;
    } catch (error) {
      engine?.stopSchedulers();
      lifecycle.transition('failed');
      throw error;
    }
  }

  public get lifecycleState(): EngineLifecycleState {
    return this.#lifecycle.state;
  }

  public get isReady(): boolean {
    return this.#lifecycle.isReady;
  }

  public get sessionId(): string {
    return this.#lifecycle.sessionId;
  }

  public get sessionStartTs(): number {
    return this.#lifecycle.sessionStartTs;
  }

  public get dirty(): boolean {
    return this.#dirty;
  }

  public markDirty(): void {
    this.#dirty = true;
    this.#changeVersion += 1;
  }

  public async save(): Promise<void> {
    const store = this.dependencies.stateStore;
    if (store === undefined) {
      throw new Error('Engine does not have a StateStore');
    }

    const savedVersion = this.#changeVersion;
    await store.save(engineSnapshotKey(this.id), this.toPersistence());
    if (this.#changeVersion === savedVersion) {
      this.#dirty = false;
    }
  }

  public registry(): EngineRegistryView {
    return Object.freeze({
      devices: freezeIds(this.#devices.keys()),
      datastreams: freezeIds(this.#datastreams.keys()),
      assets: freezeIds(this.#assets.keys()),
      applications: freezeIds(this.#applications.keys()),
    });
  }

  public subscribe(
    patterns: EventPattern | readonly EventPattern[],
    listener: EventListener,
  ): Unsubscribe {
    return this.#lifecycle.subscribe(patterns, listener);
  }

  public runApplication(id: ApplicationId): Promise<ApplicationRunOutcome> {
    if (!this.isReady) {
      throw new Error('Engine is not ready');
    }
    const application = this.#applications.get(id);
    if (application === undefined) {
      throw new Error(`Unknown Application: ${id}`);
    }
    return this.trackOperation(application.runIfDue());
  }

  public ingest(input: EngineIngestInput): Promise<boolean> {
    if (!this.isReady) {
      throw new Error('Engine is not ready');
    }
    const commonScope = this.#diagnostics.createScope({
      category: 'Common',
      sourceId: this.id,
      ownerScope: 'engine-ingest',
      source: { engineId: this.id },
    });
    const deviceId = input.deviceId;
    const device = deviceId === undefined ? undefined : this.#devices.get(deviceId);
    if (deviceId === undefined || device === undefined) {
      commonScope.report({
        code: 'DEVICE_NOT_RECOGNIZED',
        severity: 'error',
        message:
          deviceId === undefined
            ? 'Input does not identify a Device'
            : `Input references unknown Device ${deviceId}`,
        details: {
          source: input.source ?? 'unknown',
          ...(deviceId === undefined ? {} : { deviceId }),
        },
      });
      commonScope.complete();
      return Promise.resolve(false);
    }
    commonScope.complete();

    const pluginType = this.#configuration.devices[deviceId]?.type;
    const envelopeScope = this.#diagnostics.createScope({
      category: 'Device',
      sourceId: deviceId,
      ownerScope: 'ingest-envelope',
      source: {
        engineId: this.id,
        entityType: EntityKind.Device,
        entityId: deviceId,
        ...(pluginType === undefined ? {} : { pluginType }),
      },
    });
    for (const issue of input.issues ?? []) {
      if (issue === 'NO_GATEWAY_TIME') {
        envelopeScope.report({
          code: issue,
          severity: 'error',
          message: 'Gateway time is missing; received time was used',
        });
      } else if (issue === 'INVALID_GATEWAY_TIME') {
        envelopeScope.report({
          code: issue,
          severity: 'error',
          message: 'Gateway time is invalid; received time was used',
        });
      }
    }
    envelopeScope.complete();
    return this.trackOperation(device.parsePayload(input));
  }

  public checkClock(): Promise<boolean> {
    if (!this.isReady) {
      throw new Error('Engine is not ready');
    }
    return this.#clockJumpMonitor.checkNow();
  }

  public close(): Promise<void> {
    if (this.#closePromise !== undefined) {
      return this.#closePromise;
    }
    const close = this.performClose();
    this.#closePromise = close;
    return close;
  }

  public snapshot(
    request: SnapshotRequest,
    eventSource?: EntityEventSource,
  ): EngineSnapshotResponse {
    const refs = this.resolveSnapshotRefs(request, eventSource);
    const missingPaths: MissingStatePath[] = [];
    const entities = refs.map((ref) => {
      const view = this.entitySnapshot(ref, request.statePaths);
      missingPaths.push(...view.missingPaths.map((path) => ({ entity: { ...ref }, path })));
      return view.snapshot;
    });

    if (request.strictPaths && missingPaths.length > 0) {
      throw new SnapshotPathError(deepFreezeSnapshot(structuredClone(missingPaths)));
    }

    return deepFreezeSnapshot({
      entities,
      ...(request.target.scope === 'all' ? { diagnostics: this.diagnosticGroups() } : {}),
      missingPaths,
    });
  }

  private static preflight(configuration: EngineConfiguration, plugins: PluginRegistry): void {
    const entityIds = new Set<string>();
    for (const [deviceId, deviceConfiguration] of Object.entries(configuration.devices)) {
      Engine.assertUnique(entityIds, 'device', deviceId);
      const plugin = plugins.resolveDevice(deviceConfiguration.type);
      for (const datastreamName of Object.keys(deviceConfiguration.datastreams ?? {})) {
        Engine.assertUnique(entityIds, 'datastream', qualifiedId(deviceId, datastreamName));
        if (!plugin.datastreams.includes(datastreamName)) {
          throw new Error(`Device ${deviceId} has undeclared Datastream: ${datastreamName}`);
        }
      }
    }

    for (const [assetId, assetConfiguration] of Object.entries(configuration.assets)) {
      Engine.assertUnique(entityIds, 'asset', assetId);
      for (const applicationConfiguration of assetConfiguration.applications) {
        const applicationId = qualifiedId(assetId, applicationConfiguration.id);
        Engine.assertUnique(entityIds, 'application', applicationId);
        const plugin = plugins.resolveApplication(applicationConfiguration.type);
        for (const requiredDatafeed of plugin.requiredDatafeeds) {
          if (!(requiredDatafeed in applicationConfiguration.datafeeds)) {
            throw new Error(
              `Application ${applicationId} is missing datafeed: ${requiredDatafeed}`,
            );
          }
        }
        for (const target of Object.values(applicationConfiguration.datafeeds)) {
          if (!entityIds.has(`datastream:${target}`)) {
            throw new Error(
              `Application ${applicationId} references unknown Datastream: ${target}`,
            );
          }
        }
      }
    }
  }

  private construct(configuration: EngineConfiguration, restored?: EngineEntityStates): void {
    const sessionStartTimestamp = this.sessionStartTs;
    for (const [deviceName, deviceConfiguration] of Object.entries(configuration.devices)) {
      const id = asDeviceId(deviceName);
      const plugin = this.dependencies.plugins.resolveDevice(deviceConfiguration.type);
      const parser = requireDeviceParser(
        plugin.create({ id, settings: deviceConfiguration.settings }),
        plugin.type,
      );
      const device = new Device(
        { id, engineId: this.id, pluginType: plugin.type },
        parser,
        this.dependencies.clock,
        this.#lifecycle.eventBus,
        this.#diagnostics,
        this,
        this.dependencies.timers,
        restored?.devices[deviceName] as RestoredDeviceState | undefined,
      );
      this.#devices.set(id, device);
      this.#pluginTypes.set(entityKey({ kind: EntityKind.Device, id }), plugin.type);
      this.#pluginVersions.set(entityKey({ kind: EntityKind.Device, id }), plugin.version);

      for (const [datastreamName, datastreamConfiguration] of Object.entries(
        deviceConfiguration.datastreams ?? {},
      )) {
        const datastreamId = asDatastreamId(qualifiedId(deviceName, datastreamName));
        const datastream = new Datastream(
          {
            id: datastreamId,
            engineId: this.id,
            pluginType: plugin.type,
            ...datastreamConfiguration,
            sessionStartTimestamp,
          },
          this.dependencies.clock,
          this.#lifecycle.eventBus,
          this.#diagnostics,
          this,
          restored?.datastreams[datastreamId] as RestoredDatastreamState | undefined,
          device,
        );
        this.#datastreams.set(datastreamId, datastream);
        device.registerDatastream(datastreamName, datastream);
        const deviceRef: EntityRef = { kind: EntityKind.Device, id };
        const datastreamRef: EntityRef = { kind: EntityKind.Datastream, id: datastreamId };
        this.addRelationship(deviceRef, datastreamRef);
        this.#pluginTypes.set(entityKey(datastreamRef), plugin.type);
        this.#pluginVersions.set(entityKey(datastreamRef), plugin.version);
      }
      device.recompute();
    }

    for (const assetName of Object.keys(configuration.assets)) {
      const id = asAssetId(assetName);
      const asset = new Asset(
        { id, engineId: this.id },
        this.dependencies.clock,
        this.#lifecycle.eventBus,
        this,
        this.dependencies.timers,
        restored?.assets[assetName] as RestoredAssetState | undefined,
      );
      this.#assets.set(id, asset);
    }

    for (const [assetName, assetConfiguration] of Object.entries(configuration.assets)) {
      const asset = this.#assets.get(asAssetId(assetName));
      if (asset === undefined) {
        throw new Error(`Unknown Asset during construction: ${assetName}`);
      }
      for (const applicationConfiguration of assetConfiguration.applications) {
        const id = asApplicationId(qualifiedId(assetName, applicationConfiguration.id));
        const plugin = this.dependencies.plugins.resolveApplication(applicationConfiguration.type);
        const datafeeds = Object.fromEntries(
          Object.entries(applicationConfiguration.datafeeds).map(([name, target]) => {
            const datastream = this.#datastreams.get(asDatastreamId(target));
            if (datastream === undefined) {
              throw new Error(`Application ${id} references unknown Datastream: ${target}`);
            }
            return [name, datastream];
          }),
        );
        const evaluator = requireApplicationEvaluator(
          plugin.create({
            id,
            settings: applicationConfiguration.settings,
            ...(restored?.applications[id]?.pluginState === undefined
              ? {}
              : { restoredState: restored.applications[id].pluginState }),
            datafeeds: applicationConfiguration.datafeeds,
          }),
          plugin.type,
        );
        const application = new Application(
          {
            id,
            engineId: this.id,
            pluginType: plugin.type,
            runIntervalMs: applicationConfiguration.runIntervalMs,
          },
          datafeeds,
          evaluator,
          this.dependencies.clock,
          this.#lifecycle.eventBus,
          this.#diagnostics,
          this,
          plugin.defaultState,
          restored?.applications[id] as RestoredApplicationState<object> | undefined,
          asset,
        );
        this.#applications.set(id, application);
        asset.registerApplication(application);
        const assetRef: EntityRef = { kind: EntityKind.Asset, id: asAssetId(assetName) };
        const applicationRef: EntityRef = { kind: EntityKind.Application, id };
        this.addRelationship(assetRef, applicationRef);
        this.#datafeeds.set(
          entityKey(applicationRef),
          Object.fromEntries(
            Object.entries(applicationConfiguration.datafeeds).map(([name, target]) => [
              name,
              { kind: EntityKind.Datastream, id: asDatastreamId(target) } satisfies EntityRef,
            ]),
          ),
        );
        this.#pluginTypes.set(entityKey(applicationRef), plugin.type);
        this.#pluginVersions.set(entityKey(applicationRef), plugin.version);
      }
      asset.recompute();
    }
  }

  private static assertUnique(ids: Set<string>, kind: string, id: string): void {
    const key = `${kind}:${id}`;
    if (ids.has(key)) {
      throw new Error(`Duplicate ${kind} ID: ${id}`);
    }
    ids.add(key);
  }

  private addRelationship(parent: EntityRef, child: EntityRef): void {
    this.#parents.set(entityKey(child), parent);
    const children = this.#children.get(entityKey(parent)) ?? [];
    children.push(child);
    this.#children.set(entityKey(parent), children);
  }

  private resolveSnapshotRefs(
    request: SnapshotRequest,
    eventSource: EntityEventSource | undefined,
  ): readonly EntityRef[] {
    if (request.target.scope === 'all') {
      return this.allEntityRefs();
    }

    let selected: EntityRef;
    if (request.target.scope === 'eventSource') {
      if (eventSource === undefined || eventSource.engineId !== this.id) {
        throw new SnapshotRequestError(
          'Snapshot event source is missing or belongs to another Engine',
        );
      }
      selected = { kind: eventSource.entityType, id: eventSource.entityId } as EntityRef;
    } else {
      selected = {
        kind: request.target.entityType,
        id: request.target.entityId,
      } as EntityRef;
    }
    if (!this.hasEntity(selected)) {
      throw new SnapshotRequestError(`Unknown entity: ${selected.kind}:${selected.id}`);
    }

    switch (request.relations ?? 'self') {
      case 'self':
        return [selected];
      case 'parent': {
        const parent = this.#parents.get(entityKey(selected));
        return parent === undefined ? [] : [parent];
      }
      case 'children':
        return [...(this.#children.get(entityKey(selected)) ?? [])];
      case 'family': {
        const parent = this.#parents.get(entityKey(selected));
        return [
          selected,
          ...(parent === undefined ? [] : [parent]),
          ...(this.#children.get(entityKey(selected)) ?? []),
        ];
      }
    }
  }

  private allEntityRefs(): readonly EntityRef[] {
    return [
      ...[...this.#devices.keys()].map((id) => ({ kind: EntityKind.Device, id }) as const),
      ...[...this.#datastreams.keys()].map((id) => ({ kind: EntityKind.Datastream, id }) as const),
      ...[...this.#applications.keys()].map(
        (id) => ({ kind: EntityKind.Application, id }) as const,
      ),
      ...[...this.#assets.keys()].map((id) => ({ kind: EntityKind.Asset, id }) as const),
    ];
  }

  private hasEntity(ref: EntityRef): boolean {
    switch (ref.kind) {
      case EntityKind.Device:
        return this.#devices.has(ref.id);
      case EntityKind.Datastream:
        return this.#datastreams.has(ref.id);
      case EntityKind.Asset:
        return this.#assets.has(ref.id);
      case EntityKind.Application:
        return this.#applications.has(ref.id);
    }
  }

  private entitySnapshot(
    ref: EntityRef,
    statePaths: readonly string[] | undefined,
  ): { readonly snapshot: EntitySnapshot; readonly missingPaths: readonly string[] } {
    const projected = projectSnapshotState(this.entityState(ref), statePaths);
    const parent = this.#parents.get(entityKey(ref));
    const datafeeds = this.#datafeeds.get(entityKey(ref));
    const pluginType = this.#pluginTypes.get(entityKey(ref));
    return {
      snapshot: {
        entityType: ref.kind,
        entityId: ref.id,
        ...(pluginType === undefined ? {} : { pluginType }),
        relationships: {
          ...(parent === undefined ? {} : { parent: { ...parent } }),
          children: (this.#children.get(entityKey(ref)) ?? []).map((child) => ({ ...child })),
          ...(datafeeds === undefined ? {} : { datafeeds: structuredClone(datafeeds) }),
        },
        state: projected.state,
      },
      missingPaths: projected.missingPaths,
    };
  }

  private entityState(ref: EntityRef): object {
    let state: object | undefined;
    switch (ref.kind) {
      case EntityKind.Device:
        state = this.#devices.get(ref.id)?.state();
        break;
      case EntityKind.Datastream:
        state = this.#datastreams.get(ref.id)?.state();
        break;
      case EntityKind.Asset:
        state = this.#assets.get(ref.id)?.state();
        break;
      case EntityKind.Application:
        state = this.#applications.get(ref.id)?.state();
        break;
    }
    if (state === undefined) {
      throw new SnapshotRequestError(`Unknown entity: ${ref.kind}:${ref.id}`);
    }
    return state;
  }

  private diagnosticGroups(): SnapshotDiagnosticGroups {
    return {
      Common: this.#diagnostics.records('Common'),
      Device: this.#diagnostics.records('Device'),
      Datastream: this.#diagnostics.records('Datastream'),
      Application: this.#diagnostics.records('Application'),
      Asset: this.#diagnostics.records('Asset'),
    };
  }

  private toPersistence(): PersistedEngineSnapshot {
    const entityStates: EngineEntityStates = {
      devices: Object.fromEntries([...this.#devices].map(([id, device]) => [id, device.state()])),
      datastreams: Object.fromEntries(
        [...this.#datastreams].map(([id, datastream]) => [id, datastream.state()]),
      ),
      assets: Object.fromEntries([...this.#assets].map(([id, asset]) => [id, asset.state()])),
      applications: Object.fromEntries(
        [...this.#applications].map(([id, application]) => [id, application.state()]),
      ),
    };
    return {
      schemaVersion: ENGINE_SNAPSHOT_SCHEMA_VERSION,
      entityStates,
      diagnostics: this.#diagnostics.toPersistence(),
      pluginVersions: {
        applications: Object.fromEntries(
          [...this.#applications.keys()].map((id) => {
            const version = this.#pluginVersions.get(
              entityKey({ kind: EntityKind.Application, id }),
            );
            if (version === undefined) {
              throw new Error(`Missing plugin version for Application ${id}`);
            }
            return [id, version];
          }),
        ),
      },
    };
  }

  private recordStateRecovery(error: StateMigrationError): void {
    this.#diagnostics.observe({
      category: 'Common',
      sourceId: this.id,
      ownerScope: 'engine-persistence',
      code: PERSISTED_STATE_RECOVERY_DIAGNOSTIC,
      severity: 'warning',
      message: 'Persisted state could not be restored; defaults were initialized',
      retention: 'session',
      details: { reason: error.message },
      source: { engineId: this.id },
    });
  }

  private recordSessionStarted(): void {
    this.#diagnostics.observe({
      category: 'Common',
      sourceId: this.id,
      ownerScope: 'engine-lifecycle',
      code: 'SYSTEM_STARTED',
      severity: 'info',
      message: 'Engine session started',
      retention: 'session',
      details: { sessionId: this.sessionId, sessionStartTs: this.sessionStartTs },
      source: { engineId: this.id },
    });
  }

  private recordClockJump(jump: ClockJump): void {
    this.#diagnostics.observe({
      category: 'Common',
      sourceId: this.id,
      ownerScope: 'engine-lifecycle',
      code: 'CLOCK_JUMP_RESET',
      severity: 'warning',
      message: 'Engine cold reset after a large wall-clock jump',
      retention: 'session',
      details: { ...jump },
      source: { engineId: this.id },
    });
  }

  private recordStaleTaskResult({ task, error }: DatastreamStaleTaskResult): void {
    const pluginType = this.#pluginTypes.get(
      entityKey({ kind: EntityKind.Datastream, id: task.id }),
    );
    const source: EntityEventSource = {
      engineId: this.id,
      entityType: EntityKind.Datastream,
      entityId: task.id,
      ...(pluginType === undefined ? {} : { pluginType }),
    };
    const scope = this.#diagnostics.createScope({
      category: 'Datastream',
      sourceId: task.id,
      ownerScope: 'stale-scheduler',
      source,
    });
    if (error !== undefined) {
      scope.report({
        code: 'STALE_CHECK_FAILED',
        severity: 'error',
        message: 'Datastream stale check failed',
        details: { error: error instanceof Error ? error.message : String(error) },
      });
    }
    scope.complete();
  }

  private recordApplicationTaskResult({ task, error }: ApplicationTaskResult): void {
    const pluginType = this.#pluginTypes.get(
      entityKey({ kind: EntityKind.Application, id: task.id }),
    );
    const source: EntityEventSource = {
      engineId: this.id,
      entityType: EntityKind.Application,
      entityId: task.id,
      ...(pluginType === undefined ? {} : { pluginType }),
    };
    const scope = this.#diagnostics.createScope({
      category: 'Application',
      sourceId: task.id,
      ownerScope: 'application-scheduler',
      source,
    });
    if (error !== undefined) {
      scope.report({
        code: 'APPLICATION_SCHEDULER_TASK_FAILED',
        severity: 'error',
        message: 'Application scheduler task failed',
        details: { error: error instanceof Error ? error.message : String(error) },
      });
    }
    scope.complete();
  }

  private stopSchedulers(): void {
    this.#datastreamStaleScheduler.stop();
    this.#applicationScheduler.stop();
    this.#clockJumpMonitor.stop();
  }

  private startSchedulers(): void {
    this.#datastreamStaleScheduler.start();
    this.#applicationScheduler.start();
    this.#clockJumpMonitor.start();
  }

  private clockJumpThresholdMs(): number {
    if (this.#configuration.clockJumpThresholdMs !== undefined) {
      return this.#configuration.clockJumpThresholdMs;
    }
    const horizons = Object.values(this.#configuration.devices).flatMap((device) =>
      Object.values(device.datastreams ?? {}).map(({ maxBufferAgeMs }) => maxBufferAgeMs),
    );
    return horizons.length === 0 ? DEFAULT_CLOCK_JUMP_THRESHOLD_MS : Math.max(...horizons);
  }

  private async coldReset(jump: ClockJump): Promise<void> {
    if (this.#resetPromise !== undefined) {
      return this.#resetPromise;
    }
    const reset = this.performColdReset(jump);
    this.#resetPromise = reset;
    try {
      await reset;
    } finally {
      if (this.#resetPromise === reset) {
        this.#resetPromise = undefined;
      }
    }
  }

  private async performColdReset(jump: ClockJump): Promise<void> {
    this.#lifecycle.transition('resetting');
    this.stopSchedulers();
    try {
      for (const device of this.#devices.values()) {
        device.close();
      }
      for (const asset of this.#assets.values()) {
        asset.close();
      }

      const store = this.dependencies.stateStore;
      if (store === undefined) {
        throw new Error('Engine does not have a StateStore');
      }
      const keys = await store.keys(engineStateKeyPrefix(this.id));
      await Promise.all(keys.map((key) => store.delete(key)));

      this.#diagnostics.clearAll();
      this.clearObjectGraph();
      this.#lifecycle.beginSession();
      this.recordSessionStarted();
      this.recordClockJump(jump);
      this.construct(this.#configuration);
      this.markDirty();
      await this.save();
      this.startSchedulers();
      this.#lifecycle.transition('ready');
    } catch (error) {
      this.stopSchedulers();
      this.#lifecycle.transition('failed');
      throw error;
    }
  }

  private clearObjectGraph(): void {
    this.#devices.clear();
    this.#datastreams.clear();
    this.#assets.clear();
    this.#applications.clear();
    this.#parents.clear();
    this.#children.clear();
    this.#datafeeds.clear();
    this.#pluginTypes.clear();
    this.#pluginVersions.clear();
  }

  private trackOperation<Result>(operation: Promise<Result>): Promise<Result> {
    const tracked = operation.finally(() => this.#activeOperations.delete(tracked));
    this.#activeOperations.add(tracked);
    return tracked;
  }

  private async drainOperations(): Promise<void> {
    await this.#applicationScheduler.drain();
    await Promise.allSettled([...this.#activeOperations]);
  }

  private async performClose(): Promise<void> {
    this.#lifecycle.transition('stopping');
    this.stopSchedulers();
    try {
      if (this.#resetPromise !== undefined) {
        await this.#resetPromise.catch(() => undefined);
        this.#lifecycle.transition('stopping');
        this.stopSchedulers();
      }
      await this.drainOperations();
      for (const device of this.#devices.values()) {
        device.close();
      }
      for (const asset of this.#assets.values()) {
        asset.close();
      }
      await this.save();
    } finally {
      this.stopSchedulers();
      this.#lifecycle.close();
    }
  }

  private async removeObsoleteEntityKeys(): Promise<void> {
    const store = this.dependencies.stateStore;
    if (store === undefined) {
      return;
    }
    const expected = new Set([
      ...[...this.#devices.keys()].map((id) => entityStateKey(this.id, EntityKind.Device, id)),
      ...[...this.#datastreams.keys()].map((id) =>
        entityStateKey(this.id, EntityKind.Datastream, id),
      ),
      ...[...this.#assets.keys()].map((id) => entityStateKey(this.id, EntityKind.Asset, id)),
      ...[...this.#applications.keys()].map((id) =>
        entityStateKey(this.id, EntityKind.Application, id),
      ),
    ]);
    const entityPrefix = `${engineStateKeyPrefix(this.id)}entity/`;
    const obsolete = (await store.keys(entityPrefix)).filter((key) => !expected.has(key));
    await Promise.all(obsolete.map((key) => store.delete(key)));
  }
}
