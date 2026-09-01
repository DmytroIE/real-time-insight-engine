export interface Clock {
  wallTimeMs(): number;
  monotonicTimeMs(): number;
}

export type TimerCallback = () => void;

export interface TimerScheduler<Handle = unknown> {
  setTimeout(callback: TimerCallback, delayMs: number): Handle;
  clearTimeout(handle: Handle): void;
}
