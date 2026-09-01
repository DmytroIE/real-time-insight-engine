import type { TimerCallback, TimerScheduler } from '../../src';

export class FakeTimerScheduler implements TimerScheduler<number> {
  readonly #callbacks = new Map<
    number,
    { readonly callback: TimerCallback; readonly delayMs: number }
  >();
  #nextHandle = 1;

  public get pendingCount(): number {
    return this.#callbacks.size;
  }

  public get nextDelayMs(): number | undefined {
    return this.#callbacks.values().next().value?.delayMs;
  }

  public setTimeout(callback: TimerCallback, delayMs = 0): number {
    const handle = this.#nextHandle;
    this.#nextHandle += 1;
    this.#callbacks.set(handle, { callback, delayMs });
    return handle;
  }

  public clearTimeout(handle: number): void {
    this.#callbacks.delete(handle);
  }

  public runNext(): void {
    const next = this.#callbacks.entries().next();
    if (next.done) {
      throw new Error('No pending timer');
    }
    const [handle, timer] = next.value;
    this.#callbacks.delete(handle);
    timer.callback();
  }

  public async runNextAsync(): Promise<void> {
    const next = this.#callbacks.entries().next();
    if (next.done) {
      throw new Error('No pending timer');
    }
    const [handle, timer] = next.value;
    this.#callbacks.delete(handle);
    await timer.callback();
  }
}
