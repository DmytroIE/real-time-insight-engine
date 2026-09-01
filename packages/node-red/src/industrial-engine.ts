import {
  ConfigurationBuilder,
  Engine,
  type Clock,
  type EngineEvent,
  type PluginRegistry,
  type TimerScheduler,
} from '@sxs/industrial-core';
import type { Node, NodeAPI, NodeDef } from 'node-red';

import { ENGINE_CONFIG_NODE_TYPE } from './node-types';
import { DEFAULT_CONTEXT_STORE, NodeRedContextStateStore } from './node-red-context-state-store';

export interface IndustrialEngineNodeConfiguration extends NodeDef {
  readonly configuration: string | unknown;
  readonly contextStore?: string;
}

export interface IndustrialEngineNode extends Node {
  engine: Engine | undefined;
  ready: Promise<Engine>;
}

export interface IndustrialEngineNodeRegistrationOptions {
  readonly createPluginRegistry: () => PluginRegistry;
  readonly createEngine?: typeof Engine.create;
  readonly clock?: Clock;
  readonly timers?: TimerScheduler;
}

export const PLUGIN_REGISTRY_CONTEXT_KEY = 'industrialEnginePluginRegistry';

const resolvePluginRegistryFactory = (
  RED: NodeAPI,
  options?: IndustrialEngineNodeRegistrationOptions,
): (() => PluginRegistry) | undefined => {
  if (options !== undefined) {
    return options.createPluginRegistry;
  }
  const settings = RED.settings as unknown as {
    readonly functionGlobalContext?: Readonly<Record<string, unknown>>;
  };
  const factory = settings.functionGlobalContext?.[PLUGIN_REGISTRY_CONTEXT_KEY];
  return typeof factory === 'function' ? (factory as () => PluginRegistry) : undefined;
};

const systemClock: Clock = {
  wallTimeMs: () => Date.now(),
  monotonicTimeMs: () => performance.now(),
};

const systemTimers: TimerScheduler<ReturnType<typeof setTimeout>> = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle),
};

const parseConfiguration = (value: string | unknown): unknown =>
  typeof value === 'string' ? (JSON.parse(value) as unknown) : value;

const statusForLifecycle = (
  event: EngineEvent,
): { fill: 'green' | 'yellow' | 'red'; shape: 'dot' | 'ring'; text: string } | undefined => {
  if (event.type !== 'engine.lifecycle') {
    return undefined;
  }
  switch (event.data.state) {
    case 'ready':
      return { fill: 'green', shape: 'dot', text: 'ready' };
    case 'failed':
      return { fill: 'red', shape: 'ring', text: 'failed' };
    default:
      return { fill: 'yellow', shape: 'ring', text: event.data.state };
  }
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const ensureContextStoreConfigured = (RED: NodeAPI, storeName: string): void => {
  const settings = RED.settings as unknown as { readonly contextStorage?: unknown };
  const stores = settings.contextStorage;
  if (
    typeof stores !== 'object' ||
    stores === null ||
    !Object.prototype.hasOwnProperty.call(stores, storeName)
  ) {
    throw new Error(`Node-RED context store "${storeName}" is not configured`);
  }
};

export const createIndustrialEngineCloseHandler =
  (node: IndustrialEngineNode): ((_removed: boolean, done: () => void) => void) =>
  (_removed, done) => {
    let completed = false;
    const complete = (): void => {
      if (!completed) {
        completed = true;
        done();
      }
    };
    void node.ready
      .then((engine) => engine.close())
      .catch((error: unknown) => {
        if (node.engine !== undefined) {
          node.error(errorMessage(error));
        }
      })
      .finally(complete);
  };

export const registerIndustrialEngineNode = (
  RED: NodeAPI,
  options?: IndustrialEngineNodeRegistrationOptions,
): void => {
  function IndustrialEngineNode(
    this: IndustrialEngineNode,
    config: IndustrialEngineNodeConfiguration,
  ): void {
    RED.nodes.createNode(this, config);
    this.engine = undefined;
    this.status({ fill: 'yellow', shape: 'ring', text: 'starting' });

    const initialize = async (): Promise<Engine> => {
      const createPluginRegistry = resolvePluginRegistryFactory(RED, options);
      if (createPluginRegistry === undefined) {
        throw new Error('Industrial Engine plugin registry is not configured');
      }
      const plugins = createPluginRegistry();
      const configuration = new ConfigurationBuilder(plugins).build(
        parseConfiguration(config.configuration),
      );
      const contextStore = config.contextStore || DEFAULT_CONTEXT_STORE;
      ensureContextStoreConfigured(RED, contextStore);
      const engine = await (options?.createEngine ?? Engine.create)(configuration, {
        clock: options?.clock ?? systemClock,
        timers: options?.timers ?? systemTimers,
        plugins,
        stateStore: new NodeRedContextStateStore(this.context(), contextStore),
        lifecycleListener: (event) => {
          const status = statusForLifecycle(event);
          if (status !== undefined) {
            this.status(status);
          }
        },
      });
      this.engine = engine;
      this.status({ fill: 'green', shape: 'dot', text: 'ready' });
      return engine;
    };

    this.ready = initialize();
    void this.ready.catch((error: unknown) => {
      this.status({ fill: 'red', shape: 'ring', text: 'failed' });
      this.error(errorMessage(error));
    });

    this.on('close', createIndustrialEngineCloseHandler(this));
  }

  RED.nodes.registerType(ENGINE_CONFIG_NODE_TYPE, IndustrialEngineNode);
};
