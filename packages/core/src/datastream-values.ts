export const MIN_DATASTREAM_BUFFER_LENGTH = 2;

export interface DatastreamSample {
  readonly timestamp: number;
  readonly value: number;
}

export interface DatastreamValueBufferOptions {
  readonly maxBufferLength: number;
  readonly maxBufferAgeMs: number;
}

export interface DatastreamValueRange {
  readonly startTimestamp?: number;
  readonly endTimestamp?: number;
}

const cloneSample = (sample: DatastreamSample): DatastreamSample => ({ ...sample });

export class DatastreamValueBuffer {
  readonly #maxBufferLength: number;
  readonly #maxBufferAgeMs: number;
  #samples: DatastreamSample[];

  public constructor(
    options: DatastreamValueBufferOptions,
    initialSamples: readonly DatastreamSample[] = [],
  ) {
    this.#maxBufferLength = Math.max(
      MIN_DATASTREAM_BUFFER_LENGTH,
      Math.trunc(options.maxBufferLength),
    );
    this.#maxBufferAgeMs = options.maxBufferAgeMs;
    this.#samples = [];
    for (const sample of initialSamples) {
      this.insertOrReplace(sample);
    }
    this.pruneLength();
  }

  public upsert(sample: DatastreamSample, nowTimestamp: number): void {
    this.insertOrReplace(sample);
    this.prune(nowTimestamp);
  }

  public prune(nowTimestamp: number): void {
    const cutoffTimestamp = nowTimestamp - this.#maxBufferAgeMs;
    this.#samples = this.#samples.filter((sample) => sample.timestamp >= cutoffTimestamp);
    this.pruneLength();
  }

  private pruneLength(): void {
    if (this.#samples.length > this.#maxBufferLength) {
      this.#samples.splice(0, this.#samples.length - this.#maxBufferLength);
    }
  }

  public values(range: DatastreamValueRange = {}): readonly DatastreamSample[] {
    const startTimestamp = range.startTimestamp ?? Number.NEGATIVE_INFINITY;
    const endTimestamp = range.endTimestamp ?? Number.POSITIVE_INFINITY;
    return this.#samples
      .filter((sample) => sample.timestamp >= startTimestamp && sample.timestamp <= endTimestamp)
      .map(cloneSample);
  }

  public lastValue(range: DatastreamValueRange = {}): DatastreamSample | null {
    const values = this.values(range);
    const last = values.at(-1);
    return last === undefined ? null : cloneSample(last);
  }

  public averageValue(range: DatastreamValueRange = {}): DatastreamSample | null {
    const values = this.values(range);
    const last = values.at(-1);
    if (last === undefined) {
      return null;
    }

    const total = values.reduce((sum, sample) => sum + sample.value, 0);
    return { timestamp: last.timestamp, value: total / values.length };
  }

  private insertOrReplace(sample: DatastreamSample): void {
    const index = this.#samples.findIndex((existing) => existing.timestamp >= sample.timestamp);
    if (index === -1) {
      this.#samples.push(cloneSample(sample));
    } else if (this.#samples[index]?.timestamp === sample.timestamp) {
      this.#samples[index] = cloneSample(sample);
    } else {
      this.#samples.splice(index, 0, cloneSample(sample));
    }
  }
}
