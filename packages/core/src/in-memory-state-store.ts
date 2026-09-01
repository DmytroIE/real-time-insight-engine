import type { StateStore } from './state-store';

const clone = <Value>(value: Value): Value => structuredClone(value);

export class InMemoryStateStore implements StateStore {
  readonly #values = new Map<string, unknown>();

  public async load<Value>(key: string): Promise<Value | undefined> {
    const value = this.#values.get(key);
    return value === undefined ? undefined : clone(value as Value);
  }

  public async save<Value>(key: string, value: Value): Promise<void> {
    this.#values.set(key, clone(value));
  }

  public async delete(key: string): Promise<void> {
    this.#values.delete(key);
  }

  public async keys(prefix: string): Promise<string[]> {
    return [...this.#values.keys()].filter((key) => key.startsWith(prefix)).sort();
  }
}
