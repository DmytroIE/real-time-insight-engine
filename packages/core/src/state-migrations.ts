import { applicationConfigurationEntries, type EngineConfiguration } from './configuration';
import { applicationIdForNames } from './identifiers';
import type { DiagnosticRetention } from './diagnostics';
import { ProcessState } from './model';
import type { PluginRegistry } from './plugins';
import {
  ENGINE_SNAPSHOT_SCHEMA_VERSION,
  type EngineSnapshotMigration,
  type PersistedEngineSnapshot,
} from './state-store';

export const PERSISTED_STATE_RECOVERY_DIAGNOSTIC = 'PERSISTED_STATE_RECOVERY';

export class StateMigrationError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'StateMigrationError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const isTimestamp = (value: unknown): value is number => Number.isSafeInteger(value);

const isProcessState = (value: unknown): value is ProcessState =>
  Number.isInteger(value) &&
  Number(value) >= ProcessState.Undefined &&
  Number(value) <= ProcessState.Error;

const recordValuesMatch = (
  value: unknown,
  predicate: (entry: unknown) => boolean,
): value is Record<string, unknown> => isRecord(value) && Object.values(value).every(predicate);

const isDeviceState = (value: unknown): boolean =>
  isRecord(value) &&
  isTimestamp(value['lastUpdateTimestamp']) &&
  typeof value['hwError'] === 'boolean';

const isDatastreamState = (value: unknown): boolean =>
  isRecord(value) &&
  isTimestamp(value['lastUpdateTimestamp']) &&
  isTimestamp(value['nextUpdateTimestamp']) &&
  typeof value['noDataError'] === 'boolean' &&
  typeof value['hwError'] === 'boolean' &&
  Array.isArray(value['samples']) &&
  value['samples'].every(
    (sample) =>
      isRecord(sample) && isTimestamp(sample['timestamp']) && isFiniteNumber(sample['value']),
  );

const isAssetState = (value: unknown): boolean =>
  isRecord(value) &&
  isTimestamp(value['lastUpdateTimestamp']) &&
  isProcessState(value['currState']);

const isApplicationState = (value: unknown): boolean =>
  isRecord(value) &&
  isTimestamp(value['lastRunTimestamp']) &&
  isTimestamp(value['nextRunTimestamp']) &&
  (value['lastUpdateTimestamp'] === undefined || isTimestamp(value['lastUpdateTimestamp'])) &&
  isProcessState(value['currState']) &&
  typeof value['noDataError'] === 'boolean' &&
  typeof value['appError'] === 'boolean' &&
  isRecord(value['pluginState']);

const diagnosticRetentions: readonly DiagnosticRetention[] = ['condition', 'session'];

const isDiagnostic = (value: unknown): boolean =>
  isRecord(value) &&
  typeof value['category'] === 'string' &&
  typeof value['sourceId'] === 'string' &&
  typeof value['ownerScope'] === 'string' &&
  typeof value['code'] === 'string' &&
  typeof value['severity'] === 'string' &&
  typeof value['message'] === 'string' &&
  diagnosticRetentions.includes(value['retention'] as DiagnosticRetention) &&
  isRecord(value['source']) &&
  typeof value['source']['engineId'] === 'string' &&
  isTimestamp(value['firstRaisedTs']) &&
  isTimestamp(value['lastUpdatedTs']) &&
  isTimestamp(value['lastObservedTs']) &&
  Number.isInteger(value['occurrenceCount']);

const validateSnapshot = (value: unknown): PersistedEngineSnapshot => {
  if (!isRecord(value) || value['schemaVersion'] !== ENGINE_SNAPSHOT_SCHEMA_VERSION) {
    throw new StateMigrationError('Persisted Engine snapshot has an invalid schema version');
  }
  const states = value['entityStates'];
  const versions = value['pluginVersions'];
  if (
    !isRecord(states) ||
    !recordValuesMatch(states['devices'], isDeviceState) ||
    !recordValuesMatch(states['datastreams'], isDatastreamState) ||
    !recordValuesMatch(states['assets'], isAssetState) ||
    !recordValuesMatch(states['applications'], isApplicationState) ||
    !Array.isArray(value['diagnostics']) ||
    !value['diagnostics'].every(isDiagnostic) ||
    !isRecord(versions) ||
    !recordValuesMatch(
      versions['applications'],
      (version) => Number.isInteger(version) && Number(version) >= 1,
    )
  ) {
    throw new StateMigrationError('Persisted Engine snapshot is malformed');
  }
  return structuredClone(value) as unknown as PersistedEngineSnapshot;
};

const migrateSchema = (input: unknown, migrations: readonly EngineSnapshotMigration[]): unknown => {
  let snapshot = structuredClone(input);
  while (isRecord(snapshot) && Number.isInteger(snapshot['schemaVersion'])) {
    const version = snapshot['schemaVersion'] as number;
    if (version === ENGINE_SNAPSHOT_SCHEMA_VERSION) {
      return snapshot;
    }
    if (version > ENGINE_SNAPSHOT_SCHEMA_VERSION) {
      throw new StateMigrationError(`Unsupported Engine snapshot schema version: ${version}`);
    }
    const migration = migrations.find(({ fromVersion }) => fromVersion === version);
    if (migration === undefined || migration.toVersion !== version + 1) {
      throw new StateMigrationError(`No Engine snapshot migration from schema version ${version}`);
    }
    try {
      snapshot = migration.migrate(structuredClone(snapshot));
    } catch (error) {
      throw new StateMigrationError(`Engine snapshot migration from version ${version} failed`, {
        cause: error,
      });
    }
    if (!isRecord(snapshot) || snapshot['schemaVersion'] !== migration.toVersion) {
      throw new StateMigrationError(
        `Engine snapshot migration from version ${version} returned an invalid version`,
      );
    }
  }
  throw new StateMigrationError('Persisted Engine snapshot has no schema version');
};

const migrateApplicationStates = (
  snapshot: PersistedEngineSnapshot,
  configuration: EngineConfiguration,
  plugins: PluginRegistry,
): PersistedEngineSnapshot => {
  const applicationStates = { ...snapshot.entityStates.applications };
  const applicationVersions = { ...snapshot.pluginVersions.applications };
  for (const [assetName, asset] of Object.entries(configuration.assets)) {
    for (const [applicationName, application] of applicationConfigurationEntries(asset)) {
      const id = applicationIdForNames(assetName, applicationName);
      const persisted = applicationStates[id];
      if (persisted === undefined) {
        continue;
      }
      const plugin = plugins.resolveApplication(application.type);
      let version = applicationVersions[id];
      if (version === undefined) {
        throw new StateMigrationError(`Application ${id} has no persisted plugin version`);
      }
      if (version > plugin.version) {
        throw new StateMigrationError(
          `Application ${id} state version ${version} is newer than plugin version ${plugin.version}`,
        );
      }
      let pluginState: unknown = persisted.pluginState;
      while (version < plugin.version) {
        const migration = plugin.stateMigrations?.[version];
        if (migration === undefined) {
          throw new StateMigrationError(
            `Application ${id} has no plugin state migration from version ${version}`,
          );
        }
        try {
          pluginState = migration(structuredClone(pluginState));
        } catch (error) {
          throw new StateMigrationError(
            `Application ${id} plugin state migration from version ${version} failed`,
            { cause: error },
          );
        }
        version += 1;
      }
      if (!isRecord(pluginState)) {
        throw new StateMigrationError(
          `Application ${id} plugin state migration returned invalid state`,
        );
      }
      applicationStates[id] = { ...persisted, pluginState };
      applicationVersions[id] = version;
    }
  }
  return validateSnapshot({
    ...snapshot,
    entityStates: { ...snapshot.entityStates, applications: applicationStates },
    pluginVersions: { applications: applicationVersions },
  });
};

export const preparePersistedSnapshot = (
  input: unknown,
  configuration: EngineConfiguration,
  plugins: PluginRegistry,
  migrations: readonly EngineSnapshotMigration[] = [],
): PersistedEngineSnapshot =>
  migrateApplicationStates(
    validateSnapshot(migrateSchema(input, migrations)),
    configuration,
    plugins,
  );
