import { describe, expect, it } from 'vitest';

import {
  ConfigurationBuilder,
  ConfigurationValidationError,
  PluginRegistry,
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

const createBuilder = (): ConfigurationBuilder => {
  const registry = new PluginRegistry();
  registry.register(devicePlugin);
  registry.register(applicationPlugin);
  return new ConfigurationBuilder(registry);
};

const validConfiguration = (): Record<string, unknown> => ({
  engineId: 'engine-1',
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
      applications: [
        {
          id: 'application-1',
          type: 'sxs.test-application',
          runIntervalMs: 120_000,
          settings: { label: 'application' },
          datafeeds: { temperature: 'device-1/temperature' },
        },
      ],
    },
  },
});

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
  it('applies nested plugin defaults without mutating raw input', () => {
    const raw = validConfiguration();
    const before = structuredClone(raw);

    const configuration = createBuilder().build(raw);

    expect(raw).toEqual(before);
    expect(configuration.devices['device-1']?.settings).toEqual({
      threshold: 5,
      label: 'device',
      nested: { margin: 3 },
    });
    expect(configuration.assets['asset-1']?.applications[0]?.settings).toEqual({
      threshold: 10,
      label: 'application',
      nested: { margin: 2 },
    });
  });
});

describe('CFG-04 required plugin settings', () => {
  it('reports missing settings with a JSON path', () => {
    const raw = validConfiguration();
    const device = (raw['devices'] as Record<string, Record<string, unknown>>)['device-1'];
    if (device !== undefined) {
      device['settings'] = {};
    }

    expectConfigurationError(
      () => createBuilder().build(raw),
      '$.devices["device-1"].settings.label',
    );
  });
});

describe('CFG-05 bounded intervals, buffers, and IDs', () => {
  it.each([
    ['$.engineId', (raw: Record<string, unknown>) => (raw['engineId'] = 'bad/id')],
    [
      '$.devices["bad/id"]',
      (raw: Record<string, unknown>) => {
        const devices = raw['devices'] as Record<string, unknown>;
        devices['bad/id'] = devices['device-1'];
        delete devices['device-1'];
      },
    ],
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
      '$.assets["asset-1"].applications[0].runIntervalMs',
      (raw: Record<string, unknown>) => {
        const assets = raw['assets'] as Record<string, { applications: Record<string, unknown>[] }>;
        const application = assets['asset-1']?.applications[0];
        if (application !== undefined) {
          application['runIntervalMs'] = -1;
        }
      },
    ],
    [
      '$.assets["asset-1"].applications[0].id',
      (raw: Record<string, unknown>) => {
        const assets = raw['assets'] as Record<string, { applications: Record<string, unknown>[] }>;
        const application = assets['asset-1']?.applications[0];
        if (application !== undefined) {
          application['id'] = 'bad/id';
        }
      },
    ],
  ])('rejects invalid values at %s', (path, mutate) => {
    const raw = validConfiguration();
    mutate(raw);
    expectConfigurationError(() => createBuilder().build(raw), path);
  });
});

describe('CFG-06 datafeed relationships', () => {
  it('rejects missing required datafeeds', () => {
    const raw = validConfiguration();
    const assets = raw['assets'] as Record<string, { applications: Record<string, unknown>[] }>;
    const application = assets['asset-1']?.applications[0];
    if (application !== undefined) {
      application['datafeeds'] = {};
    }

    expectConfigurationError(
      () => createBuilder().build(raw),
      '$.assets["asset-1"].applications[0].datafeeds.temperature',
    );
  });

  it('rejects unresolved Datastream mappings', () => {
    const raw = validConfiguration();
    const assets = raw['assets'] as Record<string, { applications: Record<string, unknown>[] }>;
    const application = assets['asset-1']?.applications[0];
    if (application !== undefined) {
      application['datafeeds'] = { temperature: 'device-1/missing' };
    }

    expectConfigurationError(
      () => createBuilder().build(raw),
      '$.assets["asset-1"].applications[0].datafeeds.temperature',
    );
  });
});

describe('CFG-07 unknown-field policy', () => {
  it('rejects unknown top-level and plugin setting fields', () => {
    const raw = validConfiguration();
    raw['unexpected'] = true;
    expectConfigurationError(() => createBuilder().build(raw), '$.unexpected');

    const pluginRaw = validConfiguration();
    const devices = pluginRaw['devices'] as Record<string, Record<string, unknown>>;
    const settings = devices['device-1']?.['settings'] as Record<string, unknown>;
    settings['unexpected'] = true;
    expectConfigurationError(
      () => createBuilder().build(pluginRaw),
      '$.devices["device-1"].settings.unexpected',
    );
  });
});
