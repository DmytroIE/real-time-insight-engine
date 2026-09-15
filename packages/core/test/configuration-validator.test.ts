import { describe, expect, it } from 'vitest';

import {
  ConfigurationBuilder,
  ConfigurationValidationError,
  PluginRegistry,
  asEngineId,
  asPluginTypeId,
  type ApplicationPlugin,
  type DevicePlugin,
} from '../src';

interface TestSettings {
  threshold: number;
  label?: string;
  nested: { margin: number };
}

const settingsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['threshold', 'label', 'nested'],
  properties: {
    threshold: { type: 'number' },
    label: { type: 'string' },
    nested: {
      type: 'object',
      additionalProperties: false,
      required: ['margin'],
      properties: { margin: { type: 'number' } },
    },
  },
} as const;

const devicePlugin: DevicePlugin<TestSettings> = {
  kind: 'device',
  type: asPluginTypeId('sxs.test-device'),
  version: 1,
  displayName: 'Test Device',
  datastreams: ['temperature'],
  settingsSchema,
  defaultSettings: { threshold: 5, nested: { margin: 1 } },
  create: () => ({}),
};

const applicationPlugin: ApplicationPlugin<TestSettings> = {
  kind: 'application',
  type: asPluginTypeId('sxs.test-application'),
  version: 1,
  displayName: 'Test Application',
  requiredDatafeeds: ['temperature'],
  defaultState: {},
  settingsSchema,
  defaultSettings: { threshold: 10, nested: { margin: 2 } },
  create: () => ({}),
};

const secondApplicationPlugin: ApplicationPlugin<TestSettings> = {
  ...applicationPlugin,
  type: asPluginTypeId('sxs.second-test-application'),
  displayName: 'Second Test Application',
};

const createBuilder = (): ConfigurationBuilder => {
  const registry = new PluginRegistry();
  registry.register(devicePlugin);
  registry.register(applicationPlugin);
  registry.register(secondApplicationPlugin);
  return new ConfigurationBuilder(registry);
};

const validConfiguration = (): Record<string, unknown> => ({
  devices: {
    'device-1': {
      type: 'sxs.test-device',
      settings: { label: 'device', nested: { margin: 3 } },
      datastreams: {
        temperature: {
          maxBufferLength: 6,
          maxBufferAgeMs: 60_000,
          expectedIntervalMs: 10_000,
        },
      },
    },
  },
  assets: {
    'asset-1': {
      applications: {
        'Application 1': {
          type: 'sxs.test-application',
          runIntervalMs: 120_000,
          settings: { label: 'application' },
          datafeeds: { temperature: { device: 'device-1', datastream: 'temperature' } },
        },
      },
    },
  },
});

const build = (input: unknown) => createBuilder().build(input, asEngineId('test-engine'));

const expectConfigurationError = (action: () => unknown, path: string): void => {
  try {
    action();
    throw new Error('Expected configuration validation to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigurationValidationError);
    expect((error as Error).message).toContain(path);
  }
};

describe('CFG-03 defaults and input isolation', () => {
  it('accepts scheduler batch and retry settings', () => {
    const raw = validConfiguration();
    raw['applicationScheduler'] = { batchSize: 4, failureRetryDelayMs: 2_000 };
    raw['datastreamStaleScheduler'] = { batchSize: 2, failureRetryDelayMs: 500 };

    expect(build(raw)).toMatchObject({
      applicationScheduler: { batchSize: 4, failureRetryDelayMs: 2_000 },
      datastreamStaleScheduler: { batchSize: 2, failureRetryDelayMs: 500 },
    });
  });

  it('rejects non-positive scheduler values', () => {
    const raw = validConfiguration();
    raw['applicationScheduler'] = { batchSize: 0 };

    expectConfigurationError(() => build(raw), '$.applicationScheduler.batchSize');
  });

  it('applies nested plugin defaults without mutating raw input', () => {
    const raw = validConfiguration();
    raw['applicationDefaults'] = {
      'sxs.test-application': { settings: { threshold: 11, nested: { margin: 4 } } },
    };
    raw['deviceDefaults'] = {
      'sxs.test-device': { settings: { threshold: 6, nested: { margin: 2 } } },
    };
    const before = structuredClone(raw);

    const configuration = build(raw);

    expect(raw).toEqual(before);
    expect(configuration.devices['device-1']?.settings).toEqual({
      threshold: 6,
      label: 'device',
      nested: { margin: 3 },
    });
    expect(configuration.assets['asset-1']?.applications[0]?.settings).toEqual({
      threshold: 11,
      label: 'application',
      nested: { margin: 4 },
    });
  });

  it('retains free-form entity metadata without mutating input', () => {
    const raw = validConfiguration();
    const devices = raw['devices'] as Record<string, Record<string, unknown>>;
    const assets = raw['assets'] as Record<string, Record<string, unknown>>;
    const device = devices['device-1'];
    const asset = assets['asset-1'];
    const application = (asset?.['applications'] as Record<string, Record<string, unknown>>)[
      'Application 1'
    ];
    if (device !== undefined) {
      device['extra'] = { modbus: { registers: { childrenError: 205 } } };
      const temperature = (device['datastreams'] as Record<string, Record<string, unknown>>)[
        'temperature'
      ];
      if (temperature !== undefined) {
        temperature['extra'] = { opcua: { node: 'ns=2;s=Temperature' } };
      }
    }
    if (asset !== undefined) {
      asset['extra'] = { cloud: { resource: 'trap-1' } };
    }
    if (application !== undefined) {
      application['extra'] = { modbus: { registers: { currState: 27 } } };
    }
    const before = structuredClone(raw);

    expect(build(raw)).toMatchObject({
      devices: {
        'device-1': {
          extra: { modbus: { registers: { childrenError: 205 } } },
          datastreams: { temperature: { extra: { opcua: { node: 'ns=2;s=Temperature' } } } },
        },
      },
      assets: {
        'asset-1': {
          extra: { cloud: { resource: 'trap-1' } },
          applications: [{ extra: { modbus: { registers: { currState: 27 } } } }],
        },
      },
    });
    expect(raw).toEqual(before);
  });

  it('rejects non-JSON metadata values from programmatic callers', () => {
    const raw = validConfiguration();
    const devices = raw['devices'] as Record<string, Record<string, unknown>>;
    const device = devices['device-1'];
    if (device !== undefined) {
      device['extra'] = new Date();
    }

    expectConfigurationError(() => build(raw), '$.devices["device-1"].extra');
  });

  it('provisions referenced Datastreams from aggregated application defaults', () => {
    const raw = {
      applicationDefaults: {
        'sxs.test-application': {
          runIntervalMs: 600_000,
          datafeedDatastreams: {
            temperature: {
              maxBufferLength: 5,
              maxBufferAgeMs: 1_800_000,
              expectedIntervalMs: 600_000,
              gracePeriodCoefficient: 2.5,
            },
          },
        },
        'sxs.second-test-application': {
          datafeedDatastreams: {
            temperature: {
              maxBufferLength: 7,
              maxBufferAgeMs: 2_400_000,
              expectedIntervalMs: 300_000,
            },
          },
        },
      },
      deviceDefaults: {
        'sxs.test-device': {
          datastreams: {
            temperature: {
              maxBufferLength: 8,
              maxBufferAgeMs: 600_000,
              expectedIntervalMs: 100_000,
              gracePeriodCoefficient: 1.5,
            },
          },
        },
      },
      devices: {
        'Device 3': {
          type: 'sxs.test-device',
          settings: { label: 'device' },
          datastreams: { temperature: { maxBufferLength: 9 } },
        },
      },
      assets: {
        'Asset 1': {
          applications: {
            'First Application': {
              type: 'sxs.test-application',
              settings: { label: 'first application' },
              datafeeds: { temperature: { device: 'Device 3', datastream: 'temperature' } },
            },
            'Second Application': {
              type: 'sxs.second-test-application',
              runIntervalMs: 900_000,
              settings: { label: 'second application' },
              datafeeds: { temperature: { device: 'Device 3', datastream: 'temperature' } },
            },
          },
        },
      },
    };

    const configuration = build(raw);

    expect(configuration.assets['Asset 1']?.applications[0]?.runIntervalMs).toBe(600_000);
    expect(configuration.devices['Device 3']?.datastreams?.temperature).toEqual({
      maxBufferLength: 9,
      maxBufferAgeMs: 2_400_000,
      expectedIntervalMs: 300_000,
      gracePeriodCoefficient: 2.5,
    });
  });

  it('provisions Device Datastreams from device-type defaults without an Application mapping', () => {
    const configuration = build({
      deviceDefaults: {
        'sxs.test-device': {
          datastreams: {
            temperature: {
              maxBufferLength: 8,
              maxBufferAgeMs: 600_000,
              expectedIntervalMs: 100_000,
            },
          },
        },
      },
      devices: { 'Device 1': { type: 'sxs.test-device', settings: { label: 'device' } } },
      assets: {},
    });

    expect(configuration.devices['Device 1']?.datastreams?.temperature).toEqual({
      maxBufferLength: 8,
      maxBufferAgeMs: 600_000,
      expectedIntervalMs: 100_000,
    });
  });

  it('rejects a referenced Datastream only when merged settings remain incomplete', () => {
    const raw = {
      applicationDefaults: {
        'sxs.test-application': {
          datafeedDatastreams: {
            temperature: { maxBufferLength: 5, maxBufferAgeMs: 1_800_000 },
          },
        },
      },
      devices: { 'Device 3': { type: 'sxs.test-device', settings: { label: 'device' } } },
      assets: {
        'Asset 1': {
          applications: {
            'First Application': {
              type: 'sxs.test-application',
              runIntervalMs: 600_000,
              settings: { label: 'first application' },
              datafeeds: { temperature: { device: 'Device 3', datastream: 'temperature' } },
            },
          },
        },
      },
    };

    expectConfigurationError(
      () => build(raw),
      '$.devices["Device 3"].datastreams.temperature.expectedIntervalMs',
    );
  });
});

describe('CFG-04 required plugin settings', () => {
  it('reports missing settings with a JSON path', () => {
    const raw = validConfiguration();
    const device = (raw['devices'] as Record<string, Record<string, unknown>>)['device-1'];
    if (device !== undefined) {
      device['settings'] = {};
    }

    expectConfigurationError(() => build(raw), '$.devices["device-1"].settings.label');
  });
});

describe('CFG-05 bounded intervals, buffers, and IDs', () => {
  it.each([
    [
      '$.devices["device-1"].datastreams.temperature.maxBufferLength',
      (raw: Record<string, unknown>) => {
        const devices = raw['devices'] as Record<string, Record<string, unknown>>;
        const datastreams = devices['device-1']?.['datastreams'] as Record<
          string,
          Record<string, unknown>
        >;
        if (datastreams['temperature'] !== undefined) {
          datastreams['temperature']['maxBufferLength'] = 0;
        }
      },
    ],
    [
      '$.assets["asset-1"].applications["Application 1"].runIntervalMs',
      (raw: Record<string, unknown>) => {
        const assets = raw['assets'] as Record<
          string,
          { applications: Record<string, Record<string, unknown>> }
        >;
        const application = assets['asset-1']?.applications['Application 1'];
        if (application !== undefined) {
          application['runIntervalMs'] = -1;
        }
      },
    ],
    [
      '$.devices["device-1"].datastreams.temperature.gracePeriodCoefficient',
      (raw: Record<string, unknown>) => {
        const devices = raw['devices'] as Record<string, Record<string, unknown>>;
        const datastreams = devices['device-1']?.['datastreams'] as Record<
          string,
          Record<string, unknown>
        >;
        if (datastreams['temperature'] !== undefined) {
          datastreams['temperature']['gracePeriodCoefficient'] = 0;
        }
      },
    ],
  ])('rejects invalid values at %s', (path, mutate) => {
    const raw = validConfiguration();
    mutate(raw);
    expectConfigurationError(() => build(raw), path);
  });

  it('allows descriptive entity names with spaces and separators', () => {
    const raw = validConfiguration();
    const devices = raw['devices'] as Record<string, unknown>;
    devices['Diag kit TX2 19297/2'] = devices['device-1'];
    delete devices['device-1'];
    const assets = raw['assets'] as Record<
      string,
      { applications: Record<string, Record<string, unknown>> }
    >;
    const application = assets['asset-1']?.applications['Application 1'];
    if (application !== undefined) {
      application['datafeeds'] = {
        temperature: { device: 'Diag kit TX2 19297/2', datastream: 'temperature' },
      };
    }

    expect(build(raw).devices['Diag kit TX2 19297/2']).toBeDefined();
  });
});

describe('CFG-06 datafeed relationships', () => {
  it('rejects missing required datafeeds', () => {
    const raw = validConfiguration();
    const assets = raw['assets'] as Record<
      string,
      { applications: Record<string, Record<string, unknown>> }
    >;
    const application = assets['asset-1']?.applications['Application 1'];
    if (application !== undefined) {
      application['datafeeds'] = {};
    }

    expectConfigurationError(
      () => build(raw),
      '$.assets["asset-1"].applications["Application 1"].datafeeds.temperature',
    );
  });

  it('rejects unresolved Datastream mappings', () => {
    const raw = validConfiguration();
    const assets = raw['assets'] as Record<
      string,
      { applications: Record<string, Record<string, unknown>> }
    >;
    const application = assets['asset-1']?.applications['Application 1'];
    if (application !== undefined) {
      application['datafeeds'] = { temperature: { device: 'device-1', datastream: 'missing' } };
    }

    expectConfigurationError(
      () => build(raw),
      '$.assets["asset-1"].applications["Application 1"].datafeeds.temperature',
    );
  });
});

describe('CFG-07 unknown-field policy', () => {
  it('rejects unknown top-level and plugin setting fields', () => {
    const raw = validConfiguration();
    raw['unexpected'] = true;
    expectConfigurationError(() => build(raw), '$.unexpected');

    const pluginRaw = validConfiguration();
    const devices = pluginRaw['devices'] as Record<string, Record<string, unknown>>;
    const settings = devices['device-1']?.['settings'] as Record<string, unknown>;
    settings['unexpected'] = true;
    expectConfigurationError(() => build(pluginRaw), '$.devices["device-1"].settings.unexpected');
  });

  it('rejects Device-type defaults for a Datastream the plugin does not declare', () => {
    const raw = validConfiguration();
    raw['deviceDefaults'] = {
      'sxs.test-device': {
        datastreams: {
          missing: {
            maxBufferLength: 5,
            maxBufferAgeMs: 60_000,
            expectedIntervalMs: 10_000,
          },
        },
      },
    };

    expectConfigurationError(
      () => build(raw),
      '$.deviceDefaults["sxs.test-device"].datastreams.missing',
    );
  });
});
