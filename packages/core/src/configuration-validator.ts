import Ajv, { type AnySchema, type ErrorObject, type ValidateFunction } from 'ajv';

import { asEngineId, asPluginTypeId, type PluginTypeId } from './identifiers';
import type { PluginRegistry, ApplicationPlugin, DevicePlugin, InstalledPlugin } from './plugins';
import type {
  ApplicationConfiguration,
  AssetConfiguration,
  DeviceConfiguration,
  EngineConfiguration,
} from './configuration';

const idPattern = '^[A-Za-z0-9][A-Za-z0-9._-]*$';

const datastreamSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['maxBufferLength', 'maxBufferAgeMs', 'expectedIntervalMs'],
  properties: {
    maxBufferLength: { type: 'integer', minimum: 1 },
    maxBufferAgeMs: { type: 'integer', minimum: 1 },
    expectedIntervalMs: { type: 'integer', minimum: 1 },
  },
} as const;

const engineConfigurationSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['engineId', 'devices', 'assets'],
  properties: {
    engineId: { type: 'string', pattern: idPattern },
    clockJumpThresholdMs: { type: 'integer', minimum: 1 },
    devices: {
      type: 'object',
      propertyNames: { pattern: idPattern },
      additionalProperties: {
        type: 'object',
        additionalProperties: false,
        required: ['type'],
        properties: {
          type: { type: 'string', pattern: idPattern },
          settings: {},
          datastreams: {
            type: 'object',
            propertyNames: { pattern: idPattern },
            additionalProperties: datastreamSchema,
          },
        },
      },
    },
    assets: {
      type: 'object',
      propertyNames: { pattern: idPattern },
      additionalProperties: {
        type: 'object',
        additionalProperties: false,
        required: ['applications'],
        properties: {
          applications: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'type', 'runIntervalMs', 'datafeeds'],
              properties: {
                id: { type: 'string', pattern: idPattern },
                type: { type: 'string', pattern: idPattern },
                runIntervalMs: { type: 'integer', minimum: 1 },
                settings: {},
                datafeeds: {
                  type: 'object',
                  propertyNames: { pattern: idPattern },
                  additionalProperties: { type: 'string', pattern: '^[^/]+/[^/]+$' },
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
  maxBufferLength: number;
  maxBufferAgeMs: number;
  expectedIntervalMs: number;
}

interface RawDeviceConfiguration {
  type: string;
  settings?: unknown;
  datastreams?: Record<string, RawDatastreamConfiguration>;
}

interface RawApplicationConfiguration {
  id: string;
  type: string;
  runIntervalMs: number;
  settings?: unknown;
  datafeeds: Record<string, string>;
}

interface RawAssetConfiguration {
  applications: RawApplicationConfiguration[];
}

interface RawEngineConfiguration {
  engineId: string;
  clockJumpThresholdMs?: number;
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

export class ConfigurationBuilder {
  readonly #ajv = new Ajv({ allErrors: true, strict: true, useDefaults: true });
  readonly #validateConfiguration: ValidateFunction;
  readonly #settingsValidators = new Map<PluginTypeId, ValidateFunction>();

  public constructor(private readonly registry: PluginRegistry) {
    this.#validateConfiguration = this.#ajv.compile(engineConfigurationSchema);
  }

  public build(input: unknown): EngineConfiguration {
    const clonedInput: unknown = structuredClone(input);
    if (!this.#validateConfiguration(clonedInput)) {
      throw new ConfigurationValidationError(schemaIssues(this.#validateConfiguration.errors));
    }

    const raw = clonedInput as RawEngineConfiguration;
    const devices = this.buildDevices(raw.devices);
    const assets = this.buildAssets(raw.assets, devices);
    return {
      engineId: asEngineId(raw.engineId),
      ...(raw.clockJumpThresholdMs === undefined
        ? {}
        : { clockJumpThresholdMs: raw.clockJumpThresholdMs }),
      devices,
      assets,
    };
  }

  private buildDevices(
    rawDevices: Record<string, RawDeviceConfiguration>,
  ): Record<string, DeviceConfiguration> {
    const devices: Record<string, DeviceConfiguration> = {};
    for (const [deviceId, rawDevice] of Object.entries(rawDevices)) {
      const path = appendPath('$.devices', deviceId);
      const plugin = this.resolveDevice(rawDevice.type, `${path}.type`);
      const datastreams = rawDevice.datastreams ?? {};
      for (const datastreamId of Object.keys(datastreams)) {
        if (!plugin.datastreams.includes(datastreamId)) {
          fail(
            appendPath(`${path}.datastreams`, datastreamId),
            `is not declared by plugin ${plugin.type}`,
          );
        }
      }

      devices[deviceId] = {
        type: plugin.type,
        settings: this.buildSettings(plugin, rawDevice.settings, `${path}.settings`),
        datastreams,
      };
    }
    return devices;
  }

  private buildAssets(
    rawAssets: Record<string, RawAssetConfiguration>,
    devices: Readonly<Record<string, DeviceConfiguration>>,
  ): Record<string, AssetConfiguration> {
    const assets: Record<string, AssetConfiguration> = {};
    for (const [assetId, rawAsset] of Object.entries(rawAssets)) {
      const assetPath = appendPath('$.assets', assetId);
      const ids = new Set<string>();
      const applications = rawAsset.applications.map((rawApplication, index) => {
        const path = `${assetPath}.applications[${index}]`;
        if (ids.has(rawApplication.id)) {
          fail(`${path}.id`, `duplicates application ID ${rawApplication.id}`);
        }
        ids.add(rawApplication.id);
        return this.buildApplication(rawApplication, path, devices);
      });
      assets[assetId] = { applications };
    }
    return assets;
  }

  private buildApplication(
    raw: RawApplicationConfiguration,
    path: string,
    devices: Readonly<Record<string, DeviceConfiguration>>,
  ): ApplicationConfiguration {
    const plugin = this.resolveApplication(raw.type, `${path}.type`);
    for (const requiredDatafeed of plugin.requiredDatafeeds) {
      if (!(requiredDatafeed in raw.datafeeds)) {
        fail(appendPath(`${path}.datafeeds`, requiredDatafeed), 'is required by the plugin');
      }
    }
    for (const [datafeed, target] of Object.entries(raw.datafeeds)) {
      this.validateDatafeedTarget(target, appendPath(`${path}.datafeeds`, datafeed), devices);
    }

    return {
      id: raw.id,
      type: plugin.type,
      runIntervalMs: raw.runIntervalMs,
      settings: this.buildSettings(plugin, raw.settings, `${path}.settings`),
      datafeeds: raw.datafeeds,
    };
  }

  private validateDatafeedTarget(
    target: string,
    path: string,
    devices: Readonly<Record<string, DeviceConfiguration>>,
  ): void {
    const [deviceId, datastreamId] = target.split('/');
    const device = deviceId === undefined ? undefined : devices[deviceId];
    if (device === undefined) {
      throw new ConfigurationValidationError([
        { path, message: `references unavailable device ${deviceId ?? ''}` },
      ]);
    }
    if (datastreamId === undefined || device.datastreams?.[datastreamId] === undefined) {
      fail(path, `references unavailable datastream ${target}`);
    }
  }

  private buildSettings(plugin: InstalledPlugin, overrides: unknown, path: string): unknown {
    const settings = mergeDefaults(plugin.defaultSettings, overrides);
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
      return this.registry.resolveDevice(asPluginTypeId(type));
    } catch (error) {
      return fail(path, error instanceof Error ? error.message : 'cannot resolve plugin');
    }
  }

  private resolveApplication(type: string, path: string): ApplicationPlugin<unknown, object> {
    try {
      return this.registry.resolveApplication(asPluginTypeId(type));
    } catch (error) {
      return fail(path, error instanceof Error ? error.message : 'cannot resolve plugin');
    }
  }
}
