import { describe, expect, it } from 'vitest';

import {
  Engine,
  EntityKind,
  PluginRegistry,
  asDeviceId,
  asEngineId,
  type Clock,
  type EngineConfiguration,
  type TimerCallback,
  type TimerScheduler,
} from '@sxs/industrial-core';

import {
  ENLESS_TWIN_TEMPERATURE_DATASTREAMS,
  ENLESS_TWIN_TEMPERATURE_TYPE,
  enlessTwinTemperatureDevicePlugin,
} from '../src';

class TestClock implements Clock {
  public wallTimeMs(): number {
    return 2_000;
  }

  public monotonicTimeMs(): number {
    return 0;
  }
}

class TestTimers implements TimerScheduler {
  public setTimeout(callback: TimerCallback, delayMs: number): unknown {
    void callback;
    void delayMs;
    return {};
  }

  public clearTimeout(handle: unknown): void {
    void handle;
  }
}

const configuration: EngineConfiguration = {
  engineId: asEngineId('engine-1'),
  devices: {
    'device-1': {
      type: ENLESS_TWIN_TEMPERATURE_TYPE,
      datastreams: {
        temp1: { maxBufferLength: 6, maxBufferAgeMs: 60_000, expectedIntervalMs: 10_000 },
        temp2: { maxBufferLength: 6, maxBufferAgeMs: 60_000, expectedIntervalMs: 10_000 },
      },
    },
  },
  assets: {},
};

const createEngine = (numFaultyValues = 3): Engine => {
  const plugins = new PluginRegistry();
  plugins.register(enlessTwinTemperatureDevicePlugin);
  const device = configuration.devices['device-1'];
  if (device === undefined) {
    throw new Error('Missing Enless test Device configuration');
  }
  const configured: EngineConfiguration = {
    ...configuration,
    devices: {
      ...configuration.devices,
      'device-1': {
        ...device,
        settings: { numFaultyValues },
      },
    },
  };
  return new Engine(configured, {
    clock: new TestClock(),
    timers: new TestTimers(),
    plugins,
  });
};

const ingest = (
  engine: Engine,
  object: Readonly<Record<string, unknown>>,
  sourceTimestamp = 1_500,
): Promise<boolean> =>
  engine.ingest({
    deviceId: asDeviceId('device-1'),
    rawPayload: object,
    timestamp: sourceTimestamp,
  });

const datastreamState = (engine: Engine, id: 'device-1/temp1' | 'device-1/temp2') =>
  engine.snapshot({
    entities: [{ type: EntityKind.Datastream, ids: id }],
  }).entities.datastream[id]?.state;

const diagnosticsFor = (engine: Engine, type: 'device' | 'datastream') =>
  Object.values(
    engine.snapshot({
      diagnostics: [
        { type: type === 'device' ? EntityKind.Device : EntityKind.Datastream, ids: '*' },
      ],
    }).diagnostics[type],
  ).flat();

describe('PLUG-DEV-01 Enless manifest', () => {
  it('exposes a stable type, strict settings schema, defaults, and both Datastreams', () => {
    expect(enlessTwinTemperatureDevicePlugin).toMatchObject({
      kind: 'device',
      type: 'sxs.enless-twin-temp',
      version: 1,
      displayName: 'Enless Twin Temperature',
      datastreams: ENLESS_TWIN_TEMPERATURE_DATASTREAMS,
      settingsSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['numFaultyValues'],
      },
      defaultSettings: { numFaultyValues: 3 },
    });
  });
});

describe('PLUG-DEV-02 valid payload', () => {
  it('updates both temperature streams using normalized source time', async () => {
    const engine = createEngine();

    await expect(ingest(engine, { sensorType: 12, temp1: 21.5, temp2: 84 }, 1_234)).resolves.toBe(
      true,
    );

    expect(datastreamState(engine, 'device-1/temp1')).toMatchObject({
      hwError: false,
      samples: [{ timestamp: 1_234, value: 21.5 }],
    });
    expect(datastreamState(engine, 'device-1/temp2')).toMatchObject({
      hwError: false,
      samples: [{ timestamp: 1_234, value: 84 }],
    });
  });
});

describe('PLUG-DEV-03 and PLUG-DEV-04 range faults', () => {
  it('reports only after three consecutive invalid values and clears on recovery', async () => {
    const engine = createEngine();

    await expect(ingest(engine, { sensorType: 12, temp1: 401, temp2: 20 })).resolves.toBe(true);

    expect(datastreamState(engine, 'device-1/temp1')).toMatchObject({
      hwError: false,
      samples: [],
    });
    expect(diagnosticsFor(engine, 'datastream')).toEqual([]);

    await expect(ingest(engine, { sensorType: 12, temp1: 401, temp2: 20 })).resolves.toBe(true);
    await expect(ingest(engine, { sensorType: 12, temp1: 401, temp2: 20 })).resolves.toBe(true);

    expect(datastreamState(engine, 'device-1/temp1')).toMatchObject({ hwError: true, samples: [] });
    expect(datastreamState(engine, 'device-1/temp2')).toMatchObject({
      hwError: false,
      samples: [{ timestamp: 1_500, value: 20 }],
    });
    expect(diagnosticsFor(engine, 'datastream')).toMatchObject([
      {
        sourceId: 'device-1/temp1',
        ownerScope: 'datastream-input',
        code: 'SENSOR_BROKEN',
        details: { value: 401, sourceTimestamp: 1_500 },
      },
    ]);

    await expect(ingest(engine, { sensorType: 12, temp1: -100, temp2: 400 }, 1_600)).resolves.toBe(
      true,
    );

    expect(datastreamState(engine, 'device-1/temp1')).toMatchObject({
      hwError: false,
      samples: [{ timestamp: 1_600, value: -100 }],
    });
    expect(diagnosticsFor(engine, 'datastream')).toEqual([]);
  });

  it('uses the configured faulty-value threshold', async () => {
    const engine = createEngine(2);

    await ingest(engine, { sensorType: 12, temp1: 401, temp2: 20 });
    expect(datastreamState(engine, 'device-1/temp1')).toMatchObject({ hwError: false });

    await ingest(engine, { sensorType: 12, temp1: 401, temp2: 20 });
    expect(datastreamState(engine, 'device-1/temp1')).toMatchObject({ hwError: true });
  });
});

describe('PLUG-DEV-05 malformed payloads', () => {
  it.each([
    ['wrong sensor', { sensorType: 11, temp1: 20, temp2: 30 }],
    ['missing value', { sensorType: 12, temp1: 20 }],
    ['non-numeric value', { sensorType: 12, temp1: 20, temp2: '30' }],
    ['non-finite value', { sensorType: 12, temp1: Number.NaN, temp2: 30 }],
  ])('rejects %s without partially updating either stream', async (_label, object) => {
    const engine = createEngine();

    await expect(ingest(engine, object)).resolves.toBe(false);

    expect(datastreamState(engine, 'device-1/temp1')).toMatchObject({ samples: [] });
    expect(datastreamState(engine, 'device-1/temp2')).toMatchObject({ samples: [] });
    expect(diagnosticsFor(engine, 'device')).toMatchObject([
      { sourceId: 'device-1', ownerScope: 'device-payload', code: 'INVALID_PAYLOAD' },
    ]);
  });
});
