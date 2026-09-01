import { describe, expect, it } from 'vitest';

import { ParentRecomputationController } from '../src/parent-recomputation';
import { FakeTimerScheduler } from './support/fake-timer-scheduler';

describe('AGG-01 burst coalescing', () => {
  it('creates one pending timer for a burst of requests', () => {
    const timers = new FakeTimerScheduler();
    let recomputations = 0;
    const controller = new ParentRecomputationController(timers, () => {
      recomputations += 1;
    });

    controller.requestRecompute();
    controller.requestRecompute();
    controller.requestRecompute();

    expect(timers.pendingCount).toBe(1);
    expect(recomputations).toBe(0);
    timers.runNext();
    expect(recomputations).toBe(1);
  });
});

describe('AGG-02 latest-state recomputation', () => {
  it('reads the latest state once when the trailing timer fires', () => {
    const timers = new FakeTimerScheduler();
    let childState = 1;
    const observed: number[] = [];
    const controller = new ParentRecomputationController(timers, () => {
      observed.push(childState);
    });

    controller.requestRecompute();
    childState = 2;
    controller.requestRecompute();
    timers.runNext();

    expect(observed).toEqual([2]);
    expect(timers.pendingCount).toBe(0);
  });
});

describe('AGG-03 dirty-during-run follow-up', () => {
  it('schedules exactly one trailing pass when requests arrive during recomputation', () => {
    const timers = new FakeTimerScheduler();
    let recomputations = 0;
    const controller = new ParentRecomputationController(timers, () => {
      recomputations += 1;
      if (recomputations === 1) {
        controller.requestRecompute();
        controller.requestRecompute();
      }
    });

    controller.requestRecompute();
    timers.runNext();

    expect(recomputations).toBe(1);
    expect(timers.pendingCount).toBe(1);
    timers.runNext();
    expect(recomputations).toBe(2);
    expect(timers.pendingCount).toBe(0);
  });
});

describe('AGG-04 synchronous recomputation and shutdown', () => {
  it('recomputes synchronously and flushes pending work before closing', () => {
    const timers = new FakeTimerScheduler();
    let recomputations = 0;
    const controller = new ParentRecomputationController(timers, () => {
      recomputations += 1;
    });

    controller.requestRecompute();
    controller.recomputeNow();
    expect(recomputations).toBe(1);
    expect(timers.pendingCount).toBe(0);

    controller.requestRecompute();
    controller.flushAndClose();
    expect(recomputations).toBe(2);
    expect(timers.pendingCount).toBe(0);

    controller.requestRecompute();
    expect(timers.pendingCount).toBe(0);
  });
});
