import { createHash } from 'node:crypto';
import path from 'node:path';

import type { FeatureSnapshot, PartitionKeys, PartitionPlan } from './types';

const ISO_DATE_LENGTH = 10;

function toEventDate(generatedAt: string): string {
  const parsed = new Date(generatedAt);
  if (Number.isNaN(parsed.valueOf())) {
    throw new Error(`Invalid generatedAt timestamp: ${generatedAt}`);
  }
  return parsed.toISOString().slice(0, ISO_DATE_LENGTH);
}

function computeBucket(entityId: string, bucketPrefixLength: number): string {
  const hash = createHash('sha1').update(entityId).digest('hex');
  return hash.slice(0, bucketPrefixLength);
}

function bucketPrefixLength(bucketCount: number): number {
  if (bucketCount <= 16) return 1;
  if (bucketCount <= 256) return 2;
  if (bucketCount <= 4096) return 3;
  return 4;
}

export interface PartitionOptions {
  bucketCount?: number;
  fileExtension?: 'parquet' | 'delta' | 'jsonl';
  filenameStrategy?: (snapshot: FeatureSnapshot, keys: PartitionKeys) => string;
}

export function derivePartitionKeys(
  snapshot: FeatureSnapshot,
  options: PartitionOptions = {}
): PartitionKeys {
  const bucketCount = options.bucketCount ?? 256;
  const prefixLength = bucketPrefixLength(bucketCount);
  return {
    featureSet: snapshot.featureSet,
    eventDate: toEventDate(snapshot.generatedAt),
    entityBucket: computeBucket(snapshot.entityId, prefixLength),
  };
}

function defaultFileName(snapshot: FeatureSnapshot, keys: PartitionKeys, ext: string): string {
  const sanitizedGeneratedAt = snapshot.generatedAt.replace(/[^0-9A-Za-z]/g, '');
  const safeEntity = snapshot.entityId.replace(/[^0-9A-Za-z_-]/g, '-');
  return `${keys.featureSet}_${safeEntity}_${sanitizedGeneratedAt}.${ext}`;
}

export function planPartition(
  rootPath: string,
  snapshot: FeatureSnapshot,
  options: PartitionOptions = {}
): PartitionPlan {
  const keys = derivePartitionKeys(snapshot, options);
  const format = options.fileExtension ?? 'parquet';
  const filenameStrategy = options.filenameStrategy ?? ((snap, partitionKeys) => defaultFileName(snap, partitionKeys, format));
  const fileName = filenameStrategy(snapshot, keys);
  const filePath = path.join(
    rootPath,
    keys.featureSet,
    `event_date=${keys.eventDate}`,
    `entity_bucket=${keys.entityBucket}`,
    fileName
  );

  return {
    ...keys,
    rootPath,
    filePath,
  };
}
