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
import { createUg6xInputHandler, normalizeUg6xInput } from '../src/ug6x-input';

interface Invocation {
  readonly done: Promise<Error | undefined>;
  readonly sent: NodeMessage[];
}

const inputMessage = (overrides: Record<string, unknown> = {}): NodeMessageInFlow => ({
  _msgid: 'message-1',
  deviceName: 'device-1',
  gatewayTime: '2026-08-21T15:19:25+02:00',
  object: { sensorType: 12, temp1: 20, temp2: 30 },
  ...overrides,
});

const fakeNode = () => ({ status: vi.fn() }) as unknown as Node;

const fakeEngineNode = (engine: Engine | undefined, ready?: Promise<Engine>) =>
  ({ engine, ready: ready ?? Promise.resolve(engine as Engine) }) as IndustrialEngineNode;

const invoke = (
  node: Node,
  engineNode: IndustrialEngineNode,
  message: NodeMessageInFlow,
  readinessPolicy: 'reject' | 'queue' = 'reject',
): Invocation => {
  const sent: NodeMessage[] = [];
  const done = new Promise<Error | undefined>((resolve) => {
    createUg6xInputHandler(
      node,
      engineNode,
      readinessPolicy,
      () => 2_000,
    )(
      message,
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

describe('UG6x Input normalization', () => {
  it('NR-07 reads top-level deviceName and ISO gatewayTime', () => {
    const envelope = normalizeUg6xInput(inputMessage(), 2_000);

    expect(envelope.deviceId).toBe('device-1');
    expect(envelope.sourceTimestamp).toBe(Date.parse('2026-08-21T15:19:25+02:00'));
    expect(envelope.issues).toEqual([]);
  });

  it('NR-08 preserves the raw message while normalizing valid time', async () => {
    const ingest = vi.fn<(input: EngineIngestInput) => Promise<boolean>>(() =>
      Promise.resolve(true),
    );
    const engine = { isReady: true, ingest } as unknown as Engine;
    const message = inputMessage();
    const invocation = invoke(fakeNode(), fakeEngineNode(engine), message);

    await expect(invocation.done).resolves.toBeUndefined();

    expect(ingest).toHaveBeenCalledWith(
      expect.objectContaining({
        rawPayload: message,
        receivedTimestamp: 2_000,
        sourceTimestamp: Date.parse('2026-08-21T15:19:25+02:00'),
      }),
    );
    expect(invocation.sent).toEqual([message]);
  });

  it.each([
    ['missing', undefined, 'NO_GATEWAY_TIME'],
    ['invalid', 'not-a-time', 'INVALID_GATEWAY_TIME'],
  ])('NR-09 uses received time and reports %s gateway time', (_case, gatewayTime, issue) => {
    const envelope = normalizeUg6xInput(inputMessage({ gatewayTime }), 2_000);

    expect(envelope.sourceTimestamp).toBe(2_000);
    expect(envelope.issues).toContain(issue);
  });

  it('NR-10 forwards missing device identity for Engine-owned rejection', async () => {
    const ingest = vi.fn<(input: EngineIngestInput) => Promise<boolean>>(() =>
      Promise.resolve(false),
    );
    const engine = { isReady: true, ingest } as unknown as Engine;
    const invocation = invoke(fakeNode(), fakeEngineNode(engine), inputMessage({ deviceName: '' }));

    await expect(invocation.done).resolves.toBeUndefined();

    expect(ingest).toHaveBeenCalledWith(
      expect.objectContaining({ issues: expect.arrayContaining(['NO_DEVICE_NAME']) }),
    );
    expect(ingest.mock.calls[0]?.[0]).not.toHaveProperty('deviceId');
    expect(invocation.sent).toEqual([]);
  });
});

describe('UG6x Input readiness and completion', () => {
  it('NR-11 rejects immediately or queues according to policy', async () => {
    const ingest = vi.fn<(input: EngineIngestInput) => Promise<boolean>>(() =>
      Promise.resolve(true),
    );
    const engine = { isReady: true, ingest } as unknown as Engine;
    let releaseReady!: (engine: Engine) => void;
    const ready = new Promise<Engine>((resolve) => {
      releaseReady = resolve;
    });

    const rejected = invoke(fakeNode(), fakeEngineNode(undefined, ready), inputMessage(), 'reject');
    await expect(rejected.done).resolves.toBeUndefined();
    expect(ingest).not.toHaveBeenCalled();

    const queued = invoke(fakeNode(), fakeEngineNode(undefined, ready), inputMessage(), 'queue');
    let queueCompleted = false;
    void queued.done.then(() => {
      queueCompleted = true;
    });
    await Promise.resolve();
    expect(queueCompleted).toBe(false);
    releaseReady(engine);
    await expect(queued.done).resolves.toBeUndefined();
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
    const queued = invoke(fakeNode(), fakeEngineNode(engine), inputMessage(), 'queue');
    await Promise.resolve();

    listener?.({
      type: 'engine.lifecycle',
      timestamp: 2_000,
      source: { engineId: asEngineId('engine-1') },
      data: { state: 'ready', ready: true, sessionId: 'session-1' },
    });

    await expect(queued.done).resolves.toBeUndefined();
    expect(ingest).toHaveBeenCalledTimes(1);
  });

  it('NR-12 treats rejection as expected and passes unexpected failures to done', async () => {
    const rejectedEngine = {
      isReady: true,
      ingest: vi.fn<(input: EngineIngestInput) => Promise<boolean>>(() => Promise.resolve(false)),
    } as unknown as Engine;
    const rejected = invoke(fakeNode(), fakeEngineNode(rejectedEngine), inputMessage());

    await expect(rejected.done).resolves.toBeUndefined();
    expect(rejected.sent).toEqual([]);

    const failure = new Error('adapter failure');
    const failedEngine = {
      isReady: true,
      ingest: vi.fn<(input: EngineIngestInput) => Promise<boolean>>(() => Promise.reject(failure)),
    } as unknown as Engine;
    const failed = invoke(fakeNode(), fakeEngineNode(failedEngine), inputMessage());

    await expect(failed.done).resolves.toBe(failure);
    expect(failed.sent).toEqual([]);
  });
});
