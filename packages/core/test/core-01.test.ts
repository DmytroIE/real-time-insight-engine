import { describe, expect, it } from 'vitest';

import { EntityKind, ProcessState, asDeviceId } from '../src';
import { FakeClock } from './support/fake-clock';

describe('CORE-01 shared contracts', () => {
  it('orders process states from Undefined through Error', () => {
    expect(ProcessState.Undefined).toBe(0);
    expect(ProcessState.Ok).toBe(1);
    expect(ProcessState.Warning).toBe(2);
    expect(ProcessState.Error).toBe(3);
    expect(ProcessState.Undefined).toBeLessThan(ProcessState.Ok);
    expect(ProcessState.Ok).toBeLessThan(ProcessState.Warning);
    expect(ProcessState.Warning).toBeLessThan(ProcessState.Error);
  });

  it('advances wall and monotonic time independently', () => {
    const clock = new FakeClock(1_000, 50);

    clock.advanceWallBy(25);
    expect(clock.wallTimeMs()).toBe(1_025);
    expect(clock.monotonicTimeMs()).toBe(50);

    clock.advanceMonotonicBy(10);
    expect(clock.wallTimeMs()).toBe(1_025);
    expect(clock.monotonicTimeMs()).toBe(60);

    clock.advanceBy(40);
    expect(clock.wallTimeMs()).toBe(1_065);
    expect(clock.monotonicTimeMs()).toBe(100);
  });

  it('preserves branded IDs inside matching entity references', () => {
    const reference = {
      kind: EntityKind.Device,
      id: asDeviceId('device-1'),
    } as const;

    expect(reference).toEqual({ kind: 'device', id: 'device-1' });
  });
});
