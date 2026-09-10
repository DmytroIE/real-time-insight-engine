import type { ApplicationRunOutcome } from './application';
import type { ApplicationId } from './identifiers';
import type { Clock, TimerScheduler } from './time';

export const DEFAULT_APPLICATION_SCAN_BATCH_SIZE = 3;
export const DEFAULT_APPLICATION_TASK_RETRY_DELAY_MS = 1_000;

export interface ApplicationTask {
  readonly id: ApplicationId;
  nextApplicationRunTimestamp(): number;
  runIfDue(): Promise<ApplicationRunOutcome>;
}

export interface ApplicationTaskResult {
  readonly task: ApplicationTask;
  readonly outcome?: ApplicationRunOutcome;
  readonly error?: unknown;
}

export interface ApplicationSchedulerOptions {
  readonly batchSize?: number;
  readonly failureRetryDelayMs?: number;
}

export class ApplicationScheduler {
  readonly #retryAfter = new Map<ApplicationId, number>();
  readonly #clock: Clock;
  readonly #timers: TimerScheduler;
  readonly #tasks: () => readonly ApplicationTask[];
  readonly #onTaskResult: (result: ApplicationTaskResult) => void;
  readonly #options: ApplicationSchedulerOptions;
  #timer: unknown;
  #started = false;
  #stopped = false;
  #running = false;
  #runPromise: Promise<void> | undefined;

  public constructor(
    clock: Clock,
    timers: TimerScheduler,
    tasks: () => readonly ApplicationTask[],
    onTaskResult: (result: ApplicationTaskResult) => void = () => undefined,
    options: ApplicationSchedulerOptions = {},
  ) {
    this.#clock = clock;
    this.#timers = timers;
    this.#tasks = tasks;
    this.#onTaskResult = onTaskResult;
    this.#options = options;
  }

  public start(): void {
    if (this.#started) {
      return;
    }
    this.#stopped = false;
    this.#started = true;
    this.scheduleNext();
  }

  public stop(): void {
    if (this.#stopped) {
      return;
    }
    this.#stopped = true;
    this.#started = false;
    if (this.#timer !== undefined) {
      this.#timers.clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    this.#retryAfter.clear();
  }

  public async drain(): Promise<void> {
    await this.#runPromise;
  }

  private runDueAndReschedule(): Promise<void> {
    this.#timer = undefined;
    if (this.#stopped || this.#running) {
      return Promise.resolve();
    }
    const run = this.runDueTasks();
    this.#runPromise = run;
    return run;
  }

  private async runDueTasks(): Promise<void> {
    this.#running = true;
    try {
      const now = this.#clock.wallTimeMs();
      const due = this.#tasks()
        .filter((task) => this.effectiveDueTimestamp(task) <= now)
        .sort((left, right) => this.effectiveDueTimestamp(left) - this.effectiveDueTimestamp(right))
        .slice(0, this.#options.batchSize ?? DEFAULT_APPLICATION_SCAN_BATCH_SIZE);

      for (const task of due) {
        try {
          const outcome = await task.runIfDue();
          if (outcome === 'skipped-overlap') {
            this.deferRetry(task, now);
          } else {
            this.#retryAfter.delete(task.id);
          }
          this.notify({ task, outcome });
        } catch (error) {
          this.deferRetry(task, now);
          this.notify({ task, error });
        }
      }
    } finally {
      this.#running = false;
      this.#runPromise = undefined;
      this.scheduleNext();
    }
  }

  private scheduleNext(): void {
    if (this.#stopped || this.#running || this.#timer !== undefined) {
      return;
    }
    const tasks = this.#tasks();
    if (tasks.length === 0) {
      return;
    }
    const nextDue = Math.min(...tasks.map((task) => this.effectiveDueTimestamp(task)));
    const delayMs = Math.max(0, nextDue - this.#clock.wallTimeMs());
    this.#timer = this.#timers.setTimeout(() => this.runDueAndReschedule(), delayMs);
  }

  private effectiveDueTimestamp(task: ApplicationTask): number {
    return Math.max(task.nextApplicationRunTimestamp(), this.#retryAfter.get(task.id) ?? 0);
  }

  private deferRetry(task: ApplicationTask, now: number): void {
    this.#retryAfter.set(
      task.id,
      now + (this.#options.failureRetryDelayMs ?? DEFAULT_APPLICATION_TASK_RETRY_DELAY_MS),
    );
  }

  private notify(result: ApplicationTaskResult): void {
    try {
      this.#onTaskResult(result);
    } catch {
      // Reporting failures must not stop scheduler progress.
    }
  }
}
