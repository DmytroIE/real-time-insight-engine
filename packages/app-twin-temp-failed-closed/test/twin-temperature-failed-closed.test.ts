import { describe, expect, it } from 'vitest';

import {
  Engine,
  EntityKind,
  PluginRegistry,
  ProcessState,
  asApplicationId,
  asDeviceId,
  asEngineId,
  asDatastreamId,
  type Clock,
  type EngineConfiguration,
  type TimerCallback,
  type TimerScheduler,
} from '@sxs/industrial-core';
import {
  ENLESS_TWIN_TEMPERATURE_TYPE,
  enlessTwinTemperatureDevicePlugin,
} from '@sxs/device-enless-twin-temp';

import {
  TWIN_TEMPERATURE_FAILED_CLOSED_DATAFEEDS,
  TWIN_TEMPERATURE_FAILED_CLOSED_TYPE,
  OperatingState as PluginOperatingState,
  twinTemperatureFailedClosedApplicationPlugin,
  twinTemperatureFailedClosedDefaultSettings,
  twinTemperatureFailedClosedDefaultState,
  type TwinTemperatureFailedClosedSettings,
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

const applicationId = asApplicationId('asset-1/failed-closed');

const createEngine = (
  settings: TwinTemperatureFailedClosedSettings = twinTemperatureFailedClosedDefaultSettings,
) => {
  const clock = new TestClock();
  const plugins = new PluginRegistry();
  plugins.register(enlessTwinTemperatureDevicePlugin);
  plugins.register(twinTemperatureFailedClosedApplicationPlugin);
  const configuration: EngineConfiguration = {
    engineId: asEngineId('engine-1'),
    devices: {
      'device-1': {
        type: ENLESS_TWIN_TEMPERATURE_TYPE,
        datastreams: {
          temp1: { maxBufferLength: 10, maxBufferAgeMs: 10_000, expectedIntervalMs: 100 },
          temp2: { maxBufferLength: 10, maxBufferAgeMs: 10_000, expectedIntervalMs: 100 },
        },
      },
    },
    assets: {
      'asset-1': {
        applications: [
          {
            id: 'failed-closed',
            type: TWIN_TEMPERATURE_FAILED_CLOSED_TYPE,
            runIntervalMs: 100,
            settings,
            datafeeds: { tempIn: 'device-1/temp1', tempOut: 'device-1/temp2' },
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

const ingest = (
  engine: Engine,
  tempIn: number,
  tempOut: number,
  timestamp: number,
): Promise<boolean> =>
  engine.ingest({
    deviceId: asDeviceId('device-1'),
    rawPayload: { sensorType: 12, temp1: tempIn, temp2: tempOut },
    timestamp,
  });

const applicationState = (engine: Engine) =>
  engine.snapshot({
    target: {
      scope: 'entities',
      entityType: EntityKind.Application,
      entityId: applicationId,
    },
  }).entities.application[applicationId]?.state;

const applicationDiagnostics = (engine: Engine) =>
  Object.values(engine.snapshot({ target: { scope: 'all' } }).diagnostics.application).flat();

const assetDiagnostics = (engine: Engine) =>
  Object.values(engine.snapshot({ target: { scope: 'all' } }).diagnostics.asset).flat();

describe('PLUG-APP-01 manifest', () => {
  it('exposes stable feeds, settings schema, defaults, and state', () => {
    expect(twinTemperatureFailedClosedApplicationPlugin).toMatchObject({
      kind: 'application',
      type: 'sxs.twin-temp-failed-closed',
      version: 1,
      requiredDatafeeds: TWIN_TEMPERATURE_FAILED_CLOSED_DATAFEEDS,
      defaultSettings: {
        tempDiffMargin: 0.5,
        offThreshold: 80,
        tempDiffThreshold: 30,
        windowSizeMs: 1_800_000,
      },
      defaultState: twinTemperatureFailedClosedDefaultState,
    });
    expect(twinTemperatureFailedClosedApplicationPlugin.settingsSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['tempDiffMargin', 'offThreshold', 'tempDiffThreshold', 'windowSizeMs'],
    });
  });
});

describe('PLUG-APP-02 missing averages', () => {
  it('remains Undefined during grace, then raises NO_DATA', async () => {
    const { clock, engine } = createEngine({
      ...twinTemperatureFailedClosedDefaultSettings,
      windowSizeMs: 100,
    });

    await expect(engine.runApplication(applicationId)).resolves.toBe('completed');
    expect(applicationState(engine)).toMatchObject({
      currState: ProcessState.Undefined,
      noDataError: false,
      appError: false,
      pluginState: { operState: PluginOperatingState.Undefined, tempInAvg: null, tempOutAvg: null },
    });
    expect(applicationDiagnostics(engine)).toEqual([]);

    clock.now = 1_100;
    await expect(engine.runApplication(applicationId)).resolves.toBe('completed');
    expect(applicationState(engine)).toMatchObject({
      currState: ProcessState.Undefined,
      noDataError: true,
      appError: false,
    });
    expect(applicationDiagnostics(engine)).toMatchObject([
      { ownerScope: 'application-calculation', code: 'NO_DATA', severity: 'error' },
    ]);
  });

  it('retains a previously active no-data condition during a new session grace period', () => {
    const reports: string[] = [];
    const evaluator = twinTemperatureFailedClosedApplicationPlugin.create({
      id: applicationId,
      settings: { ...twinTemperatureFailedClosedDefaultSettings, windowSizeMs: 100 },
      datafeeds: {},
    });
    const emptyDatafeed = {
      id: asDatastreamId('device-1/temp1'),
      evaluateStale: () => false,
      state: () => ({
        lastUpdateTimestamp: 1_000,
        nextUpdateTimestamp: 1_150,
        noDataError: false,
        hwError: false,
        samples: [],
      }),
      averageValue: () => null,
    };

    const result = evaluator.evaluate({
      timestamp: 1_050,
      sessionStartTs: 1_000,
      previousNoDataError: true,
      state: {
        currState: ProcessState.Undefined,
        noDataError: false,
        appError: false,
        lastRunTimestamp: 1_000,
        nextRunTimestamp: 1_100,
        pluginState: twinTemperatureFailedClosedDefaultState,
      },
      datafeeds: { tempIn: emptyDatafeed, tempOut: emptyDatafeed },
      diagnostics: { report: ({ code }) => reports.push(code) },
      assetDiagnostics: { report: () => undefined },
    });

    expect(result).toMatchObject({ noDataError: true });
    expect(reports).toEqual(['NO_DATA']);
  });
});

describe('PLUG-APP-03 invalid temperature direction', () => {
  it('sets appError and reports TEMP_OUT_ABOVE_IN', async () => {
    const { engine } = createEngine();
    await ingest(engine, 80, 81, 1_000);

    await engine.runApplication(applicationId);

    expect(applicationState(engine)).toMatchObject({
      currState: ProcessState.Undefined,
      noDataError: false,
      appError: true,
      pluginState: { operState: PluginOperatingState.Undefined },
    });
    expect(applicationDiagnostics(engine)).toMatchObject([
      { code: 'TEMP_OUT_ABOVE_IN', severity: 'error' },
    ]);
  });
});

describe('PLUG-APP-04 off state', () => {
  it('sets Off and leaves process state Undefined', async () => {
    const { engine } = createEngine();
    await ingest(engine, 79, 70, 1_000);

    await engine.runApplication(applicationId);

    expect(applicationState(engine)).toMatchObject({
      currState: ProcessState.Undefined,
      noDataError: false,
      appError: false,
      pluginState: { operState: PluginOperatingState.Off },
    });
    expect(applicationDiagnostics(engine)).toEqual([]);
  });
});

describe('PLUG-APP-05 and PLUG-APP-06 on state', () => {
  it('reports Failed Closed, then returns Ok and reconciles the condition', async () => {
    const settings = { ...twinTemperatureFailedClosedDefaultSettings, windowSizeMs: 10 };
    const { clock, engine } = createEngine(settings);
    await ingest(engine, 100, 60, 1_000);

    await engine.runApplication(applicationId);
    expect(applicationState(engine)).toMatchObject({
      currState: ProcessState.Warning,
      appError: false,
      pluginState: { operState: PluginOperatingState.On },
    });
    expect(assetDiagnostics(engine)).toMatchObject([
      { code: 'FAILED_CLOSED', severity: 'warning' },
    ]);

    clock.now = 1_100;
    await ingest(engine, 100, 90, 1_100);
    await engine.runApplication(applicationId);
    expect(applicationState(engine)).toMatchObject({
      currState: ProcessState.Ok,
      noDataError: false,
      appError: false,
      pluginState: { operState: PluginOperatingState.On },
    });
    expect(applicationDiagnostics(engine)).toEqual([]);
  });
});

describe('PLUG-APP-07 inclusive average window', () => {
  it('averages samples at both timestamp boundaries and excludes earlier samples', async () => {
    const settings = { ...twinTemperatureFailedClosedDefaultSettings, windowSizeMs: 1_000 };
    const { clock, engine } = createEngine(settings);
    clock.now = 2_000;
    await ingest(engine, 300, 300, 999);
    await ingest(engine, 80, 60, 1_000);
    await ingest(engine, 100, 70, 1_500);
    await ingest(engine, 120, 80, 2_000);

    await engine.runApplication(applicationId);

    expect(applicationState(engine)).toMatchObject({
      pluginState: {
        tempInAvg: 100,
        tempOutAvg: 70,
      },
    });
  });
});

describe('PLUG-APP-08 scoped reporting', () => {
  it('emits only active diagnostics without null-filled clear payloads', async () => {
    const { engine } = createEngine();
    await ingest(engine, 100, 60, 1_000);

    await engine.runApplication(applicationId);

    expect(applicationDiagnostics(engine)).toEqual([]);
    expect(assetDiagnostics(engine)).toHaveLength(1);
    expect(assetDiagnostics(engine)[0]).toMatchObject({
      ownerScope: 'application:asset-1/failed-closed:application-calculation',
      code: 'FAILED_CLOSED',
    });
    expect(Object.values(assetDiagnostics(engine)[0] ?? {})).not.toContain(null);
  });
});
