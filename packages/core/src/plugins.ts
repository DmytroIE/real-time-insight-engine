import type { DatafeedReference } from './configuration';
import type { ApplicationId, DeviceId, PluginTypeId } from './identifiers';

export type JsonSchema = Readonly<Record<string, unknown>>;
export type PluginStateMigration = (state: unknown) => unknown;

interface PluginManifest<Kind extends PluginKind, Settings> {
  readonly kind: Kind;
  readonly type: PluginTypeId;
  readonly version: number;
  readonly displayName: string;
  readonly settingsSchema: JsonSchema;
  readonly defaultSettings: Settings;
}

export interface DevicePluginManifest<Settings> extends PluginManifest<'device', Settings> {
  readonly datastreams: readonly string[];
}

export interface ApplicationPluginManifest<Settings, State extends object> extends PluginManifest<
  'application',
  Settings
> {
  readonly requiredDatafeeds: readonly string[];
  readonly defaultState: State;
  readonly stateMigrations?: Readonly<Record<number, PluginStateMigration>>;
}

export interface DevicePluginContext<Settings, State> {
  readonly id: DeviceId;
  readonly settings: Settings;
  readonly restoredState?: State;
}

export interface ApplicationPluginContext<Settings, State extends object> {
  readonly id: ApplicationId;
  readonly settings: Settings;
  readonly restoredState?: State;
  readonly datafeeds: Readonly<Record<string, DatafeedReference | string>>;
}

export interface DevicePluginFactory<Settings, State, Instance> {
  create(context: DevicePluginContext<Settings, State>): Instance;
}

export interface ApplicationPluginFactory<Settings, State extends object, Instance> {
  create(context: ApplicationPluginContext<Settings, State>): Instance;
}

export type DevicePlugin<
  Settings = unknown,
  State = unknown,
  Instance = unknown,
> = DevicePluginManifest<Settings> & DevicePluginFactory<Settings, State, Instance>;

export type ApplicationPlugin<
  Settings = unknown,
  State extends object = Record<string, unknown>,
  Instance = unknown,
> = ApplicationPluginManifest<Settings, State> &
  ApplicationPluginFactory<Settings, State, Instance>;

export type PluginKind = 'device' | 'application';
export type InstalledPlugin = DevicePlugin | ApplicationPlugin<unknown, object>;

export class PluginRegistry {
  readonly #plugins = new Map<PluginTypeId, InstalledPlugin>();

  public register(plugin: InstalledPlugin): void {
    if (this.#plugins.has(plugin.type)) {
      throw new Error(`Duplicate plugin type: ${plugin.type}`);
    }

    this.#plugins.set(plugin.type, plugin);
  }

  public resolve(type: PluginTypeId): InstalledPlugin {
    const plugin = this.#plugins.get(type);
    if (plugin === undefined) {
      throw new Error(`Plugin type is not installed: ${type}`);
    }

    return plugin;
  }

  public resolveDevice(type: PluginTypeId): DevicePlugin {
    const plugin = this.resolve(type);
    if (plugin.kind !== 'device') {
      throw new Error(`Plugin type is not a device plugin: ${type}`);
    }

    return plugin;
  }

  public resolveApplication(type: PluginTypeId): ApplicationPlugin<unknown, object> {
    const plugin = this.resolve(type);
    if (plugin.kind !== 'application') {
      throw new Error(`Plugin type is not an application plugin: ${type}`);
    }

    return plugin;
  }

  public has(type: PluginTypeId): boolean {
    return this.#plugins.has(type);
  }
}
