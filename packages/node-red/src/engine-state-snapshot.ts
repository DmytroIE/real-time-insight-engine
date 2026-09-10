import {
  EntityKind,
  SnapshotRequestError,
  type Engine,
  type DiagnosticSnapshotSelector,
  type EntitySnapshotSelector,
  type SnapshotRequest,
} from '@sxs/industrial-core';
import type { Node, NodeAPI, NodeDef, NodeMessage, NodeMessageInFlow } from 'node-red';

import type { IndustrialEngineNode } from './industrial-engine';
import { ENGINE_STATE_SNAPSHOT_NODE_TYPE } from './node-types';

export interface EngineStateSnapshotNodeConfiguration extends NodeDef {
  readonly engine: string;
}

type Send = (msg: NodeMessage | Array<NodeMessage | NodeMessage[] | null>) => void;
type Done = (error?: Error) => void;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isEntityKind = (value: unknown): value is EntityKind =>
  Object.values(EntityKind).includes(value as EntityKind);

const isDiagnosticType = (value: unknown): value is EntityKind | 'common' =>
  value === 'common' || isEntityKind(value);

const parseIds = (value: unknown, selectorName: string): string | readonly string[] | '*' => {
  if (value === '*') {
    return value;
  }
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value) && value.length > 0 && value.every((id) => typeof id === 'string')) {
    return value;
  }
  throw new SnapshotRequestError(
    `${selectorName} ids must be a string, nonempty string array, or "*"`,
  );
};

const parseOptionalBoolean = (value: unknown, property: string): boolean | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    throw new SnapshotRequestError(`Snapshot selector ${property} must be boolean`);
  }
  return value;
};

const parseEntitySelectors = (value: unknown): readonly EntitySnapshotSelector[] => {
  if (!Array.isArray(value) || value.length === 0) {
    throw new SnapshotRequestError('Snapshot entities must be a nonempty selector array');
  }
  return value.map((selector) => {
    if (!isRecord(selector) || !isEntityKind(selector['type'])) {
      throw new SnapshotRequestError('Snapshot entity selector type is invalid');
    }
    const statePaths = selector['statePaths'];
    if (
      statePaths !== undefined &&
      (!Array.isArray(statePaths) || !statePaths.every((path) => typeof path === 'string'))
    ) {
      throw new SnapshotRequestError(
        'Snapshot entity selector statePaths must be an array of strings',
      );
    }
    const parent = parseOptionalBoolean(selector['parent'], 'parent');
    const children = parseOptionalBoolean(selector['children'], 'children');
    const datafeeds = parseOptionalBoolean(selector['datafeeds'], 'datafeeds');
    return {
      type: selector['type'],
      ids: parseIds(selector['ids'], 'Snapshot entity selector'),
      ...(parent === undefined ? {} : { parent }),
      ...(children === undefined ? {} : { children }),
      ...(datafeeds === undefined ? {} : { datafeeds }),
      ...(statePaths === undefined ? {} : { statePaths }),
    };
  });
};

const parseDiagnosticSelectors = (value: unknown): readonly DiagnosticSnapshotSelector[] => {
  if (!Array.isArray(value) || value.length === 0) {
    throw new SnapshotRequestError('Snapshot diagnostics must be a nonempty selector array');
  }
  return value.map((selector) => {
    if (!isRecord(selector) || !isDiagnosticType(selector['type'])) {
      throw new SnapshotRequestError('Snapshot diagnostic selector type is invalid');
    }
    if (
      selector['parent'] !== undefined ||
      selector['children'] !== undefined ||
      selector['datafeeds'] !== undefined ||
      selector['statePaths'] !== undefined
    ) {
      throw new SnapshotRequestError('Snapshot diagnostic selectors do not support entity options');
    }
    return {
      type: selector['type'],
      ids: parseIds(selector['ids'], 'Snapshot diagnostic selector'),
    };
  });
};

export const parseSnapshotRequest = (value: unknown): SnapshotRequest => {
  if (!isRecord(value) || typeof value === 'string') {
    throw new SnapshotRequestError('Snapshot request must be an object');
  }
  if (value['entities'] === undefined && value['diagnostics'] === undefined) {
    throw new SnapshotRequestError('Snapshot request needs entities or diagnostics selectors');
  }
  if (Object.keys(value).some((key) => key !== 'entities' && key !== 'diagnostics')) {
    throw new SnapshotRequestError('Snapshot request contains an unsupported property');
  }
  return {
    ...(value['entities'] === undefined
      ? {}
      : { entities: parseEntitySelectors(value['entities']) }),
    ...(value['diagnostics'] === undefined
      ? {}
      : { diagnostics: parseDiagnosticSelectors(value['diagnostics']) }),
  };
};

export const createEngineStateSnapshotHandler =
  (
    node: Pick<Node, 'status'>,
    engineNode: IndustrialEngineNode | undefined,
  ): ((msg: NodeMessageInFlow, send: Send, done: Done) => void) =>
  (msg, send, done) => {
    void (async () => {
      if (engineNode === undefined) {
        throw new SnapshotRequestError('Configured Industrial Engine node is unavailable');
      }
      const engine: Engine = await engineNode.ready;
      const request = parseSnapshotRequest(msg['snapshotRequest']);
      msg['snapshot'] = engine.snapshot(request);
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
    this.on('input', createEngineStateSnapshotHandler(this, engineNode ?? undefined));
  }

  RED.nodes.registerType(ENGINE_STATE_SNAPSHOT_NODE_TYPE, EngineStateSnapshotNode);
};
