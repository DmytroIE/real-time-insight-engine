import { describe, expect, it } from 'vitest';

import {
  Device,
  DiagnosticRegistry,
  InMemoryEventBus,
  asDatastreamId,
  asDeviceId,
  asEngineId,
  asPluginTypeId,
  type DeviceDatastream,
  type DevicePayloadParseResult,
  type EngineEvent,
  type PersistenceMarker,
} from '../src';
import { FakeClock } from './support/fake-clock';
import { FakeTimerScheduler } from './support/fake-timer-scheduler';

class MutableChild implements DeviceDatastream {
  public readonly id = asDatastreamId('device-1/temperature');
  public hwError = false;
  public noDataError = false;

  public get hasError(): boolean {
    return this.hwError || this.noDataError;
  }

  public acceptSample(sample: { readonly timestamp: number; readonly value: number }): void {
    void sample;
  }

  public rejectInput(
    message: string,
    details?: Readonly<Record<string, unknown>>,
    code?: string,
  ): void {
    void message;
    void details;
    void code;
  }

  public state(): { hwError: boolean; noDataError: boolean } {
    return { hwError: this.hwError, noDataError: this.noDataError };
  }
}

class FakePersistenceMarker implements PersistenceMarker {
  public dirtyCount = 0;

  public markDirty(): void {
    this.dirtyCount += 1;
  }
}

const setup = (
  parse: () => DevicePayloadParseResult | Promise<DevicePayloadParseResult> = () => ({
    accepted: true,
  }),
) => {
  const clock = new FakeClock(1_000, 0);
  const eventBus = new InMemoryEventBus();
  const events: EngineEvent[] = [];
  eventBus.subscribe('*', (event) => events.push(event));
  const diagnostics = new DiagnosticRegistry(clock, eventBus);
  const persistence = new FakePersistenceMarker();
  const timers = new FakeTimerScheduler();
  const device = new Device(
    {
      id: asDeviceId('device-1'),
      engineId: asEngineId('engine-1'),
      pluginType: asPluginTypeId('sxs.test-device'),
      settings: {},
    },
    { parse },
    clock,
    eventBus,
    diagnostics,
    persistence,
    timers,
  );
  return { clock, device, diagnostics, events, persistence, timers };
};

describe('DEV-01 Device defaults', () => {
  it('starts without hardware or aggregate errors and with the default timestamp', () => {
    const { device } = setup();

    expect(device.state()).toEqual({ lastUpdateTimestamp: 0, hwError: false });
    expect(device.chldError).toBe(false);
    expect(device.hasError).toBe(false);
  });
});

describe('DEV-02 Device error aggregation', () => {
  it('includes own hardware error and every child hardware/no-data error', () => {
    const { device } = setup();
    const child = new MutableChild();
    device.registerDatastream('temperature', child);
    expect(device.datastream('temperature')).toBe(child);

    child.hwError = true;
    expect(device.chldError).toBe(true);
    expect(device.hasError).toBe(true);
    child.hwError = false;
    child.noDataError = true;
    device.recompute();
    expect(device.hasError).toBe(true);
    child.noDataError = false;
    device.setHardwareError(true, 'Device fault');
    expect(device.state()).toMatchObject({ hwError: true });
    expect(device.hasError).toBe(true);
  });
});

describe('DEV-03 aggregate error clearing', () => {
  it('clears Device error after the final source error clears and recomputes', () => {
    const { clock, device, events, persistence } = setup();
    const child = new MutableChild();
    child.noDataError = true;
    device.registerDatastream('temperature', child);
    device.recompute();
    clock.advanceWallBy(25);

    child.noDataError = false;
    const state = device.recompute();

    expect(state).toEqual({ lastUpdateTimestamp: 1_025, hwError: false });
    expect(device.chldError).toBe(false);
    expect(device.hasError).toBe(false);
    expect(persistence.dirtyCount).toBe(2);
    expect(events.filter((event) => event.type === 'entity.updated')).toHaveLength(2);
  });
});

describe('AGG-01 and AGG-02 Device recomputation', () => {
  it('coalesces a burst and reads the latest Datastream state once', () => {
    const { device, events, persistence, timers } = setup();
    const child = new MutableChild();
    device.registerDatastream('temperature', child);

    device.requestRecompute();
    child.noDataError = true;
    device.requestRecompute();
    device.requestRecompute();

    expect(timers.pendingCount).toBe(1);
    expect(device.chldError).toBe(true);
    timers.runNext();
    expect(device.chldError).toBe(true);
    expect(device.hasError).toBe(true);
    expect(persistence.dirtyCount).toBe(1);
    expect(events.filter((event) => event.type === 'entity.updated')).toHaveLength(1);

    device.requestRecompute();
    timers.runNext();
    expect(persistence.dirtyCount).toBe(1);
    expect(events.filter((event) => event.type === 'entity.updated')).toHaveLength(1);
  });
});

describe('DEV-04 payload diagnostic reconciliation', () => {
  it('raises invalid payload details and clears them after a successful parse', async () => {
    let result: DevicePayloadParseResult = {
      accepted: false,
      message: 'Unexpected sensor type',
      details: { sensorType: 7 },
    };
    const { device, diagnostics, events } = setup(() => result);

    await expect(
      device.parsePayload({ rawPayload: {}, sourceTimestamp: 900, receivedTimestamp: 1_000 }),
    ).resolves.toBe(false);
    expect(diagnostics.records()).toEqual([
      expect.objectContaining({
        ownerScope: 'device-payload',
        code: 'INVALID_PAYLOAD',
        details: { sensorType: 7 },
      }),
    ]);

    result = { accepted: true };
    await expect(
      device.parsePayload({ rawPayload: {}, sourceTimestamp: 925, receivedTimestamp: 1_025 }),
    ).resolves.toBe(true);
    expect(diagnostics.records()).toEqual([]);
    expect(events.map((event) => event.type)).toEqual(['diagnostic.raised', 'diagnostic.cleared']);
  });
});
