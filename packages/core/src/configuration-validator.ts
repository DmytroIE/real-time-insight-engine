import Ajv, { type AnySchema, type ErrorObject, type ValidateFunction } from 'ajv';

import { asPluginTypeId, type EngineId, type PluginTypeId } from './identifiers';
import type { PluginRegistry, ApplicationPlugin, DevicePlugin, InstalledPlugin } from './plugins';
import type {
  ApplicationConfigurationDefaults,
  ApplicationConfiguration,
  AssetConfiguration,
  DatastreamConfiguration,
  DeviceConfigurationDefaults,
  DeviceConfiguration,
  EngineConfiguration,
} from './configuration';

const idPattern = '^[A-Za-z0-9][A-Za-z0-9._-]*$';

const datastreamProperties = {
  maxBufferLength: { type: 'integer', minimum: 1 },
  maxBufferAgeMs: { type: 'integer', minimum: 1 },
  expectedIntervalMs: { type: 'integer', minimum: 1 },
  gracePeriodCoefficient: { type: 'number', exclusiveMinimum: 0 },
} as const;

const datastreamDefaultsSchema = {
  type: 'object',
  additionalProperties: false,
  properties: datastreamProperties,
} as const;

const datastreamSchema = {
  ...datastreamDefaultsSchema,
  required: ['maxBufferLength', 'maxBufferAgeMs', 'expectedIntervalMs'],
} as const;

const engineConfigurationSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['devices', 'assets'],
  properties: {
    clockJumpThresholdMs: { type: 'integer', minimum: 1 },
    applicationDefaults: {
      type: 'object',
      propertyNames: { pattern: idPattern },
      additionalProperties: {
        type: 'object',
        additionalProperties: false,
        properties: {
          runIntervalMs: { type: 'integer', minimum: 1 },
          settings: {},
          datafeedDatastreams: {
            type: 'object',
            propertyNames: { pattern: idPattern },
            additionalProperties: datastreamDefaultsSchema,
          },
        },
      },
    },
    deviceDefaults: {
      type: 'object',
      propertyNames: { pattern: idPattern },
      additionalProperties: {
        type: 'object',
        additionalProperties: false,
        properties: {
          settings: {},
          datastreams: {
            type: 'object',
            propertyNames: { minLength: 1 },
            additionalProperties: datastreamDefaultsSchema,
          },
        },
      },
    },
    devices: {
      type: 'object',
      propertyNames: { minLength: 1 },
      additionalProperties: {
        type: 'object',
        additionalProperties: false,
        required: ['type'],
        properties: {
          type: { type: 'string', pattern: idPattern },
          settings: {},
          datastreams: {
            type: 'object',
            propertyNames: { minLength: 1 },
            additionalProperties: datastreamDefaultsSchema,
          },
        },
      },
    },
    assets: {
      type: 'object',
      propertyNames: { minLength: 1 },
      additionalProperties: {
        type: 'object',
        additionalProperties: false,
        required: ['applications'],
        properties: {
          applications: {
            type: 'object',
            propertyNames: { minLength: 1 },
            additionalProperties: {
              type: 'object',
              additionalProperties: false,
              required: ['type', 'datafeeds'],
              properties: {
                type: { type: 'string', pattern: idPattern },
                runIntervalMs: { type: 'integer', minimum: 1 },
                settings: {},
                datafeeds: {
                  type: 'object',
                  propertyNames: { pattern: idPattern },
                  additionalProperties: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['device', 'datastream'],
                    properties: {
                      device: { type: 'string', minLength: 1 },
                      datastream: { type: 'string', minLength: 1 },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
} as const;

interface RawDatastreamConfiguration {
  maxBufferLength?: number;
  maxBufferAgeMs?: number;
  expectedIntervalMs?: number;
  gracePeriodCoefficient?: number;
}

interface RawDeviceConfiguration {
  type: string;
  settings?: unknown;
  datastreams?: Record<string, RawDatastreamConfiguration>;
}

interface RawApplicationConfiguration {
  type: string;
  runIntervalMs?: number;
  settings?: unknown;
  datafeeds: Record<string, { device: string; datastream: string }>;
}

interface RawApplicationConfigurationDefaults {
  runIntervalMs?: number;
  settings?: unknown;
  datafeedDatastreams?: Record<string, RawDatastreamConfiguration>;
}

interface RawDeviceConfigurationDefaults {
  settings?: unknown;
  datastreams?: Record<string, RawDatastreamConfiguration>;
}

interface RawAssetConfiguration {
  applications: Record<string, RawApplicationConfiguration>;
}

interface RawEngineConfiguration {
  clockJumpThresholdMs?: number;
  applicationDefaults?: Record<string, RawApplicationConfigurationDefaults>;
  deviceDefaults?: Record<string, RawDeviceConfigurationDefaults>;
  devices: Record<string, RawDeviceConfiguration>;
  assets: Record<string, RawAssetConfiguration>;
}

export interface ConfigurationIssue {
  readonly path: string;
  readonly message: string;
}

export class ConfigurationValidationError extends Error {
  public constructor(public readonly issues: readonly ConfigurationIssue[]) {
    super(
      `Invalid engine configuration:\n${issues.map(({ path, message }) => `${path}: ${message}`).join('\n')}`,
    );
    this.name = 'ConfigurationValidationError';
  }
}

const appendPath = (path: string, property: string): string => {
  if (/^\d+$/.test(property)) {
    return `${path}[${property}]`;
  }
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(property)
    ? `${path}.${property}`
    : `${path}[${JSON.stringify(property)}]`;
};

const pointerToJsonPath = (pointer: string): string => {
  if (pointer === '') {
    return '$';
  }

  return pointer
    .split('/')
    .slice(1)
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'))
    .reduce(appendPath, '$');
};

const errorPath = (error: ErrorObject): string => {
  let path = pointerToJsonPath(error.instancePath);
  if (error.keyword === 'required') {
    path = appendPath(path, String(error.params['missingProperty']));
  } else if (error.keyword === 'additionalProperties') {
    path = appendPath(path, String(error.params['additionalProperty']));
  } else if (error.keyword === 'propertyNames') {
    path = appendPath(path, String(error.params['propertyName']));
  }
  return path;
};

const schemaIssues = (errors: readonly ErrorObject[] | null | undefined): ConfigurationIssue[] =>
  (errors ?? []).map((error) => ({
    path: errorPath(error),
    message: error.message ?? 'is invalid',
  }));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const mergeDefaults = (defaults: unknown, overrides: unknown): unknown => {
  if (overrides === undefined) {
    return structuredClone(defaults);
  }
  if (!isRecord(defaults) || !isRecord(overrides)) {
    return structuredClone(overrides);
  }

  const merged = structuredClone(defaults);
  for (const [key, value] of Object.entries(overrides)) {
    merged[key] = key in merged ? mergeDefaults(merged[key], value) : structuredClone(value);
  }
  return merged;
};

const fail = (path: string, message: string): never => {
  throw new ConfigurationValidationError([{ path, message }]);
};

interface ReferencedDatastream {
  readonly device: string;
  readonly datastream: string;
  readonly path: string;
}

type ApplicationDefaults = Readonly<Record<PluginTypeId, ApplicationConfigurationDefaults>>;
type DeviceDefaults = Readonly<Record<PluginTypeId, DeviceConfigurationDefaults>>;
type DatastreamDefaults = Record<string, Record<string, RawDatastreamConfiguration>>;

export class ConfigurationBuilder {
  readonly #ajv = new Ajv({ allErrors: true, strict: true, useDefaults: true });
  readonly #validateConfiguration: ValidateFunction;
  readonly #validateDatastream: ValidateFunction;
  readonly #settingsValidators = new Map<PluginTypeId, ValidateFunction>();
  readonly #registry: PluginRegistry;

  public constructor(registry: PluginRegistry) {
    this.#registry = registry;
    this.#validateConfiguration = this.#ajv.compile(engineConfigurationSchema);
    this.#validateDatastream = this.#ajv.compile(datastreamSchema);
  }

  public build(input: unknown, engineId: EngineId): EngineConfiguration {
    const clonedInput: unknown = structuredClone(input);
    if (!this.#validateConfiguration(clonedInput)) {
      throw new ConfigurationValidationError(schemaIssues(this.#validateConfiguration.errors));
    }

    const raw = clonedInput as RawEngineConfiguration;
    const applicationDefaults = this.buildApplicationDefaults(raw.applicationDefaults ?? {});
    const deviceDefaults = this.buildDeviceDefaults(raw.deviceDefaults ?? {});
    const referencedDatastreams: ReferencedDatastream[] = [];
    const applicationDatastreamDefaults: DatastreamDefaults = {};
    const assets = this.buildAssets(
      raw.assets,
      raw.devices,
      applicationDefaults,
      applicationDatastreamDefaults,
      referencedDatastreams,
    );
    const devices = this.buildDevices(raw.devices, deviceDefaults, applicationDatastreamDefaults);
    this.validateReferencedDatastreams(referencedDatastreams, devices);
    return {
      engineId,
      ...(raw.clockJumpThresholdMs === undefined
        ? {}
        : { clockJumpThresholdMs: raw.clockJumpThresholdMs }),
      devices,
      assets,
    };
  }

  private buildDevices(
    rawDevices: Record<string, RawDeviceConfiguration>,
    deviceDefaults: DeviceDefaults,
    applicationDatastreamDefaults: DatastreamDefaults,
  ): Record<string, DeviceConfiguration> {
    const devices: Record<string, DeviceConfiguration> = {};
    for (const [deviceId, rawDevice] of Object.entries(rawDevices)) {
      const path = appendPath('$.devices', deviceId);
      const plugin = this.resolveDevice(rawDevice.type, `${path}.type`);
      const typeDefaults = deviceDefaults[plugin.type];
      const explicitDatastreams = rawDevice.datastreams ?? {};
      const typeDatastreams = typeDefaults?.datastreams ?? {};
      const applicationDatastreams = applicationDatastreamDefaults[deviceId] ?? {};
      const datastreams: Record<string, DatastreamConfiguration> = {};
      for (const datastreamName of new Set([
        ...Object.keys(typeDatastreams),
        ...Object.keys(applicationDatastreams),
        ...Object.keys(explicitDatastreams),
      ])) {
        if (!plugin.datastreams.includes(datastreamName)) {
          fail(
            appendPath(`${path}.datastreams`, datastreamName),
            `is not declared by plugin ${plugin.type}`,
          );
        }
        const settings = {
          ...(typeDatastreams[datastreamName] ?? {}),
          ...(applicationDatastreams[datastreamName] ?? {}),
          ...(explicitDatastreams[datastreamName] ?? {}),
        };
        if (!this.#validateDatastream(settings)) {
          const issue = schemaIssues(this.#validateDatastream.errors)[0];
          fail(
            `${appendPath(`${path}.datastreams`, datastreamName)}${issue?.path.slice(1) ?? ''}`,
            issue?.message ?? 'is invalid',
          );
        }
        datastreams[datastreamName] = settings as DatastreamConfiguration;
      }

      devices[deviceId] = {
        type: plugin.type,
        settings: this.buildSettings(
          plugin,
          typeDefaults?.settings,
          rawDevice.settings,
          `${path}.settings`,
        ),
        datastreams,
      };
    }
    return devices;
  }

  private buildAssets(
    rawAssets: Record<string, RawAssetConfiguration>,
    rawDevices: Readonly<Record<string, RawDeviceConfiguration>>,
    applicationDefaults: ApplicationDefaults,
    applicationDatastreamDefaults: DatastreamDefaults,
    referencedDatastreams: ReferencedDatastream[],
  ): Record<string, AssetConfiguration> {
    const assets: Record<string, AssetConfiguration> = {};
    for (const [assetId, rawAsset] of Object.entries(rawAssets)) {
      const assetPath = appendPath('$.assets', assetId);
      const applications = Object.entries(rawAsset.applications).map(
        ([applicationName, rawApplication]) =>
          this.buildApplication(
            rawApplication,
            appendPath(`${assetPath}.applications`, applicationName),
            rawDevices,
            applicationName,
            applicationDefaults,
            applicationDatastreamDefaults,
            referencedDatastreams,
          ),
      );
      assets[assetId] = { applications };
    }
    return assets;
  }

  private buildApplication(
    raw: RawApplicationConfiguration,
    path: string,
    rawDevices: Readonly<Record<string, RawDeviceConfiguration>>,
    name: string,
    applicationDefaults: ApplicationDefaults,
    applicationDatastreamDefaults: DatastreamDefaults,
    referencedDatastreams: ReferencedDatastream[],
  ): ApplicationConfiguration {
    const plugin = this.resolveApplication(raw.type, `${path}.type`);
    const defaults = applicationDefaults[plugin.type];
    for (const requiredDatafeed of plugin.requiredDatafeeds) {
      if (!(requiredDatafeed in raw.datafeeds)) {
        fail(appendPath(`${path}.datafeeds`, requiredDatafeed), 'is required by the plugin');
      }
    }
    for (const [datafeed, target] of Object.entries(raw.datafeeds)) {
      const datafeedPath = appendPath(`${path}.datafeeds`, datafeed);
      this.validateDatafeedTarget(target, datafeedPath, rawDevices);
      this.mergeDatastreamDefaults(
        applicationDatastreamDefaults,
        target.device,
        target.datastream,
        defaults?.datafeedDatastreams?.[datafeed],
      );
      referencedDatastreams.push({ ...target, path: datafeedPath });
    }

    const runIntervalMs =
      raw.runIntervalMs ??
      defaults?.runIntervalMs ??
      fail(`${path}.runIntervalMs`, 'is required when no application default supplies it');

    return {
      id: name,
      type: plugin.type,
      runIntervalMs,
      settings: this.buildSettings(plugin, defaults?.settings, raw.settings, `${path}.settings`),
      datafeeds: raw.datafeeds,
    };
  }

  private validateDatafeedTarget(
    target: { device: string; datastream: string },
    path: string,
    devices: Readonly<Record<string, RawDeviceConfiguration>>,
  ): void {
    const device = devices[target.device];
    if (device === undefined) {
      throw new ConfigurationValidationError([
        { path, message: `references unavailable device ${target.device}` },
      ]);
    }
  }

  private buildApplicationDefaults(
    rawDefaults: Record<string, RawApplicationConfigurationDefaults>,
  ): ApplicationDefaults {
    const defaults: Record<PluginTypeId, ApplicationConfigurationDefaults> = {};
    for (const [type, value] of Object.entries(rawDefaults)) {
      const plugin = this.resolveApplication(type, appendPath('$.applicationDefaults', type));
      for (const datafeed of Object.keys(value.datafeedDatastreams ?? {})) {
        if (!plugin.requiredDatafeeds.includes(datafeed)) {
          fail(
            appendPath(
              `${appendPath('$.applicationDefaults', type)}.datafeedDatastreams`,
              datafeed,
            ),
            `is not declared by plugin ${plugin.type}`,
          );
        }
      }
      defaults[plugin.type] = structuredClone(value);
    }
    return defaults;
  }

  private buildDeviceDefaults(
    rawDefaults: Record<string, RawDeviceConfigurationDefaults>,
  ): DeviceDefaults {
    const defaults: Record<PluginTypeId, DeviceConfigurationDefaults> = {};
    for (const [type, value] of Object.entries(rawDefaults)) {
      const path = appendPath('$.deviceDefaults', type);
      const plugin = this.resolveDevice(type, path);
      for (const datastreamName of Object.keys(value.datastreams ?? {})) {
        if (!plugin.datastreams.includes(datastreamName)) {
          fail(
            appendPath(`${path}.datastreams`, datastreamName),
            `is not declared by plugin ${plugin.type}`,
          );
        }
      }
      defaults[plugin.type] = structuredClone(value);
    }
    return defaults;
  }

  private mergeDatastreamDefaults(
    defaults: DatastreamDefaults,
    deviceName: string,
    datastreamName: string,
    candidate: RawDatastreamConfiguration | undefined,
  ): void {
    if (candidate === undefined) {
      return;
    }
    const device = (defaults[deviceName] ??= {});
    const previous = device[datastreamName] ?? {};
    device[datastreamName] = {
      ...(previous.maxBufferLength === undefined && candidate.maxBufferLength === undefined
        ? {}
        : {
            maxBufferLength: Math.max(
              previous.maxBufferLength ?? 0,
              candidate.maxBufferLength ?? 0,
            ),
          }),
      ...(previous.maxBufferAgeMs === undefined && candidate.maxBufferAgeMs === undefined
        ? {}
        : {
            maxBufferAgeMs: Math.max(previous.maxBufferAgeMs ?? 0, candidate.maxBufferAgeMs ?? 0),
          }),
      ...(previous.expectedIntervalMs === undefined && candidate.expectedIntervalMs === undefined
        ? {}
        : {
            expectedIntervalMs: Math.min(
              previous.expectedIntervalMs ?? Number.POSITIVE_INFINITY,
              candidate.expectedIntervalMs ?? Number.POSITIVE_INFINITY,
            ),
          }),
      ...(previous.gracePeriodCoefficient === undefined &&
      candidate.gracePeriodCoefficient === undefined
        ? {}
        : {
            gracePeriodCoefficient: Math.max(
              previous.gracePeriodCoefficient ?? 0,
              candidate.gracePeriodCoefficient ?? 0,
            ),
          }),
    };
  }

  private validateReferencedDatastreams(
    references: readonly ReferencedDatastream[],
    devices: Readonly<Record<string, DeviceConfiguration>>,
  ): void {
    for (const reference of references) {
      if (devices[reference.device]?.datastreams?.[reference.datastream] === undefined) {
        fail(
          reference.path,
          `references Datastream ${reference.device}/${reference.datastream} without complete settings`,
        );
      }
    }
  }

  private buildSettings(
    plugin: InstalledPlugin,
    typeDefaults: unknown,
    overrides: unknown,
    path: string,
  ): unknown {
    const settings = mergeDefaults(mergeDefaults(plugin.defaultSettings, typeDefaults), overrides);
    const validate = this.settingsValidator(plugin);
    if (!validate(settings)) {
      const issues = schemaIssues(validate.errors).map((issue) => ({
        ...issue,
        path: issue.path === '$' ? path : `${path}${issue.path.slice(1)}`,
      }));
      throw new ConfigurationValidationError(issues);
    }
    return settings;
  }

  private settingsValidator(plugin: InstalledPlugin): ValidateFunction {
    let validate = this.#settingsValidators.get(plugin.type);
    if (validate === undefined) {
      validate = this.#ajv.compile(plugin.settingsSchema as AnySchema);
      this.#settingsValidators.set(plugin.type, validate);
    }
    return validate;
  }

  private resolveDevice(type: string, path: string): DevicePlugin {
    try {
      return this.#registry.resolveDevice(asPluginTypeId(type));
    } catch (error) {
      return fail(path, error instanceof Error ? error.message : 'cannot resolve plugin');
    }
  }

  private resolveApplication(type: string, path: string): ApplicationPlugin<unknown, object> {
    try {
      return this.#registry.resolveApplication(asPluginTypeId(type));
    } catch (error) {
      return fail(path, error instanceof Error ? error.message : 'cannot resolve plugin');
    }
  }
}
