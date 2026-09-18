import type { EngineId, PluginTypeId } from './identifiers';

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;

export interface DatastreamConfiguration {
  readonly maxBufferLength: number;
  readonly maxBufferAgeMs: number;
  readonly expectedIntervalMs: number;
  readonly gracePeriodCoefficient?: number;
  readonly extra?: JsonValue;
}

export const DEFAULT_DATASTREAM_CONFIGURATION: Readonly<
  Pick<DatastreamConfiguration, 'maxBufferLength' | 'maxBufferAgeMs' | 'expectedIntervalMs'>
> = {
  maxBufferLength: 10,
  maxBufferAgeMs: 600_000,
  expectedIntervalMs: 60_000,
};

export const DEFAULT_APPLICATION_RUN_INTERVAL_MS = 600_000;

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
  readonly extra?: JsonValue;
}

export interface ApplicationConfiguration {
  readonly id: string;
  readonly type: PluginTypeId;
  readonly runIntervalMs: number;
  readonly settings?: unknown;
  readonly datafeeds: Readonly<Record<string, DatafeedReference | string>>;
  readonly extra?: JsonValue;
}

export interface AssetConfiguration {
  readonly applications: readonly ApplicationConfiguration[];
  readonly extra?: JsonValue;
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
