import type { Diagnostic, DiagnosticCategory } from './diagnostics';
import type { PluginTypeId } from './identifiers';
import type { EntityKind, EntityRef } from './model';

export type SnapshotIds = string | readonly string[] | '*';

export interface EntitySnapshotSelector {
  readonly type: EntityKind;
  readonly ids: SnapshotIds;
  readonly parent?: boolean;
  readonly children?: boolean;
  readonly datafeeds?: boolean;
  readonly statePaths?: readonly string[];
}

export interface DiagnosticSnapshotSelector {
  readonly type: EntityKind | 'common';
  readonly ids: SnapshotIds;
}

export interface SnapshotRequest {
  readonly entities?: readonly EntitySnapshotSelector[];
  readonly diagnostics?: readonly DiagnosticSnapshotSelector[];
}

export interface EntityRelationships {
  readonly parent?: EntityRef;
  readonly children: readonly EntityRef[];
  readonly datafeeds?: Readonly<Record<string, EntityRef>>;
}

export interface EntitySnapshot {
  readonly entityType: EntityKind;
  readonly entityId: string;
  readonly entityName?: string;
  readonly pluginType?: PluginTypeId;
  readonly relationships: EntityRelationships;
  readonly state: Readonly<object>;
}

export type SnapshotEntityGroups = Readonly<
  Record<EntityKind, Readonly<Record<string, EntitySnapshot>>>
>;

export type SnapshotDiagnosticCategory = Lowercase<DiagnosticCategory>;

export type SnapshotDiagnosticGroups = Readonly<
  Record<SnapshotDiagnosticCategory, Readonly<Record<string, readonly Diagnostic[]>>>
>;

export interface EngineSnapshotResponse {
  readonly entities: SnapshotEntityGroups;
  readonly diagnostics: SnapshotDiagnosticGroups;
}

export class SnapshotRequestError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'SnapshotRequestError';
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
): object => {
  if (paths === undefined) {
    return structuredClone(state);
  }

  const projected: Record<string, unknown> = {};
  for (const path of paths) {
    const segments = splitPath(path);
    const result = readPath(state, segments);
    if (!result.found) {
      continue;
    }
    writePath(projected, segments, result.value);
  }
  return projected;
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
