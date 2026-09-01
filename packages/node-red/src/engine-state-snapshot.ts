import {
  asEngineId,
  asPluginTypeId,
  EntityKind,
  SnapshotRequestError,
  type Engine,
  type EntityEventSource,
  type SnapshotRequest,
} from '@sxs/industrial-core';
import type { Node, NodeAPI, NodeDef, NodeMessage, NodeMessageInFlow } from 'node-red';

import type { IndustrialEngineNode } from './industrial-engine';
import { ENGINE_STATE_SNAPSHOT_NODE_TYPE } from './node-types';

export interface EngineStateSnapshotNodeConfiguration extends NodeDef {
  readonly engine: string;
  readonly snapshotRequest?: string | unknown;
}

type Send = (msg: NodeMessage | Array<NodeMessage | NodeMessage[] | null>) => void;
type Done = (error?: Error) => void;

const DEFAULT_SNAPSHOT_REQUEST: SnapshotRequest = { target: { scope: 'all' } };
const snapshotRelations = new Set(['self', 'parent', 'children', 'family']);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isEntityKind = (value: unknown): value is EntityKind =>
  Object.values(EntityKind).includes(value as EntityKind);

export const parseSnapshotRequest = (value: unknown): SnapshotRequest => {
  const request = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
  if (!isRecord(request) || !isRecord(request['target'])) {
    throw new SnapshotRequestError('Snapshot request must contain a target');
  }
  const target = request['target'];
  const scope = target['scope'];
  if (scope === 'entity') {
    if (!isEntityKind(target['entityType']) || typeof target['entityId'] !== 'string') {
      throw new SnapshotRequestError('Snapshot entity target is invalid');
    }
  } else if (scope !== 'eventSource' && scope !== 'all') {
    throw new SnapshotRequestError('Snapshot target scope is invalid');
  }
  if (
    request['relations'] !== undefined &&
    (typeof request['relations'] !== 'string' || !snapshotRelations.has(request['relations']))
  ) {
    throw new SnapshotRequestError('Snapshot relations value is invalid');
  }
  if (
    request['statePaths'] !== undefined &&
    (!Array.isArray(request['statePaths']) ||
      !request['statePaths'].every((path) => typeof path === 'string'))
  ) {
    throw new SnapshotRequestError('Snapshot statePaths must be an array of strings');
  }
  if (request['strictPaths'] !== undefined && typeof request['strictPaths'] !== 'boolean') {
    throw new SnapshotRequestError('Snapshot strictPaths must be boolean');
  }
  return request as unknown as SnapshotRequest;
};

const eventSourceFromMessage = (msg: NodeMessageInFlow): EntityEventSource | undefined => {
  const event = msg['event'];
  if (!isRecord(event) || !isRecord(event['source'])) {
    return undefined;
  }
  const source = event['source'];
  if (
    typeof source['engineId'] !== 'string' ||
    !isEntityKind(source['entityType']) ||
    typeof source['entityId'] !== 'string'
  ) {
    return undefined;
  }
  return {
    engineId: asEngineId(source['engineId']),
    entityType: source['entityType'],
    entityId: source['entityId'] as EntityEventSource['entityId'],
    ...(typeof source['pluginType'] === 'string'
      ? { pluginType: asPluginTypeId(source['pluginType']) }
      : {}),
  };
};

export const createEngineStateSnapshotHandler =
  (
    node: Pick<Node, 'status'>,
    engineNode: IndustrialEngineNode | undefined,
    configuredRequest: string | unknown = DEFAULT_SNAPSHOT_REQUEST,
  ): ((msg: NodeMessageInFlow, send: Send, done: Done) => void) =>
  (msg, send, done) => {
    void (async () => {
      if (engineNode === undefined) {
        throw new SnapshotRequestError('Configured Industrial Engine node is unavailable');
      }
      const engine: Engine = await engineNode.ready;
      const request = parseSnapshotRequest(
        msg['snapshotRequest'] === undefined ? configuredRequest : msg['snapshotRequest'],
      );
      msg['snapshot'] = engine.snapshot(request, eventSourceFromMessage(msg));
      node.status({ fill: 'green', shape: 'dot', text: 'snapshot ready' });
      send(msg);
      done();
    })().catch((error: unknown) => {
      const failure = error instanceof Error ? error : new Error(String(error));
      node.status({ fill: 'red', shape: 'ring', text: 'snapshot failed' });
      done(failure);
    });
  };

export const registerEngineStateSnapshotNode = (RED: NodeAPI): void => {
  function EngineStateSnapshotNode(this: Node, config: EngineStateSnapshotNodeConfiguration): void {
    RED.nodes.createNode(this, config);
    const engineNode = RED.nodes.getNode(config.engine) as IndustrialEngineNode | null;
    this.on(
      'input',
      createEngineStateSnapshotHandler(
        this,
        engineNode ?? undefined,
        config.snapshotRequest ?? DEFAULT_SNAPSHOT_REQUEST,
      ),
    );
  }

  RED.nodes.registerType(ENGINE_STATE_SNAPSHOT_NODE_TYPE, EngineStateSnapshotNode);
};
