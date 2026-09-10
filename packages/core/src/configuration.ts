import type { EngineId, PluginTypeId } from './identifiers';

export interface DatastreamConfiguration {
  readonly maxBufferLength: number;
  readonly maxBufferAgeMs: number;
  readonly expectedIntervalMs: number;
  readonly gracePeriodCoefficient?: number;
}

export interface DatafeedReference {
  readonly device: string;
  readonly datastream: string;
}

export interface ApplicationConfigurationDefaults {
  readonly runIntervalMs?: number;
  readonly settings?: unknown;
  readonly datafeedDatastreams?: Readonly<Record<string, Partial<DatastreamConfiguration>>>;
}

export interface DeviceConfigurationDefaults {
  readonly settings?: unknown;
  readonly datastreams?: Readonly<Record<string, Partial<DatastreamConfiguration>>>;
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
  readonly datafeeds: Readonly<Record<string, DatafeedReference | string>>;
}

export interface AssetConfiguration {
  readonly applications: readonly ApplicationConfiguration[];
}

export interface SchedulerConfiguration {
  readonly batchSize?: number;
  readonly failureRetryDelayMs?: number;
}

export const applicationConfigurationEntries = (
  asset: AssetConfiguration,
): readonly [string, ApplicationConfiguration][] =>
  asset.applications.map((application) => [application.id, application]);

export interface EngineConfiguration {
  readonly engineId: EngineId;
  readonly clockJumpThresholdMs?: number;
  readonly applicationScheduler?: SchedulerConfiguration;
  readonly datastreamStaleScheduler?: SchedulerConfiguration;
  readonly applicationDefaults?: Readonly<Record<PluginTypeId, ApplicationConfigurationDefaults>>;
  readonly deviceDefaults?: Readonly<Record<PluginTypeId, DeviceConfigurationDefaults>>;
  readonly devices: Readonly<Record<string, DeviceConfiguration>>;
  readonly assets: Readonly<Record<string, AssetConfiguration>>;
}
