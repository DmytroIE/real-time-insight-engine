import { describe, expect, it, vi } from 'vitest';

import {
  asEngineId,
  type Engine,
  type EngineIngestInput,
  type EngineLifecycleEvent,
  type Unsubscribe,
} from '@sxs/industrial-core';
import type { Node, NodeMessage, NodeMessageInFlow } from 'node-red';

import type { IndustrialEngineNode } from '../src/industrial-engine';
import { createEngineInputHandler, normalizeEngineInput } from '../src/engine-input';

const inputMessage = (overrides: Record<string, unknown> = {}): NodeMessageInFlow => ({
  _msgid: 'message-1',
  payload: {
    deviceName: 'device-1',
    rawPayload: { sensorType: 12, temp1: 20, temp2: 30 },
    timestamp: 2_000,
  },
  ...overrides,
});

const fakeNode = () => ({ status: vi.fn() }) as unknown as Node;

const fakeEngineNode = (engine: Engine | undefined, ready?: Promise<Engine>) =>
  ({ engine, ready: ready ?? Promise.resolve(engine as Engine) }) as IndustrialEngineNode;

interface Invocation {
  readonly done: Promise<Error | undefined>;
  readonly send: ReturnType<typeof vi.fn>;
}

const invoke = (
  node: Node,
  engineNode: IndustrialEngineNode,
  message: NodeMessageInFlow,
  readinessPolicy: 'reject' | 'queue' = 'reject',
): Invocation => {
  const send = vi.fn<(message: NodeMessage | Array<NodeMessage | NodeMessage[] | null>) => void>();
  const done = new Promise<Error | undefined>((resolve) => {
    createEngineInputHandler(node, engineNode, readinessPolicy)(message, send, resolve);
  });
  return { done, send };
};

describe('Engine Input normalization', () => {
  it('NR-07 validates and normalizes the standard payload contract', () => {
    expect(normalizeEngineInput(inputMessage())).toEqual({
      deviceName: 'device-1',
      rawPayload: { sensorType: 12, temp1: 20, temp2: 30 },
      timestamp: 2_000,
      source: 'engine-input',
      issues: [],
    });
  });

  it.each([
    ['missing payload', undefined, ['INVALID_RAW_PAYLOAD']],
    [
      'invalid fields',
      { deviceName: '', rawPayload: [], timestamp: 'not-a-timestamp' },
      ['INVALID_DEVICE_NAME', 'INVALID_RAW_PAYLOAD', 'INVALID_TIMESTAMP'],
    ],
  ])('NR-08 collects shape issues for a %s', (_case, payload, issues) => {
    expect(normalizeEngineInput(inputMessage({ payload }))).toMatchObject({ issues });
  });

  it('rejects a fractional timestamp', () => {
    expect(
      normalizeEngineInput(
        inputMessage({
          payload: { deviceName: 'device-1', rawPayload: {}, timestamp: 1_000.5 },
        }),
      ),
    ).toMatchObject({ issues: ['INVALID_TIMESTAMP'] });
  });

  it('NR-09 sends the normalized payload to the Engine without forwarding the message', async () => {
    const ingest = vi.fn<(input: EngineIngestInput) => Promise<boolean>>(() =>
      Promise.resolve(true),
    );
    const engine = { isReady: true, ingest } as unknown as Engine;

    const invocation = invoke(fakeNode(), fakeEngineNode(engine), inputMessage());
    await expect(invocation.done).resolves.toBeUndefined();
    expect(ingest).toHaveBeenCalledWith({
      deviceName: 'device-1',
      rawPayload: { sensorType: 12, temp1: 20, temp2: 30 },
      timestamp: 2_000,
      source: 'engine-input',
      issues: [],
    });
    expect(invocation.send).not.toHaveBeenCalled();
  });
});

describe('Engine Input readiness and completion', () => {
  it('NR-10 rejects immediately or queues according to policy', async () => {
    const ingest = vi.fn<(input: EngineIngestInput) => Promise<boolean>>(() =>
      Promise.resolve(true),
    );
    const engine = { isReady: true, ingest } as unknown as Engine;
    let releaseReady!: (engine: Engine) => void;
    const ready = new Promise<Engine>((resolve) => {
      releaseReady = resolve;
    });

    await expect(
      invoke(fakeNode(), fakeEngineNode(undefined, ready), inputMessage(), 'reject').done,
    ).resolves.toBeUndefined();
    expect(ingest).not.toHaveBeenCalled();

    const queued = invoke(
      fakeNode(),
      fakeEngineNode(undefined, ready),
      inputMessage(),
      'queue',
    ).done;
    let queueCompleted = false;
    void queued.then(() => {
      queueCompleted = true;
    });
    await Promise.resolve();
    expect(queueCompleted).toBe(false);
    releaseReady(engine);
    await expect(queued).resolves.toBeUndefined();
    expect(ingest).toHaveBeenCalledTimes(1);
  });

  it('queues across a temporary reset until lifecycle becomes ready', async () => {
    let listener: ((event: EngineLifecycleEvent) => void) | undefined;
    const ingest = vi.fn<(input: EngineIngestInput) => Promise<boolean>>(() =>
      Promise.resolve(true),
    );
    const engine = {
      isReady: false,
      ingest,
      subscribe: vi.fn(
        (_pattern: string, next: (event: EngineLifecycleEvent) => void): Unsubscribe => {
          listener = next;
          return vi.fn();
        },
      ),
    } as unknown as Engine;
    const queued = invoke(fakeNode(), fakeEngineNode(engine), inputMessage(), 'queue').done;
    await Promise.resolve();

    listener?.({
      type: 'engine.lifecycle',
      timestamp: 2_000,
      source: { engineId: asEngineId('engine-1') },
      data: {
        state: 'ready',
        ready: true,
        sessionId: 'session-1',
        sessionStartTimestamp: 2_000,
        cleanSession: false,
      },
    });

    await expect(queued).resolves.toBeUndefined();
    expect(ingest).toHaveBeenCalledTimes(1);
  });

  it('NR-11 treats Engine rejection as expected and passes unexpected failures to done', async () => {
    const rejectedEngine = {
      isReady: true,
      ingest: vi.fn<(input: EngineIngestInput) => Promise<boolean>>(() => Promise.resolve(false)),
    } as unknown as Engine;
    await expect(
      invoke(fakeNode(), fakeEngineNode(rejectedEngine), inputMessage()).done,
    ).resolves.toBeUndefined();

    const failure = new Error('adapter failure');
    const failedEngine = {
      isReady: true,
      ingest: vi.fn<(input: EngineIngestInput) => Promise<boolean>>(() => Promise.reject(failure)),
    } as unknown as Engine;
    await expect(
      invoke(fakeNode(), fakeEngineNode(failedEngine), inputMessage()).done,
    ).resolves.toBe(failure);
  });
});
