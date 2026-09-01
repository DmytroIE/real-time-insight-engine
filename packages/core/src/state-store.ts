import type { EngineId } from './identifiers';
import type { EntityId, EntityKind } from './model';
import type { ApplicationState } from './application';
import type { AssetState } from './asset';
import type { DatastreamState } from './datastream';
import type { PersistedDiagnostic } from './diagnostics';
import type { DeviceState } from './device';

export const ENGINE_SNAPSHOT_SCHEMA_VERSION = 1;

export interface StateStore {
  load<Value>(key: string): Promise<Value | undefined>;
  save<Value>(key: string, value: Value): Promise<void>;
  delete(key: string): Promise<void>;
  keys(prefix: string): Promise<string[]>;
}

export interface VersionedStateSnapshot<State> {
  readonly schemaVersion: number;
  readonly state: State;
}

export interface VersionedEngineSnapshot<EntityStates, Diagnostics> {
  readonly schemaVersion: number;
  readonly entityStates: EntityStates;
  readonly diagnostics: Diagnostics;
}

export interface EnginePluginVersions {
  readonly applications: Readonly<Record<string, number>>;
}

export interface EngineSnapshotMigration {
  readonly fromVersion: number;
  readonly toVersion: number;
  migrate(snapshot: unknown): unknown;
}

export interface EngineEntityStates {
  readonly devices: Readonly<Record<string, DeviceState>>;
  readonly datastreams: Readonly<Record<string, DatastreamState>>;
  readonly assets: Readonly<Record<string, AssetState>>;
  readonly applications: Readonly<Record<string, ApplicationState<object>>>;
}

export interface PersistedEngineSnapshot extends VersionedEngineSnapshot<
  EngineEntityStates,
  readonly PersistedDiagnostic[]
> {
  readonly pluginVersions: EnginePluginVersions;
}

const keySegment = (value: string): string => encodeURIComponent(value);

export const engineStateKeyPrefix = (engineId: EngineId): string =>
  `engine/${keySegment(engineId)}/`;

export const engineSnapshotKey = (engineId: EngineId): string =>
  `${engineStateKeyPrefix(engineId)}snapshot`;

export const engineCorruptSnapshotKey = (engineId: EngineId): string =>
  `${engineStateKeyPrefix(engineId)}snapshot.corrupt`;

export const entityStateKey = (
  engineId: EngineId,
  entityKind: EntityKind,
  entityId: EntityId,
): string =>
  `${engineStateKeyPrefix(engineId)}entity/${keySegment(entityKind)}/${keySegment(entityId)}`;

export const diagnosticStateKey = (engineId: EngineId): string =>
  `${engineStateKeyPrefix(engineId)}diagnostics`;
