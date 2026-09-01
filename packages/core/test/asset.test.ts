import { describe, expect, it } from 'vitest';

import {
  Asset,
  InMemoryEventBus,
  ProcessState,
  asApplicationId,
  asAssetId,
  asEngineId,
  type AssetApplication,
  type AssetApplicationState,
  type EngineEvent,
  type PersistenceMarker,
} from '../src';
import { FakeClock } from './support/fake-clock';
import { FakeTimerScheduler } from './support/fake-timer-scheduler';

class MutableApplication implements AssetApplication {
  public constructor(
    public readonly id: ReturnType<typeof asApplicationId>,
    public currentState: AssetApplicationState,
  ) {}

  public state(): AssetApplicationState {
    return { ...this.currentState };
  }
}

class FakePersistenceMarker implements PersistenceMarker {
  public dirtyCount = 0;

  public markDirty(): void {
    this.dirtyCount += 1;
  }
}

const applicationState = (
  currState: ProcessState,
  noDataError = false,
  appError = false,
): AssetApplicationState => ({ currState, noDataError, appError });

const setup = () => {
  const clock = new FakeClock(1_000, 0);
  const eventBus = new InMemoryEventBus();
  const events: EngineEvent[] = [];
  eventBus.subscribe('*', (event) => events.push(event));
  const persistence = new FakePersistenceMarker();
  const timers = new FakeTimerScheduler();
  const asset = new Asset(
    { id: asAssetId('asset-1'), engineId: asEngineId('engine-1') },
    clock,
    eventBus,
    persistence,
    timers,
  );
  return { asset, clock, events, persistence, timers };
};

describe('ASSET-01 empty Asset defaults', () => {
  it('starts Undefined without an error and with the default timestamp', () => {
    const { asset } = setup();

    expect(asset.state()).toEqual({
      lastUpdateTimestamp: 0,
      currState: ProcessState.Undefined,
      error: false,
    });
  });
});

describe('ASSET-02 process-state aggregation', () => {
  it('uses the maximum state among direct registered Applications', () => {
    const { asset, events, persistence } = setup();
    const first = new MutableApplication(
      asApplicationId('application-1'),
      applicationState(ProcessState.Warning),
    );
    const second = new MutableApplication(
      asApplicationId('application-2'),
      applicationState(ProcessState.Error),
    );
    asset.registerApplication(first);
    asset.registerApplication(second);

    expect(asset.application(first.id)).toBe(first);
    expect(asset.recompute()).toEqual({
      lastUpdateTimestamp: 1_000,
      currState: ProcessState.Error,
      error: false,
    });
    expect(persistence.dirtyCount).toBe(1);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'entity.updated', timestamp: 1_000 }),
    );
  });
});

describe('ASSET-03 Application error aggregation', () => {
  it('is true iff a child has a no-data or Application error', () => {
    const { asset, clock } = setup();
    const first = new MutableApplication(
      asApplicationId('application-1'),
      applicationState(ProcessState.Ok, true),
    );
    const second = new MutableApplication(
      asApplicationId('application-2'),
      applicationState(ProcessState.Warning),
    );
    asset.registerApplication(first);
    asset.registerApplication(second);

    expect(asset.recompute().error).toBe(true);
    first.currentState = applicationState(ProcessState.Ok);
    second.currentState = applicationState(ProcessState.Warning, false, true);
    clock.advanceWallBy(25);
    expect(asset.recompute().error).toBe(true);
    second.currentState = applicationState(ProcessState.Warning);
    clock.advanceWallBy(25);

    expect(asset.recompute()).toEqual({
      lastUpdateTimestamp: 1_050,
      currState: ProcessState.Warning,
      error: false,
    });
  });
});

describe('AGG-01 and AGG-02 Asset recomputation', () => {
  it('coalesces a burst and reads the latest Application state once', () => {
    const { asset, events, persistence, timers } = setup();
    const application = new MutableApplication(
      asApplicationId('application-1'),
      applicationState(ProcessState.Ok),
    );
    asset.registerApplication(application);

    asset.requestRecompute();
    application.currentState = applicationState(ProcessState.Error, false, true);
    asset.requestRecompute();
    asset.requestRecompute();

    expect(timers.pendingCount).toBe(1);
    expect(asset.state()).toMatchObject({ currState: ProcessState.Undefined, error: false });
    timers.runNext();
    expect(asset.state()).toMatchObject({ currState: ProcessState.Error, error: true });
    expect(persistence.dirtyCount).toBe(1);
    expect(events.filter((event) => event.type === 'entity.updated')).toHaveLength(1);

    asset.requestRecompute();
    timers.runNext();
    expect(persistence.dirtyCount).toBe(1);
    expect(events.filter((event) => event.type === 'entity.updated')).toHaveLength(1);
  });
});
