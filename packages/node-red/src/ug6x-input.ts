import {
  asDeviceId,
  type Engine,
  type EngineIngestInput,
  type EngineIngestIssue,
  type Unsubscribe,
} from '@sxs/industrial-core';
import type { Node, NodeAPI, NodeDef, NodeMessage, NodeMessageInFlow } from 'node-red';

import type { IndustrialEngineNode } from './industrial-engine';
import { UG6X_INPUT_NODE_TYPE } from './node-types';

export type ReadinessPolicy = 'reject' | 'queue';

export interface Ug6xInputNodeConfiguration extends NodeDef {
  readonly engine: string;
  readonly readinessPolicy?: ReadinessPolicy;
}

export interface Ug6xInputNodeRegistrationOptions {
  readonly now?: () => number;
}

type Send = (msg: NodeMessage | Array<NodeMessage | NodeMessage[] | null>) => void;
type Done = (error?: Error) => void;

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export const normalizeUg6xInput = (
  msg: NodeMessageInFlow,
  receivedTimestamp: number,
): EngineIngestInput => {
  const issues: EngineIngestIssue[] = [];
  const deviceName =
    typeof msg['deviceName'] === 'string' && msg['deviceName'].trim() !== ''
      ? msg['deviceName']
      : undefined;
  if (deviceName === undefined) {
    issues.push('NO_DEVICE_NAME');
  }

  const gatewayTime = msg['gatewayTime'];
  let sourceTimestamp = receivedTimestamp;
  if (gatewayTime === undefined || gatewayTime === null || gatewayTime === '') {
    issues.push('NO_GATEWAY_TIME');
  } else if (typeof gatewayTime === 'string' && ISO_TIMESTAMP.test(gatewayTime)) {
    const parsed = Date.parse(gatewayTime);
    if (Number.isFinite(parsed)) {
      sourceTimestamp = parsed;
    } else {
      issues.push('INVALID_GATEWAY_TIME');
    }
  } else {
    issues.push('INVALID_GATEWAY_TIME');
  }

  return {
    ...(deviceName === undefined ? {} : { deviceId: asDeviceId(deviceName) }),
    rawPayload: msg,
    sourceTimestamp,
    receivedTimestamp,
    source: 'ug6x',
    issues,
  };
};

const waitUntilReady = async (engineNode: IndustrialEngineNode): Promise<Engine> => {
  const engine = engineNode.engine ?? (await engineNode.ready);
  if (engine.isReady) {
    return engine;
  }
  return new Promise((resolve, reject) => {
    const subscription: { unsubscribe?: Unsubscribe } = {};
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      subscription.unsubscribe?.();
      action();
    };
    subscription.unsubscribe = engine.subscribe('engine.lifecycle', (event) => {
      if (event.type !== 'engine.lifecycle') {
        return;
      }
      if (event.data.ready) {
        finish(() => resolve(engine));
      } else if (event.data.state === 'failed' || event.data.state === 'stopping') {
        finish(() => reject(new Error(`Engine became ${event.data.state} while input was queued`)));
      }
    });
    if (settled) {
      subscription.unsubscribe();
    }
  });
};

export const createUg6xInputHandler =
  (
    node: Node,
    engineNode: IndustrialEngineNode | undefined,
    readinessPolicy: ReadinessPolicy,
    now: () => number = Date.now,
  ): ((msg: NodeMessageInFlow, send: Send, done: Done) => void) =>
  (msg, send, done) => {
    void (async () => {
      if (engineNode === undefined) {
        throw new Error('Configured Industrial Engine node is unavailable');
      }
      let engine = engineNode.engine;
      if (engine?.isReady !== true) {
        if (readinessPolicy === 'reject') {
          node.status({ fill: 'yellow', shape: 'ring', text: 'engine not ready' });
          done();
          return;
        }
        engine = await waitUntilReady(engineNode);
      }

      const accepted = await engine.ingest(normalizeUg6xInput(msg, now()));
      if (accepted) {
        node.status({ fill: 'green', shape: 'dot', text: 'input accepted' });
        send(msg);
      } else {
        node.status({ fill: 'yellow', shape: 'ring', text: 'input rejected' });
      }
      done();
    })().catch((error: unknown) => {
      const failure = error instanceof Error ? error : new Error(String(error));
      node.status({ fill: 'red', shape: 'ring', text: 'input failed' });
      done(failure);
    });
  };

export const registerUg6xInputNode = (
  RED: NodeAPI,
  options: Ug6xInputNodeRegistrationOptions = {},
): void => {
  function Ug6xInputNode(this: Node, config: Ug6xInputNodeConfiguration): void {
    RED.nodes.createNode(this, config);
    const engineNode = RED.nodes.getNode(config.engine) as IndustrialEngineNode | null;
    this.on(
      'input',
      createUg6xInputHandler(
        this,
        engineNode ?? undefined,
        config.readinessPolicy ?? 'reject',
        options.now,
      ),
    );
  }

  RED.nodes.registerType(UG6X_INPUT_NODE_TYPE, Ug6xInputNode);
};
