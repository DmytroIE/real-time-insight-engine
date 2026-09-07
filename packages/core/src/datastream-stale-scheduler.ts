import type { DatastreamId } from './identifiers';
import type { Clock, TimerScheduler } from './time';

export const DEFAULT_STALE_SCAN_BATCH_SIZE = 3;
export const DEFAULT_STALE_TASK_RETRY_DELAY_MS = 1_000;

export interface DatastreamStaleTask {
  readonly id: DatastreamId;
  nextStaleCheckTimestamp(): number;
  evaluateStale(): boolean;
}

export interface DatastreamStaleTaskResult {
  readonly task: DatastreamStaleTask;
  readonly error?: unknown;
}

export interface DatastreamStaleSchedulerOptions {
  readonly batchSize?: number;
  readonly failureRetryDelayMs?: number;
}

export class DatastreamStaleScheduler {
  readonly #retryAfter = new Map<DatastreamId, number>();
  readonly #clock: Clock;
  readonly #timers: TimerScheduler;
  readonly #tasks: () => readonly DatastreamStaleTask[];
  readonly #onTaskResult: (result: DatastreamStaleTaskResult) => void;
  readonly #options: DatastreamStaleSchedulerOptions;
  #timer: unknown;
  #started = false;
  #stopped = false;

  public constructor(
    clock: Clock,
    timers: TimerScheduler,
    tasks: () => readonly DatastreamStaleTask[],
    onTaskResult: (result: DatastreamStaleTaskResult) => void = () => undefined,
    options: DatastreamStaleSchedulerOptions = {},
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
    this.runDueAndReschedule();
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

  private runDueAndReschedule(): void {
    this.#timer = undefined;
    if (this.#stopped) {
      return;
    }

    const now = this.#clock.wallTimeMs();
    const due = this.#tasks()
      .filter((task) => this.effectiveDueTimestamp(task) <= now)
      .sort((left, right) => this.effectiveDueTimestamp(left) - this.effectiveDueTimestamp(right))
      .slice(0, this.#options.batchSize ?? DEFAULT_STALE_SCAN_BATCH_SIZE);

    for (const task of due) {
      try {
        task.evaluateStale();
        this.#retryAfter.delete(task.id);
        this.#onTaskResult({ task });
      } catch (error) {
        this.#retryAfter.set(
          task.id,
          now + (this.#options.failureRetryDelayMs ?? DEFAULT_STALE_TASK_RETRY_DELAY_MS),
        );
        this.#onTaskResult({ task, error });
      }
    }

    this.scheduleNext();
  }

  private scheduleNext(): void {
    if (this.#stopped) {
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

  private effectiveDueTimestamp(task: DatastreamStaleTask): number {
    return Math.max(task.nextStaleCheckTimestamp(), this.#retryAfter.get(task.id) ?? 0);
  }
}
