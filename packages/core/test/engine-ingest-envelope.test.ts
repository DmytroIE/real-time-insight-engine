import { describe, expect, it, vi } from 'vitest';

import {
  Engine,
  PluginRegistry,
  asDeviceId,
  asEngineId,
  asPluginTypeId,
  type DevicePlugin,
  type EngineConfiguration,
  type EngineEvent,
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
  it('rejects malformed payloads through an Engine-owned diagnostic and clears it on valid input', async () => {
    const engine = createEngine();
    parse.mockClear();
    const events: EngineEvent[] = [];
    engine.subscribe('diagnostic.*', (event) => events.push(event));

    await engine.ingest({
      deviceName: 'device-1',
      rawPayload: { value: 1 },
      source: 'engine-input',
      issues: ['INVALID_TIMESTAMP'],
    });

    expect(parse).not.toHaveBeenCalled();
    expect(
      engine.snapshot({ diagnostics: [{ type: 'common', ids: '*' }] }).diagnostics.common[
        'engine-1'
      ],
    ).toContainEqual(
      expect.objectContaining({
        sourceId: 'engine-1',
        ownerScope: 'engine-ingest',
        code: 'INVALID_INGEST_ENVELOPE',
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'diagnostic.raised',
        data: expect.objectContaining({ code: 'INVALID_INGEST_ENVELOPE' }),
      }),
    );

    await engine.ingest({
      deviceName: 'device-1',
      rawPayload: { value: 2 },
      timestamp: 2_100,
      source: 'engine-input',
      issues: [],
    });

    expect(parse).toHaveBeenCalledWith(
      { value: 2 },
      expect.objectContaining({ sourceTimestamp: 2_100, receivedTimestamp: 2_000 }),
    );
    expect(
      engine.snapshot({ diagnostics: [{ type: 'common', ids: '*' }] }).diagnostics.common[
        'engine-1'
      ] ?? [],
    ).not.toContainEqual(
      expect.objectContaining({
        sourceId: 'engine-1',
        ownerScope: 'engine-ingest',
        code: 'INVALID_INGEST_ENVELOPE',
      }),
    );
  });

  it.each([
    ['missing', undefined],
    ['unknown', asDeviceId('missing-device')],
  ])('reports %s Devices as Common diagnostics without parsing', async (_case, deviceId) => {
    const engine = createEngine();
    parse.mockClear();

    await expect(
      engine.ingest({
        ...(deviceId === undefined ? {} : { deviceId }),
        rawPayload: {},
        timestamp: 2_000,
        source: 'engine-input',
        issues: [],
      }),
    ).resolves.toBe(false);

    expect(parse).not.toHaveBeenCalled();
    expect(
      engine.snapshot({ diagnostics: [{ type: 'common', ids: '*' }] }).diagnostics.common[
        'engine-1'
      ],
    ).toContainEqual(
      expect.objectContaining({
        sourceId: 'engine-1',
        ownerScope: 'engine-ingest',
        code: deviceId === undefined ? 'INVALID_INGEST_ENVELOPE' : 'DEVICE_NOT_RECOGNIZED',
      }),
    );
  });

  it('rejects fractional timestamps without parsing', async () => {
    const engine = createEngine();
    parse.mockClear();

    await expect(
      engine.ingest({
        deviceName: 'device-1',
        rawPayload: {},
        timestamp: 2_000.5,
        source: 'engine-input',
        issues: [],
      }),
    ).resolves.toBe(false);

    expect(parse).not.toHaveBeenCalled();
  });
});
