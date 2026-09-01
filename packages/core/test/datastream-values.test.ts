import { describe, expect, it } from 'vitest';

import { DatastreamValueBuffer, MIN_DATASTREAM_BUFFER_LENGTH } from '../src';

const createBuffer = (maxBufferLength = 10, maxBufferAgeMs = 10_000): DatastreamValueBuffer =>
  new DatastreamValueBuffer({ maxBufferLength, maxBufferAgeMs });

describe('DS-01 timestamp ordering', () => {
  it('keeps samples sorted after out-of-order arrival', () => {
    const buffer = createBuffer();

    buffer.upsert({ timestamp: 300, value: 3 }, 300);
    buffer.upsert({ timestamp: 100, value: 1 }, 300);
    buffer.upsert({ timestamp: 200, value: 2 }, 300);

    expect(buffer.values()).toEqual([
      { timestamp: 100, value: 1 },
      { timestamp: 200, value: 2 },
      { timestamp: 300, value: 3 },
    ]);
  });
});

describe('DS-02 duplicate timestamp replacement', () => {
  it('replaces the existing sample without increasing buffer length', () => {
    const buffer = createBuffer();
    buffer.upsert({ timestamp: 100, value: 1 }, 100);

    buffer.upsert({ timestamp: 100, value: 9 }, 200);

    expect(buffer.values()).toEqual([{ timestamp: 100, value: 9 }]);
  });
});

describe('DS-03 age and length pruning', () => {
  it('keeps the configured minimum practical length and removes old samples', () => {
    const buffer = createBuffer(1, 100);
    expect(MIN_DATASTREAM_BUFFER_LENGTH).toBe(2);

    buffer.upsert({ timestamp: 850, value: 1 }, 850);
    buffer.upsert({ timestamp: 900, value: 2 }, 900);
    buffer.upsert({ timestamp: 950, value: 3 }, 950);
    expect(buffer.values()).toEqual([
      { timestamp: 900, value: 2 },
      { timestamp: 950, value: 3 },
    ]);

    buffer.prune(1_025);
    expect(buffer.values()).toEqual([{ timestamp: 950, value: 3 }]);
  });

  it('length-bounds restored samples immediately', () => {
    const buffer = new DatastreamValueBuffer({ maxBufferLength: 2, maxBufferAgeMs: 100 }, [
      { timestamp: 100, value: 1 },
      { timestamp: 300, value: 3 },
      { timestamp: 200, value: 2 },
    ]);

    expect(buffer.values()).toEqual([
      { timestamp: 200, value: 2 },
      { timestamp: 300, value: 3 },
    ]);
  });
});

describe('DS-04 value queries', () => {
  it('returns inclusive ranges, last values, averages, and null for empty ranges', () => {
    const buffer = createBuffer();
    buffer.upsert({ timestamp: 100, value: 2 }, 100);
    buffer.upsert({ timestamp: 200, value: 4 }, 200);
    buffer.upsert({ timestamp: 300, value: 9 }, 300);

    expect(buffer.values({ startTimestamp: 100, endTimestamp: 200 })).toEqual([
      { timestamp: 100, value: 2 },
      { timestamp: 200, value: 4 },
    ]);
    expect(buffer.lastValue({ startTimestamp: 100, endTimestamp: 200 })).toEqual({
      timestamp: 200,
      value: 4,
    });
    expect(buffer.averageValue({ startTimestamp: 100, endTimestamp: 200 })).toEqual({
      timestamp: 200,
      value: 3,
    });
    expect(buffer.lastValue({ startTimestamp: 400 })).toBeNull();
    expect(buffer.averageValue({ startTimestamp: 400 })).toBeNull();
  });

  it('does not expose mutable stored samples', () => {
    const buffer = createBuffer();
    const sample = { timestamp: 100, value: 2 };
    buffer.upsert(sample, 100);

    const values = buffer.values() as { timestamp: number; value: number }[];
    const firstValue = values[0];
    if (firstValue !== undefined) {
      firstValue.value = 99;
    }

    expect(buffer.values()).toEqual([{ timestamp: 100, value: 2 }]);
  });
});
