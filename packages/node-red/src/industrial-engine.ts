import {
  ConfigurationBuilder,
  Engine,
  asEngineId,
  type Clock,
  type EngineEvent,
  type PluginRegistry,
  type StateStore,
  type TimerScheduler,
} from '@sxs/industrial-core';
import type { Node, NodeAPI, NodeDef } from 'node-red';

import { ENGINE_CONFIG_NODE_TYPE } from './node-types';
import { NodeRedContextStateStore } from './node-red-context-state-store';

export interface IndustrialEngineNodeConfiguration extends NodeDef {
  readonly configuration: string | unknown;
  readonly contextStore?: string;
  readonly cleanSessionRequestId?: string;
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
const cleanSessionMarkerKey = (engineId: string): string =>
  `industrial-engine/clean-session/${engineId}`;

export const consumeCleanSessionRequest = async (
  store: StateStore,
  engineId: ReturnType<typeof asEngineId>,
  requestId: string | undefined,
): Promise<boolean> => {
  const normalizedRequestId = requestId?.trim();
  if (normalizedRequestId === undefined || normalizedRequestId.length === 0) {
    return false;
  }
  const markerKey = cleanSessionMarkerKey(engineId);
  if ((await store.load<string>(markerKey)) === normalizedRequestId) {
    return false;
  }
  await Engine.deletePersistedState(engineId, store);
  await store.save(markerKey, normalizedRequestId);
  return true;
};

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

interface ResolvedContextStore {
  readonly storeName: string | undefined;
  readonly warning?: string;
}

const resolveContextStore = (
  RED: NodeAPI,
  configuredStoreName: string | undefined,
): ResolvedContextStore => {
  const settings = RED.settings as unknown as { readonly contextStorage?: unknown };
  const stores = settings.contextStorage;
  const requestedStoreName = configuredStoreName?.trim();
  const configuredStores =
    typeof stores === 'object' && stores !== null
      ? (stores as Readonly<Record<string, unknown>>)
      : {};
  const defaultStoreName =
    typeof configuredStores['default'] === 'string' &&
    Object.prototype.hasOwnProperty.call(configuredStores, configuredStores['default'])
      ? configuredStores['default']
      : undefined;

  if (
    requestedStoreName !== undefined &&
    requestedStoreName.length > 0 &&
    Object.prototype.hasOwnProperty.call(configuredStores, requestedStoreName)
  ) {
    return { storeName: requestedStoreName };
  }

  if (requestedStoreName === undefined || requestedStoreName.length === 0) {
    return {
      storeName: defaultStoreName,
      warning: 'The "Context store" input field is empty; using the Node-RED default context store',
    };
  }

  return {
    storeName: defaultStoreName,
    warning: `Context store "${requestedStoreName}" is unavailable; using the Node-RED default context store`,
  };
};

const statusForContextStore = (
  contextStore: ResolvedContextStore,
): { fill: 'green' | 'yellow'; shape: 'dot'; text: string } => {
  if (contextStore.warning !== undefined) {
    return { fill: 'yellow', shape: 'dot', text: 'ready: default context store' };
  }
  return { fill: 'green', shape: 'dot', text: 'ready' };
};

export const createIndustrialEngineCloseHandler =
  (node: IndustrialEngineNode): ((removed: boolean, done: () => void) => void) =>
  (removed, done) => {
    let completed = false;
    const complete = (): void => {
      if (!completed) {
        completed = true;
        done();
      }
    };
    void node.ready
      .then(async (engine) => {
        await engine.close();
        if (removed) {
          await engine.deletePersistedState();
        }
      })
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
        asEngineId(config.id),
      );
      const contextStore = resolveContextStore(RED, config.contextStore);
      if (contextStore.warning !== undefined) {
        this.warn(contextStore.warning);
      }
      const stateStore = new NodeRedContextStateStore(this.context(), contextStore.storeName);
      const cleanSession = await consumeCleanSessionRequest(
        stateStore,
        configuration.engineId,
        config.cleanSessionRequestId,
      );
      const engine = await (options?.createEngine ?? Engine.create)(configuration, {
        clock: options?.clock ?? systemClock,
        timers: options?.timers ?? systemTimers,
        plugins,
        stateStore,
        cleanSession,
        lifecycleListener: (event) => {
          const status = statusForLifecycle(event);
          if (status !== undefined) {
            this.status(status);
          }
        },
      });
      this.engine = engine;
      if (cleanSession) {
        this.warn('Insight Engine started with a clean session; persisted state was cleared');
      }
      this.status(statusForContextStore(contextStore));
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
