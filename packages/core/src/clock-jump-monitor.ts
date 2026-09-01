import type { Clock, TimerScheduler } from './time';

export const DEFAULT_CLOCK_JUMP_THRESHOLD_MS = 60_000;
export const DEFAULT_CLOCK_CHECK_INTERVAL_MS = 1_000;

export interface ClockJump {
  readonly wallElapsedMs: number;
  readonly monotonicElapsedMs: number;
  readonly differenceMs: number;
}

export class ClockJumpMonitor {
  #previousWallMs: number;
  #previousMonotonicMs: number;
  #timer: unknown;
  #started = false;

  public constructor(
    private readonly clock: Clock,
    private readonly timers: TimerScheduler,
    private readonly thresholdMs: number,
    private readonly onJump: (jump: ClockJump) => Promise<void>,
    private readonly checkIntervalMs = DEFAULT_CLOCK_CHECK_INTERVAL_MS,
  ) {
    this.#previousWallMs = clock.wallTimeMs();
    this.#previousMonotonicMs = clock.monotonicTimeMs();
  }

  public start(): void {
    if (this.#started) {
      return;
    }
    this.#started = true;
    this.resetBaseline();
    this.schedule();
  }

  public stop(): void {
    if (!this.#started) {
      return;
    }
    this.#started = false;
    if (this.#timer !== undefined) {
      this.timers.clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }

  public async checkNow(): Promise<boolean> {
    const wallNow = this.clock.wallTimeMs();
    const monotonicNow = this.clock.monotonicTimeMs();
    const jump: ClockJump = {
      wallElapsedMs: wallNow - this.#previousWallMs,
      monotonicElapsedMs: monotonicNow - this.#previousMonotonicMs,
      differenceMs: Math.abs(
        wallNow - this.#previousWallMs - (monotonicNow - this.#previousMonotonicMs),
      ),
    };
    this.#previousWallMs = wallNow;
    this.#previousMonotonicMs = monotonicNow;
    if (jump.differenceMs <= this.thresholdMs) {
      return false;
    }
    await this.onJump(jump);
    this.resetBaseline();
    return true;
  }

  private schedule(): void {
    if (!this.#started || this.#timer !== undefined) {
      return;
    }
    this.#timer = this.timers.setTimeout(async () => {
      this.#timer = undefined;
      try {
        await this.checkNow();
      } catch {
        // The owner records the failed lifecycle; timer callbacks cannot surface rejections.
      } finally {
        this.schedule();
      }
    }, this.checkIntervalMs);
  }

  private resetBaseline(): void {
    this.#previousWallMs = this.clock.wallTimeMs();
    this.#previousMonotonicMs = this.clock.monotonicTimeMs();
  }
}
