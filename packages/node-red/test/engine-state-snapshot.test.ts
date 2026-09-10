import { describe, expect, it, vi } from 'vitest';

import {
  EntityKind,
  SnapshotRequestError,
  type Engine,
  type EngineSnapshotResponse,
  type SnapshotRequest,
} from '@sxs/industrial-core';
import type { Node, NodeMessage, NodeMessageInFlow } from 'node-red';

import {
  createEngineStateSnapshotHandler,
  parseSnapshotRequest,
} from '../src/engine-state-snapshot';
import type { IndustrialEngineNode } from '../src/industrial-engine';

interface Invocation {
  readonly done: Promise<Error | undefined>;
  readonly sent: NodeMessage[];
}

const emptyResponse = (): EngineSnapshotResponse => ({
  entities: { device: {}, datastream: {}, application: {}, asset: {} },
  diagnostics: { common: {}, device: {}, datastream: {}, application: {}, asset: {} },
});
const testNode = () => ({ status: vi.fn() }) as unknown as Pick<Node, 'status'>;
const engineNode = (engine: Engine): IndustrialEngineNode =>
  ({ engine, ready: Promise.resolve(engine) }) as IndustrialEngineNode;

const invoke = (engine: Engine, msg: NodeMessageInFlow): Invocation => {
  const sent: NodeMessage[] = [];
  const done = new Promise<Error | undefined>((resolve) => {
    createEngineStateSnapshotHandler(testNode(), engineNode(engine))(
      msg,
      (output) => {
        if (!Array.isArray(output)) {
          sent.push(output);
        }
      },
      resolve,
    );
  });
  return { done, sent };
};

const fakeEngine = (snapshot: (request: SnapshotRequest) => EngineSnapshotResponse): Engine =>
  ({ snapshot: vi.fn(snapshot) }) as unknown as Engine;

describe('Engine State Snapshot', () => {
  it('NR-22 preserves the input message and attaches snapshot to that message', async () => {
    const response = emptyResponse();
    const engine = fakeEngine(() => response);
    const request = { entities: [{ type: EntityKind.Device, ids: '*' }] };
    const msg: NodeMessageInFlow = {
      _msgid: 'message-1',
      topic: 'entity.updated',
      event: { type: 'entity.updated' },
      unrelated: { retained: true },
      snapshotRequest: request,
    };
    const invocation = invoke(engine, msg);

    await expect(invocation.done).resolves.toBeUndefined();

    expect(invocation.sent).toEqual([msg]);
    expect(invocation.sent[0]).toBe(msg);
    expect(msg).toMatchObject({
      _msgid: 'message-1',
      event: { type: 'entity.updated' },
      unrelated: { retained: true },
      snapshot: response,
    });
    expect(engine.snapshot).toHaveBeenCalledWith(request);
  });

  it('NR-23 requires a dynamic selector request and has no configured fallback', async () => {
    const snapshot = vi.fn(() => emptyResponse());
    const engine = { snapshot } as unknown as Engine;
    const invocation = invoke(engine, { _msgid: 'message-1' });

    await expect(invocation.done).resolves.toBeInstanceOf(SnapshotRequestError);
    expect(invocation.sent).toEqual([]);
    expect(snapshot).not.toHaveBeenCalled();
  });

  it('NR-24 validates and forwards combined entity and diagnostic selectors', async () => {
    const snapshot = vi.fn(() => emptyResponse());
    const engine = { snapshot } as unknown as Engine;
    const request = {
      entities: [
        { type: EntityKind.Device, ids: '*' },
        {
          type: EntityKind.Application,
          ids: 'asset-1/application-1',
          parent: true,
          children: true,
          datafeeds: true,
          statePaths: ['currState', 'hasError'],
        },
      ],
      diagnostics: [{ type: EntityKind.Application, ids: 'asset-1/application-1' }],
    };
    const invocation = invoke(engine, { _msgid: 'message-1', snapshotRequest: request });

    await expect(invocation.done).resolves.toBeUndefined();
    expect(snapshot).toHaveBeenCalledWith(request);
  });

  it('NR-25 attaches a response containing selected entities and diagnostics', async () => {
    const response = emptyResponse();
    const snapshot = vi.fn(() => response);
    const engine = { snapshot } as unknown as Engine;
    const msg: NodeMessageInFlow = {
      _msgid: 'message-1',
      snapshotRequest: {
        entities: [{ type: EntityKind.Datastream, ids: ['device-1/temp1', 'device-1/temp2'] }],
        diagnostics: [{ type: EntityKind.Datastream, ids: 'device-1/temp1' }],
      },
    };
    const invocation = invoke(engine, msg);

    await expect(invocation.done).resolves.toBeUndefined();
    expect(msg['snapshot']).toBe(response);
  });

  it('NR-26 omits unavailable projected state paths without failing', async () => {
    const response = emptyResponse();
    const snapshot = vi.fn(() => response);
    const engine = { snapshot } as unknown as Engine;
    const msg: NodeMessageInFlow = {
      _msgid: 'message-1',
      snapshotRequest: {
        entities: [
          {
            type: EntityKind.Datastream,
            ids: 'device-1/temp1',
            statePaths: ['hasError', 'currState'],
          },
        ],
      },
    };
    const invocation = invoke(engine, msg);

    await expect(invocation.done).resolves.toBeUndefined();
    expect(snapshot).toHaveBeenCalledOnce();
  });

  it.each([
    undefined,
    JSON.stringify({ entities: [{ type: EntityKind.Device, ids: '*' }] }),
    {},
    { entities: [{ type: EntityKind.Device }] },
    { entities: [{ type: '*', ids: 'device-1' }] },
    { entities: [{ type: EntityKind.Device, ids: [], children: 'yes' }] },
    { diagnostics: [{ type: EntityKind.Device, ids: 'device-1', statePaths: ['hasError'] }] },
    { target: { scope: 'all' } },
  ])('NR-27 rejects malformed selector request %j', (request) => {
    expect(() => parseSnapshotRequest(request)).toThrow(SnapshotRequestError);
  });

  it('NR-30 reports unknown selected entities without output', async () => {
    const snapshot = vi.fn(() => {
      throw new SnapshotRequestError('Unknown entity: device:missing');
    });
    const engine = { snapshot } as unknown as Engine;
    const msg: NodeMessageInFlow = {
      _msgid: 'missing',
      snapshotRequest: { entities: [{ type: EntityKind.Device, ids: 'missing' }] },
    };
    const invocation = invoke(engine, msg);

    await expect(invocation.done).resolves.toBeInstanceOf(SnapshotRequestError);
    expect(invocation.sent).toEqual([]);
    expect(msg).not.toHaveProperty('snapshot');
  });

  it('NR-28 uses an explicit request with an engine.ready input message', async () => {
    const response = emptyResponse();
    const snapshot = vi.fn(() => response);
    const engine = { snapshot } as unknown as Engine;
    const request = {
      entities: [
        { type: EntityKind.Device, ids: '*' },
        { type: EntityKind.Datastream, ids: '*' },
        { type: EntityKind.Application, ids: '*' },
        { type: EntityKind.Asset, ids: '*' },
      ],
      diagnostics: [
        { type: 'common' as const, ids: '*' },
        { type: EntityKind.Device, ids: '*' },
        { type: EntityKind.Datastream, ids: '*' },
        { type: EntityKind.Application, ids: '*' },
        { type: EntityKind.Asset, ids: '*' },
      ],
    };
    const msg: NodeMessageInFlow = {
      _msgid: 'ready-message',
      topic: 'engine.ready',
      event: { type: 'engine.ready' },
      snapshotRequest: request,
    };
    const invocation = invoke(engine, msg);

    await expect(invocation.done).resolves.toBeUndefined();
    expect(snapshot).toHaveBeenCalledWith(request);
    expect(msg['snapshot']).toBe(response);
  });
});
