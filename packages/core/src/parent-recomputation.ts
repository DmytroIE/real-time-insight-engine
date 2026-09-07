import type { TimerScheduler } from './time';

export const DEFAULT_PARENT_RECOMPUTATION_DELAY_MS = 1_000;

export interface ParentRecomputationRequester {
  requestRecompute(): void;
}

export class ParentRecomputationController implements ParentRecomputationRequester {
  readonly #timers: TimerScheduler;
  readonly #recompute: () => void;
  readonly #delayMs: number;
  #timer: unknown;
  #dirty = false;
  #running = false;
  #closed = false;

  public constructor(
    timers: TimerScheduler,
    recompute: () => void,
    delayMs = DEFAULT_PARENT_RECOMPUTATION_DELAY_MS,
  ) {
    this.#timers = timers;
    this.#recompute = recompute;
    this.#delayMs = delayMs;
  }

  public requestRecompute(): void {
    if (this.#closed) {
      return;
    }

    this.#dirty = true;
    if (this.#running || this.#timer !== undefined) {
      return;
    }
    this.schedule();
  }

  public recomputeNow(): void {
    if (this.#closed) {
      return;
    }

    this.cancelTimer();
    this.#dirty = false;
    this.run();
  }

  public flushAndClose(): void {
    if (this.#closed) {
      return;
    }

    this.cancelTimer();
    this.#dirty = false;
    this.#closed = true;
    this.run();
  }

  private schedule(): void {
    this.#timer = this.#timers.setTimeout(() => {
      this.#timer = undefined;
      if (this.#closed || !this.#dirty) {
        return;
      }
      this.#dirty = false;
      this.run();
    }, this.#delayMs);
  }

  private run(): void {
    this.#running = true;
    try {
      this.#recompute();
    } finally {
      this.#running = false;
      if (!this.#closed && this.#dirty && this.#timer === undefined) {
        this.schedule();
      }
    }
  }

  private cancelTimer(): void {
    if (this.#timer === undefined) {
      return;
    }
    this.#timers.clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}
