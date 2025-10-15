import type { FeatureSnapshot, PointInTimeRow } from './types';

function compareTimestamps(a: string, b: string): number {
  const tsA = Date.parse(a);
  const tsB = Date.parse(b);
  if (Number.isNaN(tsA) || Number.isNaN(tsB)) {
    throw new Error(`Invalid timestamp comparison: ${a} vs ${b}`);
  }
  return tsA - tsB;
}

function normaliseSnapshot(snapshot: FeatureSnapshot): FeatureSnapshot {
  const { generatedAt } = snapshot;
  if (!generatedAt) throw new Error('Snapshot missing generatedAt');
  const parsed = new Date(generatedAt);
  if (Number.isNaN(parsed.valueOf())) {
    throw new Error(`Invalid generatedAt timestamp: ${generatedAt}`);
  }
  return {
    ...snapshot,
    generatedAt: parsed.toISOString(),
  };
}

function groupSnapshots(snapshots: FeatureSnapshot[]): Map<string, FeatureSnapshot[]> {
  const groups = new Map<string, FeatureSnapshot[]>();
  for (const rawSnapshot of snapshots) {
    const snapshot = normaliseSnapshot(rawSnapshot);
    const key = `${snapshot.featureSet}::${snapshot.entityId}`;
    const current = groups.get(key) ?? [];
    current.push(snapshot);
    groups.set(key, current);
  }
  for (const group of groups.values()) {
    group.sort((a, b) => compareTimestamps(a.generatedAt, b.generatedAt));
  }
  return groups;
}

export function buildPointInTimeTable(snapshots: FeatureSnapshot[]): PointInTimeRow[] {
  const groups = groupSnapshots(snapshots);
  const rows: PointInTimeRow[] = [];
  for (const group of groups.values()) {
    for (let idx = 0; idx < group.length; idx += 1) {
      const current = group[idx]!;
      const next = group[idx + 1] ?? null;
      rows.push({
        featureSet: current.featureSet,
        entityId: current.entityId,
        effectiveFrom: current.generatedAt,
        effectiveTo: next ? next.generatedAt : null,
        payload: current.payload,
        metadata: current.metadata,
      });
    }
  }
  rows.sort((a, b) => {
    if (a.featureSet === b.featureSet) {
      if (a.entityId === b.entityId) {
        return compareTimestamps(a.effectiveFrom, b.effectiveFrom);
      }
      return a.entityId.localeCompare(b.entityId);
    }
    return a.featureSet.localeCompare(b.featureSet);
  });
  return rows;
}

export interface PointInTimeQuery {
  featureSet: string;
  entityId: string;
  asOf: string;
}

export function selectPointInTime(rows: PointInTimeRow[], query: PointInTimeQuery): PointInTimeRow | null {
  const asOfTs = Date.parse(query.asOf);
  if (Number.isNaN(asOfTs)) {
    throw new Error(`Invalid asOf timestamp: ${query.asOf}`);
  }
  let candidate: PointInTimeRow | null = null;
  for (const row of rows) {
    if (row.featureSet !== query.featureSet || row.entityId !== query.entityId) {
      continue;
    }
    const fromTs = Date.parse(row.effectiveFrom);
    const toTs = row.effectiveTo ? Date.parse(row.effectiveTo) : Number.POSITIVE_INFINITY;
    if (Number.isNaN(fromTs) || Number.isNaN(toTs)) {
      throw new Error('Invalid effective window in PIT row.');
    }
    if (fromTs <= asOfTs && asOfTs < toTs && (!candidate || fromTs > Date.parse(candidate.effectiveFrom))) {
      candidate = row;
    }
    if (!row.effectiveTo && fromTs <= asOfTs) {
      candidate = row;
    }
  }
  if (!candidate) {
    return null;
  }
  return {
    ...candidate,
    payload: { ...candidate.payload },
    metadata: candidate.metadata ? { ...candidate.metadata } : undefined,
  };
}
