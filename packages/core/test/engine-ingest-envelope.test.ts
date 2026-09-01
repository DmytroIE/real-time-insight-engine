import { describe, expect, it, vi } from 'vitest';

import {
  Engine,
  PluginRegistry,
  asDeviceId,
  asEngineId,
  asPluginTypeId,
  type DevicePlugin,
  type EngineConfiguration,
} from '../src';
import { FakeClock } from './support/fake-clock';
import { FakeTimerScheduler } from './support/fake-timer-scheduler';

const parse = vi.fn(() => ({ accepted: true as const }));

const createEngine = (): Engine => {
  const plugin: DevicePlugin = {
    kind: 'device',
    type: asPluginTypeId('sxs.test-device'),
    version: 1,
    displayName: 'Test Device',
    datastreams: [],
    settingsSchema: { type: 'object', additionalProperties: false },
    defaultSettings: {},
    create: () => ({ parse }),
  };
  const plugins = new PluginRegistry();
  plugins.register(plugin);
  const configuration: EngineConfiguration = {
    engineId: asEngineId('engine-1'),
    devices: { 'device-1': { type: plugin.type, settings: {}, datastreams: {} } },
    assets: {},
  };
  return new Engine(configuration, {
    clock: new FakeClock(2_000, 0),
    timers: new FakeTimerScheduler(),
    plugins,
  });
};

describe('normalized Engine ingestion envelope', () => {
  it('owns known-Device time diagnostics and clears them on a valid envelope', async () => {
    const engine = createEngine();

    await engine.ingest({
      deviceId: asDeviceId('device-1'),
      rawPayload: { value: 1 },
      sourceTimestamp: 2_000,
      receivedTimestamp: 2_000,
      source: 'ug6x',
      issues: ['NO_GATEWAY_TIME'],
    });

    expect(engine.snapshot({ target: { scope: 'all' } }).diagnostics?.Device).toMatchObject([
      { sourceId: 'device-1', ownerScope: 'ingest-envelope', code: 'NO_GATEWAY_TIME' },
    ]);

    await engine.ingest({
      deviceId: asDeviceId('device-1'),
      rawPayload: { value: 2 },
      sourceTimestamp: 2_100,
      receivedTimestamp: 2_100,
      source: 'ug6x',
      issues: [],
    });

    expect(engine.snapshot({ target: { scope: 'all' } }).diagnostics?.Device).toEqual([]);
  });

  it.each([
    ['missing', undefined, ['NO_DEVICE_NAME'] as const],
    ['unknown', asDeviceId('missing-device'), [] as const],
  ])(
    'reports %s Devices as Common diagnostics without parsing',
    async (_case, deviceId, issues) => {
      const engine = createEngine();
      parse.mockClear();

      await expect(
        engine.ingest({
          ...(deviceId === undefined ? {} : { deviceId }),
          rawPayload: {},
          sourceTimestamp: 2_000,
          receivedTimestamp: 2_000,
          source: 'ug6x',
          issues,
        }),
      ).resolves.toBe(false);

      expect(parse).not.toHaveBeenCalled();
      expect(engine.snapshot({ target: { scope: 'all' } }).diagnostics?.Common).toContainEqual(
        expect.objectContaining({
          sourceId: 'engine-1',
          ownerScope: 'engine-ingest',
          code: 'DEVICE_NOT_RECOGNIZED',
        }),
      );
    },
  );
});
