import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import helper from 'node-red-node-test-helper';

import {
  PluginRegistry,
  type Clock,
  type Engine,
  type TimerCallback,
  type TimerScheduler,
} from '@sxs/industrial-core';
import type { NodeAPI, NodeContextData } from 'node-red';

import {
  createIndustrialEngineCloseHandler,
  registerIndustrialEngineNode,
  type IndustrialEngineNode,
  type IndustrialEngineNodeConfiguration,
} from '../src/industrial-engine';
import { ENGINE_CONFIG_NODE_TYPE } from '../src/node-types';
import { NodeRedContextStateStore } from '../src/node-red-context-state-store';

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

interface SinonMethod {
  readonly callCount: number;
  calledWith(value: unknown): boolean;
  calledWithMatch(value: unknown): boolean;
}

const validConfiguration = JSON.stringify({
  devices: {},
  assets: {},
});

const registrationOptions = {
  createPluginRegistry: () => new PluginRegistry(),
  clock: new TestClock(),
  timers: new TestTimers(),
};

const initializer = (RED: NodeAPI): void => {
  registerIndustrialEngineNode(RED, registrationOptions);
};

const flow = (
  overrides: Partial<IndustrialEngineNodeConfiguration> = {},
): IndustrialEngineNodeConfiguration[] => [
  {
    id: 'engine',
    type: ENGINE_CONFIG_NODE_TYPE,
    name: '',
    z: '',
    configuration: validConfiguration,
    contextStore: 'ieps',
    ...overrides,
  },
];

const configuredStores = (includeIeps = true): void => {
  helper.settings({
    contextStorage: {
      default: 'memoryOnly',
      memoryOnly: { module: 'memory' },
      ...(includeIeps ? { ieps: { module: 'memory' } } : {}),
    },
  });
};

const engineNode = (): IndustrialEngineNode => helper.getNode('engine') as IndustrialEngineNode;

describe('Engine config node', () => {
  beforeAll(async () => {
    helper.init(require.resolve('node-red'));
    await new Promise<void>((resolve) => helper.startServer(resolve));
  });

  afterEach(async () => {
    await helper.unload();
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => helper.stopServer(resolve));
  });

  it('NR-02 creates one Engine and exposes lifecycle and state APIs', async () => {
    configuredStores();
    await helper.load(initializer, flow());
    const node = engineNode();

    const engine = await node.ready;

    expect(node.engine).toBe(engine);
    expect(engine.isReady).toBe(true);
    expect(engine.registry()).toEqual({
      devices: [],
      datastreams: [],
      assets: [],
      applications: [],
    });
    expect(engine.snapshot({ target: { scope: 'all' } }).entities).toEqual({
      device: {},
      datastream: {},
      application: {},
      asset: {},
    });
    expect(
      (node.status as typeof node.status & SinonMethod).calledWith({
        fill: 'green',
        shape: 'dot',
        text: 'ready',
      }),
    ).toBe(true);
  });

  it('NR-03 reports invalid configuration and never exposes a ready Engine', async () => {
    configuredStores();
    await helper.load(initializer, flow({ configuration: '{"engineId":' }));
    const node = engineNode();

    await expect(node.ready).rejects.toThrow();
    await Promise.resolve();

    expect(node.engine).toBeUndefined();
    expect(
      (node.status as typeof node.status & SinonMethod).calledWith({
        fill: 'red',
        shape: 'ring',
        text: 'failed',
      }),
    ).toBe(true);
    expect((node.error as typeof node.error & SinonMethod).callCount).toBe(1);
  });

  it('NR-04 persists through the selected named context store', async () => {
    const values = new Map<string, unknown>();
    const storeNames: string[] = [];
    const context = {
      get: (
        key: string,
        storeName: string,
        callback: (error: Error | null, value: unknown) => void,
      ) => {
        storeNames.push(storeName);
        callback(null, values.get(key));
      },
      set: (
        key: string,
        value: unknown,
        storeName: string,
        callback: (error: Error | null) => void,
      ) => {
        storeNames.push(storeName);
        if (value === undefined) {
          values.delete(key);
        } else {
          values.set(key, value);
        }
        callback(null);
      },
      keys: (storeName: string, callback: (error: Error | null, keys: string[]) => void) => {
        storeNames.push(storeName);
        callback(null, [...values.keys()]);
      },
    } as unknown as NodeContextData;
    const store = new NodeRedContextStateStore(context, 'selected-store');

    await store.save('engine/one', { ready: true });
    await expect(store.load('engine/one')).resolves.toEqual({ ready: true });
    await expect(store.keys('engine/')).resolves.toEqual(['engine/one']);
    await store.delete('engine/one');

    expect(storeNames).toEqual([
      'selected-store',
      'selected-store',
      'selected-store',
      'selected-store',
    ]);
  });

  it.each([
    ['blank Context store', '   ', 'The Context store is empty'],
    ['unavailable Context store', 'missing-store', 'Context store "missing-store" is unavailable'],
  ])('NR-05 uses the Node-RED default store for %s', async (_label, contextStore, warning) => {
    configuredStores(false);
    await helper.load(initializer, flow({ contextStore }));
    const node = engineNode();

    await expect(node.ready).resolves.toMatchObject({ isReady: true });

    expect((node.warn as typeof node.warn & SinonMethod).calledWithMatch(warning)).toBe(true);
    expect(
      (node.status as typeof node.status & SinonMethod).calledWith({
        fill: 'yellow',
        shape: 'dot',
        text: 'ready: default context store',
      }),
    ).toBe(true);
    expect((node.error as typeof node.error & SinonMethod).callCount).toBe(0);
    expect(node.engine?.isReady).toBe(true);
  });

  it('NR-06 awaits Engine shutdown and calls the close callback once', async () => {
    let releaseClose!: () => void;
    const closePromise = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const close = vi.fn(() => closePromise);
    const fakeEngine = { close, isReady: true } as unknown as Engine;
    const node = {
      engine: fakeEngine,
      ready: Promise.resolve(fakeEngine),
      error: vi.fn(),
    } as unknown as IndustrialEngineNode;
    let doneCount = 0;
    const closed = new Promise<void>((resolve) => {
      createIndustrialEngineCloseHandler(node)(false, () => {
        doneCount += 1;
        resolve();
      });
    });

    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    expect(doneCount).toBe(0);
    releaseClose();
    await closed;

    expect(close).toHaveBeenCalledTimes(1);
    expect(doneCount).toBe(1);
    expect(node.engine).toBe(fakeEngine);
  });

  it('NR-06 deletes persisted state when the config node is removed', async () => {
    const close = vi.fn(async () => undefined);
    const deletePersistedState = vi.fn(async () => undefined);
    const fakeEngine = { close, deletePersistedState, isReady: true } as unknown as Engine;
    const node = {
      engine: fakeEngine,
      ready: Promise.resolve(fakeEngine),
      error: vi.fn(),
    } as unknown as IndustrialEngineNode;

    await new Promise<void>((resolve) => createIndustrialEngineCloseHandler(node)(true, resolve));

    expect(close).toHaveBeenCalledTimes(1);
    expect(deletePersistedState).toHaveBeenCalledTimes(1);
  });
});
