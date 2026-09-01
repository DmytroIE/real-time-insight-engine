import type { ApplicationId, AssetId, DatastreamId, DeviceId } from './identifiers';

export enum EntityKind {
  Device = 'device',
  Datastream = 'datastream',
  Asset = 'asset',
  Application = 'application',
}

export enum ProcessState {
  Undefined = 0,
  Ok = 1,
  Warning = 2,
  Error = 3,
}

export type EntityId = DeviceId | DatastreamId | AssetId | ApplicationId;

export type EntityRef =
  | { readonly kind: EntityKind.Device; readonly id: DeviceId }
  | { readonly kind: EntityKind.Datastream; readonly id: DatastreamId }
  | { readonly kind: EntityKind.Asset; readonly id: AssetId }
  | { readonly kind: EntityKind.Application; readonly id: ApplicationId };
