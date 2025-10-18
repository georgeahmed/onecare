import { createHash } from 'node:crypto';

import type { FeatureSnapshot } from './types';

const TRIAGE_NUMERIC_FIELDS = ['acuity', 'risk', 'complexity', 'time', 'capacity', 'compositeScore'] as const;
type TriageNumericField = (typeof TRIAGE_NUMERIC_FIELDS)[number];

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export interface SlidingWindowSpec {
  name: string;
  durationMs: number;
}

export interface FeatureViewDefinition {
  name: string;
  version: string;
  description?: string;
  sourceFeatureSet: string;
  targetFeatureSet: string;
  freshness: {
    offlineTtlSeconds?: number;
    onlineTtlSeconds?: number;
    recommendedBackfillWindowDays?: number;
  };
  tags?: string[];
  windows?: SlidingWindowSpec[];
  materialize(options: FeatureViewMaterializeOptions): FeatureSnapshot[];
}

export interface FeatureViewMaterializeOptions {
  snapshots: FeatureSnapshot[];
  asOf?: string;
}

const registry = new Map<string, FeatureViewDefinition>();

function clone<T>(value: T): T {
  if (typeof globalThis.structuredClone === 'function') {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return globalThis.structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function toTimestamp(value: string): number | null {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function computeMean(values: number[]): number | null {
  if (!values.length) {
    return null;
  }
  const sum = values.reduce((acc, value) => acc + value, 0);
  return sum / values.length;
}

function normaliseFieldKey(field: string): string {
  return field.replace(/[^A-Za-z0-9]/g, '_');
}

function hashViewKey(featureSet: string, entityId: string, version: string): string {
  return createHash('sha1').update(`${featureSet}::${entityId}::${version}`).digest('hex');
}

interface SlidingWindowAggregates {
  counts: Record<string, number>;
  averages: Record<string, Record<string, number | null>>;
  latest: Record<string, unknown>;
}

function computeSlidingAggregates(
  snapshots: FeatureSnapshot[],
  windows: SlidingWindowSpec[],
  fields: readonly string[],
  asOfMs: number
): SlidingWindowAggregates {
  const counts: Record<string, number> = {};
  const averages: Record<string, Record<string, number | null>> = {};
  const latest: Record<string, unknown> = {};

  for (const field of fields) {
    averages[field] = {};
  }

  const byWindow = new Map<string, FeatureSnapshot[]>();

  for (const spec of windows) {
    const cutoff = asOfMs - spec.durationMs;
    const inWindow = snapshots.filter((snapshot) => {
      const generatedAt = toTimestamp(snapshot.generatedAt);
      if (generatedAt === null) return false;
      return generatedAt >= cutoff && generatedAt <= asOfMs;
    });
    counts[spec.name] = inWindow.length;
    byWindow.set(spec.name, inWindow);
    for (const field of fields) {
      const numericValues = inWindow
        .map((snapshot) => snapshot.payload[field])
        .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
      const key = normaliseFieldKey(field);
      averages[field][spec.name] = computeMean(numericValues);
      if (spec.name === windows[0]?.name) {
        // Track the latest field value for reporting (across entire series).
        const latestSnapshot = inWindow[inWindow.length - 1];
        if (latestSnapshot && field in latestSnapshot.payload) {
          latest[key] = latestSnapshot.payload[field];
        }
      }
    }
  }

  const mostRecent = snapshots[snapshots.length - 1];
  if (mostRecent) {
    latest.generatedAt = mostRecent.generatedAt;
    latest.featureSet = mostRecent.featureSet;
  }

  return {
    counts,
    averages,
    latest,
  };
}

function materializeTriageSlidingWindow(options: FeatureViewMaterializeOptions, definition: FeatureViewDefinition): FeatureSnapshot[] {
  const windows = definition.windows ?? [];
  if (!windows.length) {
    return [];
  }

  const byEntity = new Map<string, FeatureSnapshot[]>();
  for (const snapshot of options.snapshots) {
    if (snapshot.featureSet !== definition.sourceFeatureSet) continue;
    const existing = byEntity.get(snapshot.entityId) ?? [];
    existing.push(snapshot);
    byEntity.set(snapshot.entityId, existing);
  }

  const asOfOverride = options.asOf ? toTimestamp(options.asOf) : null;
  const materialized: FeatureSnapshot[] = [];

  for (const [entityId, snapshots] of byEntity.entries()) {
    const sorted = snapshots
      .slice()
      .filter((snapshot) => toTimestamp(snapshot.generatedAt) !== null)
      .sort((a, b) => (toTimestamp(a.generatedAt) ?? 0) - (toTimestamp(b.generatedAt) ?? 0));
    if (!sorted.length) continue;

    const asOfMs = asOfOverride ?? toTimestamp(sorted[sorted.length - 1]!.generatedAt)!;
    const aggregates = computeSlidingAggregates(sorted, windows, TRIAGE_NUMERIC_FIELDS, asOfMs);

    const payload = {
      schemaVersion: 'v1',
      generatedAt: new Date(asOfMs).toISOString(),
      viewVersion: definition.version,
      counts: aggregates.counts,
      averages: aggregates.averages,
      latest: aggregates.latest,
    };

    materialized.push({
      featureSet: definition.targetFeatureSet,
      entityId,
      generatedAt: payload.generatedAt,
      payload,
      metadata: {
        viewName: definition.name,
        viewVersion: definition.version,
        sourceFeatureSet: definition.sourceFeatureSet,
        runKey: hashViewKey(definition.targetFeatureSet, entityId, definition.version),
      },
    });
  }

  return materialized;
}

const TRIAGE_SLIDING_WINDOWS: SlidingWindowSpec[] = [
  { name: '1h', durationMs: HOUR_MS },
  { name: '6h', durationMs: 6 * HOUR_MS },
  { name: '1d', durationMs: DAY_MS },
  { name: '7d', durationMs: 7 * DAY_MS },
  { name: '30d', durationMs: 30 * DAY_MS },
];

const TRIAGE_VIEW: FeatureViewDefinition = {
  name: 'triage-core.sliding-windows',
  version: 'v1',
  description: 'Rolling counts and averages for triage-core submissions per patient across multiple windows.',
  sourceFeatureSet: 'triage-core',
  targetFeatureSet: 'triage-core-windowed',
  freshness: {
    offlineTtlSeconds: 24 * 60 * 60,
    onlineTtlSeconds: 60 * 60,
    recommendedBackfillWindowDays: 30,
  },
  tags: ['triage', 'aggregates', 'sliding-window'],
  windows: TRIAGE_SLIDING_WINDOWS,
  materialize: (input) => materializeTriageSlidingWindow(input, TRIAGE_VIEW),
};

export function registerFeatureView(definition: FeatureViewDefinition): void {
  registry.set(definition.name, definition);
}

export function listFeatureViews(): FeatureViewDefinition[] {
  return Array.from(registry.values()).map((definition) => ({
    ...definition,
    windows: definition.windows ? definition.windows.map((window) => ({ ...window })) : undefined,
    freshness: clone(definition.freshness),
    tags: definition.tags ? clone(definition.tags) : undefined,
    materialize: definition.materialize,
  }));
}

export function getFeatureView(name: string): FeatureViewDefinition | null {
  const definition = registry.get(name);
  return definition ?? null;
}

export function materializeFeatureView(
  name: string,
  options: FeatureViewMaterializeOptions
): FeatureSnapshot[] {
  const definition = registry.get(name);
  if (!definition) {
    throw new Error(`Unknown feature view: ${name}`);
  }
  return definition.materialize(options);
}

export function materializeAllFeatureViews(
  options: FeatureViewMaterializeOptions
): Record<string, FeatureSnapshot[]> {
  const result: Record<string, FeatureSnapshot[]> = {};
  for (const definition of registry.values()) {
    result[definition.name] = definition.materialize(options);
  }
  return result;
}

registerFeatureView(TRIAGE_VIEW);
