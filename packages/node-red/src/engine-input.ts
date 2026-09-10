import {
  type Engine,
  type EngineIngestInput,
  type EngineIngestIssue,
  type Unsubscribe,
} from '@sxs/industrial-core';
import type { Node, NodeAPI, NodeDef, NodeMessage, NodeMessageInFlow } from 'node-red';

import type { IndustrialEngineNode } from './industrial-engine';
import { ENGINE_INPUT_NODE_TYPE } from './node-types';

export type ReadinessPolicy = 'reject' | 'queue';

export interface EngineInputNodeConfiguration extends NodeDef {
  readonly engine: string;
  readonly readinessPolicy?: ReadinessPolicy;
}

type Send = (msg: NodeMessage | Array<NodeMessage | NodeMessage[] | null>) => void;
type Done = (error?: Error) => void;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const normalizeEngineInput = (msg: NodeMessageInFlow): EngineIngestInput => {
  const issues: EngineIngestIssue[] = [];
  const payload = msg.payload;
  if (!isRecord(payload)) {
    return {
      source: 'engine-input',
      issues: ['INVALID_RAW_PAYLOAD'],
    };
  }

  const deviceName = payload['deviceName'];
  if (typeof deviceName !== 'string' || deviceName.trim() === '') {
    issues.push('INVALID_DEVICE_NAME');
  }
  const rawPayload = payload['rawPayload'];
  if (!isRecord(rawPayload)) {
    issues.push('INVALID_RAW_PAYLOAD');
  }
  const timestamp = payload['timestamp'];
  if (typeof timestamp !== 'number' || !Number.isSafeInteger(timestamp)) {
    issues.push('INVALID_TIMESTAMP');
  }

  return {
    ...(typeof deviceName === 'string' && deviceName.trim() !== '' ? { deviceName } : {}),
    ...(isRecord(rawPayload) ? { rawPayload } : {}),
    ...(typeof timestamp === 'number' && Number.isSafeInteger(timestamp) ? { timestamp } : {}),
    source: 'engine-input',
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

export const createEngineInputHandler =
  (
    node: Node,
    engineNode: IndustrialEngineNode | undefined,
    readinessPolicy: ReadinessPolicy,
  ): ((msg: NodeMessageInFlow, _send: Send, done: Done) => void) =>
  (msg, _send, done) => {
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

      const accepted = await engine.ingest(normalizeEngineInput(msg));
      node.status(
        accepted
          ? { fill: 'green', shape: 'dot', text: 'input accepted' }
          : { fill: 'yellow', shape: 'ring', text: 'input rejected' },
      );
      done();
    })().catch((error: unknown) => {
      const failure = error instanceof Error ? error : new Error(String(error));
      node.status({ fill: 'red', shape: 'ring', text: 'input failed' });
      done(failure);
    });
  };

export const registerEngineInputNode = (RED: NodeAPI): void => {
  function EngineInputNode(this: Node, config: EngineInputNodeConfiguration): void {
    RED.nodes.createNode(this, config);
    const engineNode = RED.nodes.getNode(config.engine) as IndustrialEngineNode | null;
    this.on(
      'input',
      createEngineInputHandler(this, engineNode ?? undefined, config.readinessPolicy ?? 'reject'),
    );
  }

  RED.nodes.registerType(ENGINE_INPUT_NODE_TYPE, EngineInputNode);
};
