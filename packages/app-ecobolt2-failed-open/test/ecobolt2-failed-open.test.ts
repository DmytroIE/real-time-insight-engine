import { describe, expect, it } from 'vitest';

import {
  Engine,
  EntityKind,
  PluginRegistry,
  ProcessState,
  asApplicationId,
  asDeviceId,
  asEngineId,
  type Clock,
  type EngineConfiguration,
  type TimerCallback,
  type TimerScheduler,
} from '@sxs/industrial-core';
import { SXSECOBOLT2_TYPE, sxsEcobolt2DevicePlugin } from '@sxs/device-sxs-ecobolt2';

import {
  ECOBOLT2_FAILED_OPEN_DATAFEEDS,
  ECOBOLT2_FAILED_OPEN_TYPE,
  Ecobolt2OperatingState,
  ecobolt2FailedOpenApplicationPlugin,
  ecobolt2FailedOpenDefaultState,
} from '../src';

class TestClock implements Clock {
  public constructor(public now = 1_000) {}

  public wallTimeMs(): number {
    return this.now;
  }

  public monotonicTimeMs(): number {
    return this.now;
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

const applicationId = asApplicationId('asset-1/failed-open');

const createEngine = () => {
  const clock = new TestClock();
  const plugins = new PluginRegistry();
  plugins.register(sxsEcobolt2DevicePlugin);
  plugins.register(ecobolt2FailedOpenApplicationPlugin);
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
    assets: {
      'asset-1': {
        applications: [
          {
            id: 'failed-open',
            type: ECOBOLT2_FAILED_OPEN_TYPE,
            runIntervalMs: 100,
            settings: { windowSizeMs: 100 },
            datafeeds: {
              failedOpen: 'ecobolt-1/failedOpen',
              active: 'ecobolt-1/active',
              trapTemp: 'ecobolt-1/trapTemp',
              losses: 'ecobolt-1/losses',
            },
          },
        ],
      },
    },
  };
  return {
    clock,
    engine: new Engine(configuration, { clock, timers: new TestTimers(), plugins }),
  };
};

const ingest = (engine: Engine, statusBits: number, trapTemp: number, losses: number) =>
  engine.ingest({
    deviceId: asDeviceId('ecobolt-1'),
    rawPayload: { statusBits, trapTemp, losses },
    timestamp: 1_100,
  });

const applicationState = (engine: Engine) =>
  engine.snapshot({
    entities: [{ type: EntityKind.Application, ids: applicationId }],
  }).entities.application[applicationId]?.state;

const applicationDiagnostics = (engine: Engine) =>
  Object.values(
    engine.snapshot({ diagnostics: [{ type: EntityKind.Application, ids: '*' }] }).diagnostics
      .application,
  ).flat();

describe('PLUG-ECO-APP-01 manifest', () => {
  it('exposes the stable feed contract, window setting, and null-valued default state', () => {
    expect(ecobolt2FailedOpenApplicationPlugin).toMatchObject({
      kind: 'application',
      type: 'sxs.ecobolt2-failed-open',
      version: 1,
      displayName: 'Ecobolt2 Failed Open',
      requiredDatafeeds: ECOBOLT2_FAILED_OPEN_DATAFEEDS,
      defaultSettings: { windowSizeMs: 3_600_000 },
      defaultState: ecobolt2FailedOpenDefaultState,
    });
  });
});

describe('PLUG-ECO-APP-02 missing values', () => {
  it('returns Undefined and null numeric state after the Application grace window', async () => {
    const { clock, engine } = createEngine();
    clock.now = 1_100;

    await expect(engine.runApplication(applicationId)).resolves.toBe('completed');

    expect(applicationState(engine)).toMatchObject({
      currState: ProcessState.Undefined,
      noDataError: true,
      appError: false,
      pluginState: {
        operState: Ecobolt2OperatingState.Undefined,
        trapTemp: null,
        losses: null,
      },
    });
    expect(applicationDiagnostics(engine)).toMatchObject([
      { ownerScope: 'application-calculation', code: 'NO_DATA' },
    ]);
  });
});

describe('PLUG-ECO-APP-03 failed-open evaluation', () => {
  it('maps active and failed-open flags to operating and process state', async () => {
    const { clock, engine } = createEngine();
    clock.now = 1_100;
    await ingest(engine, 32_768, 145.5, 28);

    await expect(engine.runApplication(applicationId)).resolves.toBe('completed');
    expect(applicationState(engine)).toMatchObject({
      currState: ProcessState.Warning,
      noDataError: false,
      appError: false,
      pluginState: { operState: Ecobolt2OperatingState.Active, trapTemp: 145.5, losses: 28 },
    });

    clock.now = 1_200;
    await ingest(engine, 16_384, 146, 29);
    await expect(engine.runApplication(applicationId)).resolves.toBe('completed');
    expect(applicationState(engine)).toMatchObject({
      currState: ProcessState.Ok,
      pluginState: { operState: Ecobolt2OperatingState.Inactive, trapTemp: 146, losses: 29 },
    });
  });
});
