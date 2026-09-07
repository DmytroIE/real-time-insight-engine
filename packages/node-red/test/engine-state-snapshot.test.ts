import { describe, expect, it, vi } from 'vitest';

import {
  asApplicationId,
  EntityKind,
  SnapshotPathError,
  SnapshotRequestError,
  type Engine,
  type EngineSnapshotResponse,
  type MissingStatePath,
  type SnapshotRequest,
} from '@sxs/industrial-core';
import type { Node, NodeMessage, NodeMessageInFlow } from 'node-red';

import {
  createEngineStateSnapshotHandler,
  type EngineStateSnapshotNodeConfiguration,
} from '../src/engine-state-snapshot';
import type { IndustrialEngineNode } from '../src/industrial-engine';

interface Invocation {
  readonly done: Promise<Error | undefined>;
  readonly sent: NodeMessage[];
}

const emptyResponse = (): EngineSnapshotResponse => ({
  entities: { device: {}, datastream: {}, application: {}, asset: {} },
  diagnostics: { common: {}, device: {}, datastream: {}, application: {}, asset: {} },
  missingPaths: [],
});
const testNode = () => ({ status: vi.fn() }) as unknown as Pick<Node, 'status'>;
const engineNode = (engine: Engine): IndustrialEngineNode =>
  ({ engine, ready: Promise.resolve(engine) }) as IndustrialEngineNode;

const invoke = (
  engine: Engine,
  configuredRequest: EngineStateSnapshotNodeConfiguration['snapshotRequest'],
  msg: NodeMessageInFlow,
): Invocation => {
  const sent: NodeMessage[] = [];
  const done = new Promise<Error | undefined>((resolve) => {
    createEngineStateSnapshotHandler(testNode(), engineNode(engine), configuredRequest)(
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

const fakeEngine = (
  snapshot: (request: SnapshotRequest, eventSource?: unknown) => EngineSnapshotResponse,
): Engine => ({ snapshot: vi.fn(snapshot) }) as unknown as Engine;

describe('Engine State Snapshot', () => {
  it('NR-22 preserves the input message and attaches snapshot to that message', async () => {
    const response = emptyResponse();
    const engine = fakeEngine(() => response);
    const msg: NodeMessageInFlow = {
      _msgid: 'message-1',
      topic: 'engine.ready',
      event: { type: 'engine.ready' },
      unrelated: { retained: true },
    };
    const invocation = invoke(engine, { target: { scope: 'all' } }, msg);

    await expect(invocation.done).resolves.toBeUndefined();

    expect(invocation.sent).toEqual([msg]);
    expect(invocation.sent[0]).toBe(msg);
    expect(msg).toMatchObject({
      _msgid: 'message-1',
      event: { type: 'engine.ready' },
      unrelated: { retained: true },
      snapshot: response,
    });
  });

  it('NR-23 uses a configured request without dynamic message input', async () => {
    const snapshot = vi.fn(() => emptyResponse());
    const engine = { snapshot } as unknown as Engine;
    const configured = JSON.stringify({
      target: {
        scope: 'entities',
        entityType: EntityKind.Device,
        entityId: 'device-1',
      },
      relations: 'children',
    });
    const invocation = invoke(engine, configured, { _msgid: 'message-1' });

    await expect(invocation.done).resolves.toBeUndefined();
    expect(snapshot).toHaveBeenCalledWith(
      {
        target: {
          scope: 'entities',
          entityType: EntityKind.Device,
          entityId: 'device-1',
        },
        relations: 'children',
      },
      undefined,
    );
  });

  it('NR-24 lets a valid dynamic request override configured defaults', async () => {
    const snapshot = vi.fn(() => emptyResponse());
    const engine = { snapshot } as unknown as Engine;
    const dynamicRequest = { target: { scope: 'eventSource' as const } };
    const msg: NodeMessageInFlow = {
      _msgid: 'message-1',
      snapshotRequest: dynamicRequest,
      event: {
        source: {
          engineId: 'engine-1',
          entityType: EntityKind.Application,
          entityId: 'asset-1/application-1',
          pluginType: 'sxs.test-application',
        },
      },
    };
    const invocation = invoke(engine, { target: { scope: 'all' } }, msg);

    await expect(invocation.done).resolves.toBeUndefined();
    expect(snapshot).toHaveBeenCalledWith(dynamicRequest, {
      engineId: 'engine-1',
      entityType: EntityKind.Application,
      entityId: 'asset-1/application-1',
      pluginType: 'sxs.test-application',
    });
  });

  it.each([
    [{ scope: 'entities', entityType: EntityKind.Asset, entityId: 'asset-1' }, 'self'],
    [{ scope: 'entities', entityType: EntityKind.Device, entityId: 'device-1' }, 'family'],
    [{ scope: 'all' }, undefined],
  ] as const)('NR-25 forwards %s targets and attaches their result', async (target, relations) => {
    const response = emptyResponse();
    const snapshot = vi.fn(() => response);
    const engine = { snapshot } as unknown as Engine;
    const request = { target, ...(relations === undefined ? {} : { relations }) };
    const msg: NodeMessageInFlow = { _msgid: 'message-1' };
    const invocation = invoke(engine, request, msg);

    await expect(invocation.done).resolves.toBeUndefined();
    expect(snapshot).toHaveBeenCalledWith(request, undefined);
    expect(msg['snapshot']).toBe(response);
  });

  it('NR-26 reports non-strict missing paths and fails strict requests atomically', async () => {
    const missingPaths: readonly MissingStatePath[] = [
      {
        entity: {
          kind: EntityKind.Application,
          id: asApplicationId('asset-1/application-1'),
        },
        path: 'pluginState.missing',
      },
    ];
    const snapshot = vi.fn((request: SnapshotRequest): EngineSnapshotResponse => {
      if (request.strictPaths) {
        throw new SnapshotPathError(missingPaths);
      }
      return {
        entities: { device: {}, datastream: {}, application: {}, asset: {} },
        diagnostics: { common: {}, device: {}, datastream: {}, application: {}, asset: {} },
        missingPaths,
      };
    });
    const engine = { snapshot } as unknown as Engine;
    const nonStrictMessage: NodeMessageInFlow = { _msgid: 'non-strict' };
    const nonStrict = invoke(
      engine,
      { target: { scope: 'all' }, statePaths: ['pluginState.missing'] },
      nonStrictMessage,
    );

    await expect(nonStrict.done).resolves.toBeUndefined();
    expect(nonStrictMessage['snapshot']).toEqual({
      entities: { device: {}, datastream: {}, application: {}, asset: {} },
      diagnostics: { common: {}, device: {}, datastream: {}, application: {}, asset: {} },
      missingPaths,
    });

    const strictMessage: NodeMessageInFlow = { _msgid: 'strict' };
    const strict = invoke(
      engine,
      {
        target: { scope: 'all' },
        statePaths: ['pluginState.missing'],
        strictPaths: true,
      },
      strictMessage,
    );
    await expect(strict.done).resolves.toBeInstanceOf(SnapshotPathError);
    expect(strict.sent).toEqual([]);
    expect(strictMessage).not.toHaveProperty('snapshot');
  });

  it('NR-27 rejects missing entities and malformed requests without partial output', async () => {
    const snapshot = vi.fn((): EngineSnapshotResponse => {
      throw new SnapshotRequestError('Unknown entity: device:missing');
    });
    const engine = { snapshot } as unknown as Engine;
    const missingMessage: NodeMessageInFlow = { _msgid: 'missing', untouched: true };
    const missing = invoke(
      engine,
      {
        target: { scope: 'entities', entityType: EntityKind.Device, entityId: 'missing' },
      },
      missingMessage,
    );

    await expect(missing.done).resolves.toBeInstanceOf(SnapshotRequestError);
    expect(missing.sent).toEqual([]);
    expect(missingMessage).toEqual({ _msgid: 'missing', untouched: true });

    const malformedMessage: NodeMessageInFlow = {
      _msgid: 'malformed',
      snapshotRequest: { target: { scope: 'invalid' } },
    };
    const malformed = invoke(engine, { target: { scope: 'all' } }, malformedMessage);
    await expect(malformed.done).resolves.toBeInstanceOf(SnapshotRequestError);
    expect(malformed.sent).toEqual([]);
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(malformedMessage).not.toHaveProperty('snapshot');
  });

  it('NR-30 supports diagnostics filters and rejects an entityId without entityType', async () => {
    const snapshot = vi.fn(() => emptyResponse());
    const engine = { snapshot } as unknown as Engine;
    const diagnosticRequest = {
      target: {
        scope: 'diagnostics' as const,
        entityType: EntityKind.Datastream,
        entityId: 'device-1/temp1',
      },
    };
    const valid = invoke(
      engine,
      { target: { scope: 'all' } },
      {
        _msgid: 'diagnostics',
        snapshotRequest: diagnosticRequest,
      },
    );

    await expect(valid.done).resolves.toBeUndefined();
    expect(snapshot).toHaveBeenCalledWith(diagnosticRequest, undefined);

    const invalid = invoke(
      engine,
      { target: { scope: 'all' } },
      {
        _msgid: 'missing-type',
        snapshotRequest: { target: { scope: 'entities', entityId: 'device-1' } },
      },
    );
    await expect(invalid.done).resolves.toBeInstanceOf(SnapshotRequestError);
    expect(invalid.sent).toEqual([]);
  });

  it('NR-28 uses engine.ready to trigger a whole-Engine initialization snapshot', async () => {
    const response = emptyResponse();
    const snapshot = vi.fn(() => response);
    const engine = { snapshot } as unknown as Engine;
    const msg: NodeMessageInFlow = {
      _msgid: 'ready-message',
      topic: 'engine.ready',
      event: {
        type: 'engine.ready',
        source: { engineId: 'engine-1' },
        data: { ready: true, sessionId: 'session-1' },
      },
    };
    const invocation = invoke(engine, { target: { scope: 'all' } }, msg);

    await expect(invocation.done).resolves.toBeUndefined();
    expect(snapshot).toHaveBeenCalledWith({ target: { scope: 'all' } }, undefined);
    expect(invocation.sent[0]?.['snapshot']).toBe(response);
  });
});
