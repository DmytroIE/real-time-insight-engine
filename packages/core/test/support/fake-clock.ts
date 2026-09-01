import type { Clock } from '../../src';

export class FakeClock implements Clock {
  public constructor(
    private wallMs = 0,
    private monotonicMs = 0,
  ) {}

  public wallTimeMs(): number {
    return this.wallMs;
  }

  public monotonicTimeMs(): number {
    return this.monotonicMs;
  }

  public advanceWallBy(deltaMs: number): void {
    this.wallMs += deltaMs;
  }

  public advanceMonotonicBy(deltaMs: number): void {
    this.monotonicMs += deltaMs;
  }

  public advanceBy(deltaMs: number): void {
    this.advanceWallBy(deltaMs);
    this.advanceMonotonicBy(deltaMs);
  }
}
