import type { StateStore } from '@sxs/industrial-core';
import type { NodeContextData } from 'node-red';

export const DEFAULT_CONTEXT_STORE = 'ieps';

const contextStoreError = (storeName: string, error: unknown): Error =>
  new Error(
    `Node-RED context store "${storeName}" is unavailable: ${
      error instanceof Error ? error.message : String(error)
    }`,
    { cause: error },
  );

export class NodeRedContextStateStore implements StateStore {
  public constructor(
    private readonly context: NodeContextData,
    private readonly storeName = DEFAULT_CONTEXT_STORE,
  ) {}

  public load<Value>(key: string): Promise<Value | undefined> {
    return new Promise((resolve, reject) => {
      this.context.get(key, this.storeName, (error, value) => {
        if (error) {
          reject(contextStoreError(this.storeName, error));
          return;
        }
        resolve(value as Value | undefined);
      });
    });
  }

  public save<Value>(key: string, value: Value): Promise<void> {
    return this.set(key, value);
  }

  public delete(key: string): Promise<void> {
    return this.set(key, undefined);
  }

  public keys(prefix: string): Promise<string[]> {
    return new Promise((resolve, reject) => {
      this.context.keys(this.storeName, (error, values) => {
        if (error) {
          reject(contextStoreError(this.storeName, error));
          return;
        }
        resolve(
          values.filter(
            (value): value is string => typeof value === 'string' && value.startsWith(prefix),
          ),
        );
      });
    });
  }

  private set(key: string, value: unknown): Promise<void> {
    return new Promise((resolve, reject) => {
      this.context.set(key, value, this.storeName, (error) => {
        if (error) {
          reject(contextStoreError(this.storeName, error));
          return;
        }
        resolve();
      });
    });
  }
}
