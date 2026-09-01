import type { Diagnostic, DiagnosticCategory } from './diagnostics';
import type { EntityEventSource } from './events';
import type { PluginTypeId } from './identifiers';
import type { EntityKind, EntityRef } from './model';

export type SnapshotRelations = 'self' | 'parent' | 'children' | 'family';

export type SnapshotTarget =
  | { readonly scope: 'eventSource' }
  | { readonly scope: 'entity'; readonly entityType: EntityKind; readonly entityId: string }
  | { readonly scope: 'all' };

export interface SnapshotRequest {
  readonly target: SnapshotTarget;
  readonly relations?: SnapshotRelations;
  readonly statePaths?: readonly string[];
  readonly strictPaths?: boolean;
}

export interface EntityRelationships {
  readonly parent?: EntityRef;
  readonly children: readonly EntityRef[];
  readonly datafeeds?: Readonly<Record<string, EntityRef>>;
}

export interface EntitySnapshot {
  readonly entityType: EntityKind;
  readonly entityId: string;
  readonly pluginType?: PluginTypeId;
  readonly relationships: EntityRelationships;
  readonly state: Readonly<object>;
}

export interface MissingStatePath {
  readonly entity: EntityRef;
  readonly path: string;
}

export type SnapshotDiagnosticGroups = Readonly<Record<DiagnosticCategory, readonly Diagnostic[]>>;

export interface EngineSnapshotResponse {
  readonly entities: readonly EntitySnapshot[];
  readonly diagnostics?: SnapshotDiagnosticGroups;
  readonly missingPaths: readonly MissingStatePath[];
}

export class SnapshotRequestError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'SnapshotRequestError';
  }
}

export class SnapshotPathError extends SnapshotRequestError {
  public constructor(public readonly missingPaths: readonly MissingStatePath[]) {
    super(
      `Snapshot state paths are missing: ${missingPaths
        .map(({ entity, path }) => `${entity.kind}:${entity.id}:${path}`)
        .join(', ')}`,
    );
    this.name = 'SnapshotPathError';
  }
}

const forbiddenPathSegments = new Set(['__proto__', 'prototype', 'constructor']);
const pathSegmentPattern = /^[A-Za-z0-9_$-]+$/;

const splitPath = (path: string): readonly string[] => {
  const segments = path.split('.');
  if (
    segments.length === 0 ||
    segments.some(
      (segment) => !pathSegmentPattern.test(segment) || forbiddenPathSegments.has(segment),
    )
  ) {
    throw new SnapshotRequestError(`Invalid state path: ${path}`);
  }
  return segments;
};

const readPath = (
  state: object,
  segments: readonly string[],
): { found: boolean; value?: unknown } => {
  let current: unknown = state;
  for (const segment of segments) {
    if (typeof current !== 'object' || current === null || !Object.hasOwn(current, segment)) {
      return { found: false };
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return { found: true, value: structuredClone(current) };
};

const writePath = (
  target: Record<string, unknown>,
  segments: readonly string[],
  value: unknown,
): void => {
  let current = target;
  for (const [index, segment] of segments.entries()) {
    if (index === segments.length - 1) {
      current[segment] = value;
      return;
    }
    const existing = current[segment];
    if (typeof existing === 'object' && existing !== null && !Array.isArray(existing)) {
      current = existing as Record<string, unknown>;
    } else {
      const nested: Record<string, unknown> = {};
      current[segment] = nested;
      current = nested;
    }
  }
};

export const projectSnapshotState = (
  state: object,
  paths: readonly string[] | undefined,
): { readonly state: object; readonly missingPaths: readonly string[] } => {
  if (paths === undefined) {
    return { state: structuredClone(state), missingPaths: [] };
  }

  const projected: Record<string, unknown> = {};
  const missingPaths: string[] = [];
  for (const path of paths) {
    const segments = splitPath(path);
    const result = readPath(state, segments);
    if (!result.found) {
      missingPaths.push(path);
      continue;
    }
    writePath(projected, segments, result.value);
  }
  return { state: projected, missingPaths };
};

export const deepFreezeSnapshot = <Value>(value: Value): Value => {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreezeSnapshot(child);
  }
  return Object.freeze(value);
};

export type SnapshotEventSource = EntityEventSource;
