import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ConfigurationBuilder,
  ConfigurationValidationError,
  Engine,
  asEngineId,
  asPluginTypeId,
  type Clock,
  type TimerCallback,
  type TimerScheduler,
} from '@sxs/industrial-core';
import { ECOBOLT2_FAILED_OPEN_TYPE } from '@sxs/app-ecobolt2-failed-open';
import { TWIN_TEMPERATURE_FAILED_CLOSED_TYPE } from '@sxs/app-twin-temp-failed-closed';
import { ENLESS_TWIN_TEMPERATURE_TYPE } from '@sxs/device-enless-twin-temp';
import { SXSECOBOLT2_TYPE } from '@sxs/device-sxs-ecobolt2';

import { createUg65ExamplePluginRegistry } from '../src';

class TestClock implements Clock {
  public wallTimeMs(): number {
    return 1_000;
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

const loadExample = (): unknown =>
  JSON.parse(readFileSync(join(__dirname, '..', 'settings.example.json'), 'utf8')) as unknown;

describe('PROFILE-01 explicit plugin selection', () => {
  it('registers only the selected Device and Application plugins', () => {
    const registry = createUg65ExamplePluginRegistry();

    expect(registry.resolveDevice(ENLESS_TWIN_TEMPERATURE_TYPE).type).toBe(
      ENLESS_TWIN_TEMPERATURE_TYPE,
    );
    expect(registry.resolveApplication(TWIN_TEMPERATURE_FAILED_CLOSED_TYPE).type).toBe(
      TWIN_TEMPERATURE_FAILED_CLOSED_TYPE,
    );
    expect(registry.resolveDevice(SXSECOBOLT2_TYPE).type).toBe(SXSECOBOLT2_TYPE);
    expect(registry.resolveApplication(ECOBOLT2_FAILED_OPEN_TYPE).type).toBe(
      ECOBOLT2_FAILED_OPEN_TYPE,
    );
    expect(() => registry.resolve(asPluginTypeId('sxs.unselected'))).toThrow(
      'Plugin type is not installed: sxs.unselected',
    );
  });
});

describe('PROFILE-02 validated example configuration', () => {
  it('builds a minimal configuration using core bootstrap defaults', () => {
    const registry = createUg65ExamplePluginRegistry();
    const configuration = new ConfigurationBuilder(registry).build(
      {
        devices: {
          'enless-twin-temp-1': { type: 'sxs.enless-twin-temp' },
        },
        assets: {
          'steam-trap-1': {
            applications: {
              'failed-closed': {
                type: 'sxs.twin-temp-failed-closed',
                datafeeds: {
                  tempIn: { device: 'enless-twin-temp-1', datastream: 'temp1' },
                  tempOut: { device: 'enless-twin-temp-1', datastream: 'temp2' },
                },
              },
            },
          },
        },
      },
      asEngineId('ug65-minimal'),
    );

    expect(configuration.devices['enless-twin-temp-1']?.datastreams).toEqual({
      temp1: { maxBufferLength: 10, maxBufferAgeMs: 600_000, expectedIntervalMs: 60_000 },
      temp2: { maxBufferLength: 10, maxBufferAgeMs: 600_000, expectedIntervalMs: 60_000 },
    });
    expect(configuration.assets['steam-trap-1']?.applications[0]).toMatchObject({
      runIntervalMs: 600_000,
      settings: {
        tempDiffMargin: 0.5,
        offThreshold: 80,
        tempDiffThreshold: 30,
        windowSizeMs: 1_800_000,
      },
    });
    expect(
      new Engine(configuration, {
        clock: new TestClock(),
        timers: new TestTimers(),
        plugins: registry,
      }).isReady,
    ).toBe(true);
  });

  it('validates the JSON and constructs the complete Engine graph', () => {
    const registry = createUg65ExamplePluginRegistry();
    const configuration = new ConfigurationBuilder(registry).build(
      loadExample(),
      asEngineId('ug65-example'),
    );

    const engine = new Engine(configuration, {
      clock: new TestClock(),
      timers: new TestTimers(),
      plugins: registry,
    });

    expect(engine.isReady).toBe(true);
    expect(engine.registry()).toEqual({
      devices: ['enless-twin-temp-1'],
      datastreams: ['enless-twin-temp-1/temp1', 'enless-twin-temp-1/temp2'],
      assets: ['steam-trap-1'],
      applications: ['steam-trap-1/failed-closed'],
    });
    expect(configuration.devices['enless-twin-temp-1']?.settings).toEqual({
      numFaultyValues: 3,
    });
    expect(configuration.devices['enless-twin-temp-1']?.datastreams?.temp1).toEqual({
      maxBufferLength: 5,
      maxBufferAgeMs: 1_800_000,
      expectedIntervalMs: 600_000,
      gracePeriodCoefficient: 2,
      extra: { modbus: { registers: { value: 301 } } },
    });
    expect(configuration.assets['steam-trap-1']?.applications[0]?.settings).toEqual({
      tempDiffMargin: 0.5,
      offThreshold: 80,
      tempDiffThreshold: 30,
      windowSizeMs: 1_800_000,
    });
  });
});

describe('PROFILE-03 unavailable plugin type', () => {
  it('rejects an unregistered type during configuration validation', () => {
    const raw = loadExample() as {
      devices: Record<string, { type: string }>;
    };
    const device = raw.devices['enless-twin-temp-1'];
    if (device === undefined) {
      throw new Error('Example Device is missing');
    }
    device.type = 'sxs.unavailable-device';

    expect(() =>
      new ConfigurationBuilder(createUg65ExamplePluginRegistry()).build(
        raw,
        asEngineId('ug65-example'),
      ),
    ).toThrow(ConfigurationValidationError);
    expect(() =>
      new ConfigurationBuilder(createUg65ExamplePluginRegistry()).build(
        raw,
        asEngineId('ug65-example'),
      ),
    ).toThrow('Plugin type is not installed: sxs.unavailable-device');
  });
});
