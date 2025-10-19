import { createHash } from 'node:crypto';
import path from 'node:path';

import type { FeatureSnapshot, PartitionKeys, PartitionPlan } from './types';

const ISO_DATE_LENGTH = 10;
const HEX_RADIX = 16;

function toEventDate(generatedAt: string): string {
  const parsed = new Date(generatedAt);
  if (Number.isNaN(parsed.valueOf())) {
    throw new Error(`Invalid generatedAt timestamp: ${generatedAt}`);
  }
  return parsed.toISOString().slice(0, ISO_DATE_LENGTH);
}

function normalizeBucketCount(value: number | undefined): number {
  const bucketCount = value ?? 256;
  if (!Number.isInteger(bucketCount) || bucketCount <= 0) {
    throw new Error(`bucketCount must be a positive integer. Received: ${value}`);
  }
  return bucketCount;
}

function bucketPrefixLength(bucketCount: number): number {
  const digits = Math.ceil(Math.log(bucketCount) / Math.log(HEX_RADIX));
  if (!Number.isFinite(digits) || digits <= 0) {
    return 1;
  }
  return Math.max(1, digits);
}

function computeBucket(entityId: string, bucketCount: number, prefixLength: number): string {
  const hash = createHash('sha1').update(entityId).digest('hex');
  const hashValue = BigInt(`0x${hash}`);
  const bucketIndex = hashValue % BigInt(bucketCount);
  const bucketHex = bucketIndex.toString(HEX_RADIX);
  return bucketHex.padStart(prefixLength, '0');
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
  const bucketCount = normalizeBucketCount(options.bucketCount);
  const prefixLength = bucketPrefixLength(bucketCount);
  return {
    featureSet: snapshot.featureSet,
    eventDate: toEventDate(snapshot.generatedAt),
    entityBucket: computeBucket(snapshot.entityId, bucketCount, prefixLength),
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
