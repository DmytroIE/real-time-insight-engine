import { describe, expect, it } from 'vitest';

import {
  EntityKind,
  InMemoryStateStore,
  asDeviceId,
  asEngineId,
  diagnosticStateKey,
  engineSnapshotKey,
  engineStateKeyPrefix,
  entityStateKey,
  type VersionedStateSnapshot,
} from '../src';

interface TestState {
  values: number[];
  nested: { healthy: boolean };
}

describe('STATE-01 in-memory StateStore', () => {
  it('loads, saves, deletes, and lists namespaced keys', async () => {
    const store = new InMemoryStateStore();
    const firstEngineId = asEngineId('engine/one');
    const secondEngineId = asEngineId('engine-two');
    const firstPrefix = engineStateKeyPrefix(firstEngineId);
    const snapshotKey = engineSnapshotKey(firstEngineId);
    const entityKey = entityStateKey(firstEngineId, EntityKind.Device, asDeviceId('device/one'));
    const diagnosticsKey = diagnosticStateKey(firstEngineId);

    await store.save(snapshotKey, { schemaVersion: 1 });
    await store.save(entityKey, { schemaVersion: 1 });
    await store.save(diagnosticsKey, { schemaVersion: 1 });
    await store.save(engineSnapshotKey(secondEngineId), { schemaVersion: 1 });

    expect(await store.keys(firstPrefix)).toEqual([diagnosticsKey, entityKey, snapshotKey].sort());
    expect(entityKey).toContain('engine%2Fone/entity/device/device%2Fone');

    await store.delete(entityKey);
    expect(await store.load(entityKey)).toBeUndefined();
    expect(await store.keys(firstPrefix)).toEqual([diagnosticsKey, snapshotKey].sort());
  });

  it('isolates stored state from both saved and loaded mutable references', async () => {
    const store = new InMemoryStateStore();
    const key = engineSnapshotKey(asEngineId('engine-one'));
    const input: VersionedStateSnapshot<TestState> = {
      schemaVersion: 1,
      state: { values: [1, 2], nested: { healthy: true } },
    };

    await store.save(key, input);
    input.state.values.push(3);
    input.state.nested.healthy = false;

    const firstLoad = await store.load<VersionedStateSnapshot<TestState>>(key);
    expect(firstLoad).toEqual({
      schemaVersion: 1,
      state: { values: [1, 2], nested: { healthy: true } },
    });

    firstLoad?.state.values.push(4);
    if (firstLoad !== undefined) {
      firstLoad.state.nested.healthy = false;
    }

    await expect(store.load(key)).resolves.toEqual({
      schemaVersion: 1,
      state: { values: [1, 2], nested: { healthy: true } },
    });
  });
});
