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

import { SXSECOBOLT2_DATASTREAMS, SXSECOBOLT2_TYPE, sxsEcobolt2DevicePlugin } from '../src';

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

const createEngine = (): Engine => {
  const plugins = new PluginRegistry();
  plugins.register(sxsEcobolt2DevicePlugin);
  const configuration: EngineConfiguration = {
    engineId: asEngineId('engine-1'),
    devices: {
      'ecobolt-1': {
        type: SXSECOBOLT2_TYPE,
        datastreams: {
          failedOpen: { maxBufferLength: 4, maxBufferAgeMs: 10_000, expectedIntervalMs: 100 },
          active: { maxBufferLength: 4, maxBufferAgeMs: 10_000, expectedIntervalMs: 100 },
          trapTemp: { maxBufferLength: 4, maxBufferAgeMs: 10_000, expectedIntervalMs: 100 },
          losses: { maxBufferLength: 4, maxBufferAgeMs: 10_000, expectedIntervalMs: 100 },
        },
      },
    },
    assets: {},
  };
  return new Engine(configuration, { clock: new TestClock(), timers: new TestTimers(), plugins });
};

const ingest = (engine: Engine, rawPayload: unknown): Promise<boolean> =>
  engine.ingest({
    deviceId: asDeviceId('ecobolt-1'),
    rawPayload: rawPayload as Readonly<Record<string, unknown>>,
    timestamp: 1_500,
  });

const datastreamState = (engine: Engine, name: string) =>
  engine.snapshot({
    entities: [{ type: EntityKind.Datastream, ids: `ecobolt-1/${name}` }],
  }).entities.datastream[`ecobolt-1/${name}`]?.state;

const deviceState = (engine: Engine) =>
  engine.snapshot({ entities: [{ type: EntityKind.Device, ids: 'ecobolt-1' }] }).entities.device[
    'ecobolt-1'
  ]?.state;

const deviceDiagnostics = (engine: Engine) =>
  Object.values(
    engine.snapshot({ diagnostics: [{ type: EntityKind.Device, ids: '*' }] }).diagnostics.device,
  ).flat();

describe('PLUG-ECO-DEV-01 manifest', () => {
  it('exposes its stable type, streams, and empty settings contract', () => {
    expect(sxsEcobolt2DevicePlugin).toMatchObject({
      kind: 'device',
      type: 'sxs.ecobolt2',
      version: 1,
      displayName: 'SxS Ecobolt2',
      datastreams: SXSECOBOLT2_DATASTREAMS,
      defaultSettings: {},
      settingsSchema: { type: 'object', additionalProperties: false },
    });
  });
});

describe('PLUG-ECO-DEV-02 valid payloads', () => {
  it('writes all derived and direct streams at the source timestamp', async () => {
    const engine = createEngine();

    await expect(ingest(engine, { statusBits: 32_768, trapTemp: 123.5, losses: 17 })).resolves.toBe(
      true,
    );

    expect(datastreamState(engine, 'failedOpen')).toMatchObject({
      samples: [{ timestamp: 1_500, value: 1 }],
    });
    expect(datastreamState(engine, 'active')).toMatchObject({
      samples: [{ timestamp: 1_500, value: 1 }],
    });
    expect(datastreamState(engine, 'trapTemp')).toMatchObject({
      samples: [{ timestamp: 1_500, value: 123.5 }],
    });
    expect(datastreamState(engine, 'losses')).toMatchObject({
      samples: [{ timestamp: 1_500, value: 17 }],
    });
  });
});

describe('PLUG-ECO-DEV-03 hardware status', () => {
  it('rejects the frame, activates each matching Device diagnostic, and skips every stream', async () => {
    const engine = createEngine();

    await expect(ingest(engine, { statusBits: 259, trapTemp: 123, losses: 17 })).resolves.toBe(
      false,
    );

    expect(deviceState(engine)).toMatchObject({ hwError: true });
    expect(deviceDiagnostics(engine)).toMatchObject([
      { ownerScope: 'device-hardware', code: 'TEMP_SENSOR_ERROR' },
      { ownerScope: 'device-hardware', code: 'EXTERNAL_TEMP_SENSOR_ERROR' },
      { ownerScope: 'device-hardware', code: 'UNCONFIGURED' },
    ]);
    expect(deviceDiagnostics(engine)).not.toContainEqual(
      expect.objectContaining({ ownerScope: 'device-payload', code: 'INVALID_PAYLOAD' }),
    );
    for (const name of SXSECOBOLT2_DATASTREAMS) {
      expect(datastreamState(engine, name)).toMatchObject({ samples: [] });
    }
  });

  it('clears hardware conditions and resumes stream updates with a healthy frame', async () => {
    const engine = createEngine();
    await ingest(engine, { statusBits: 1, trapTemp: 123, losses: 17 });

    await expect(ingest(engine, { statusBits: 16_384, trapTemp: 124, losses: 18 })).resolves.toBe(
      true,
    );

    expect(deviceState(engine)).toMatchObject({ hwError: false });
    expect(deviceDiagnostics(engine)).toEqual([]);
    expect(datastreamState(engine, 'active')).toMatchObject({ samples: [{ value: 0 }] });
  });
});

describe('PLUG-ECO-DEV-04 invalid payloads', () => {
  it.each([
    ['missing statusBits', { trapTemp: 123, losses: 17 }],
    ['fractional statusBits', { statusBits: 1.5, trapTemp: 123, losses: 17 }],
    ['out-of-range trapTemp', { statusBits: 0, trapTemp: 626, losses: 17 }],
    ['non-finite trapTemp', { statusBits: 0, trapTemp: Number.NaN, losses: 17 }],
    ['non-numeric losses', { statusBits: 0, trapTemp: 123, losses: '17' }],
  ])('rejects %s without partially writing streams', async (_label, rawPayload) => {
    const engine = createEngine();

    await expect(ingest(engine, rawPayload)).resolves.toBe(false);

    expect(deviceDiagnostics(engine)).toMatchObject([
      { ownerScope: 'device-payload', code: 'INVALID_PAYLOAD' },
    ]);
    for (const name of SXSECOBOLT2_DATASTREAMS) {
      expect(datastreamState(engine, name)).toMatchObject({ samples: [] });
    }
  });
});
