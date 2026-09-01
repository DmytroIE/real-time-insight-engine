import type { EngineId, PluginTypeId } from './identifiers';

export interface DatastreamConfiguration {
  readonly maxBufferLength: number;
  readonly maxBufferAgeMs: number;
  readonly expectedIntervalMs: number;
}

export interface DeviceConfiguration {
  readonly type: PluginTypeId;
  readonly settings?: unknown;
  readonly datastreams?: Readonly<Record<string, DatastreamConfiguration>>;
}

export interface ApplicationConfiguration {
  readonly id: string;
  readonly type: PluginTypeId;
  readonly runIntervalMs: number;
  readonly settings?: unknown;
  readonly datafeeds: Readonly<Record<string, string>>;
}

export interface AssetConfiguration {
  readonly applications: readonly ApplicationConfiguration[];
}

export interface EngineConfiguration {
  readonly engineId: EngineId;
  readonly clockJumpThresholdMs?: number;
  readonly devices: Readonly<Record<string, DeviceConfiguration>>;
  readonly assets: Readonly<Record<string, AssetConfiguration>>;
}
