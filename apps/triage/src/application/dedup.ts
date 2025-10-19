import { createCounter, createHistogram } from '@onecare/observability';
import { normalizeText, type NormalizedText, type TextNormalizeOptions } from './text-normalize';
import { computeSimilarity } from './similarity';

export interface DedupStoreOptions {
  maxEntriesPerPatient?: number;
}

export interface DedupEvaluateInput {
  patientId?: string;
  narrative?: string;
  now: number;
  windowMs: number;
  threshold: number;
  shingleSize?: number;
  textOptions?: TextNormalizeOptions;
  correlationId?: string;
}

export interface DedupEntry {
  narrative: string;
  normalized: string;
  tokens: string[];
  timestamp: number;
}

export interface DedupDecision {
  isDuplicate: boolean;
  similarity?: number;
  maxSimilarity?: number;
  reference?: DedupEntry;
  normalized?: NormalizedText;
  entries?: DedupEntry[];
  reason?: string;
}

const DEFAULT_MAX_ENTRIES = 50;

const dedupHitCounter = createCounter('triage.dedup.hit');
const dedupMissCounter = createCounter('triage.dedup.miss');
const dedupSimilarityHistogram = createHistogram('triage.dedup.similarity');

function pruneEntries(entries: DedupEntry[], windowMs: number, now: number): DedupEntry[] {
  if (windowMs <= 0) return [];
  return entries.filter((entry) => now - entry.timestamp <= windowMs);
}

function enforceLimit(entries: DedupEntry[], limit: number): DedupEntry[] {
  if (entries.length <= limit) {
    return entries;
  }
  return entries.slice(entries.length - limit);
}

export class DedupStore {
  private readonly maxEntriesPerPatient: number;
  private readonly buckets = new Map<string, DedupEntry[]>();

  constructor(options: DedupStoreOptions = {}) {
    this.maxEntriesPerPatient = options.maxEntriesPerPatient && options.maxEntriesPerPatient > 0
      ? Math.floor(options.maxEntriesPerPatient)
      : DEFAULT_MAX_ENTRIES;
  }

  reset(): void {
    this.buckets.clear();
  }

  size(): number {
    return this.buckets.size;
  }

  count(patientId: string): number {
    return this.buckets.get(patientId)?.length ?? 0;
  }

  evaluate(input: DedupEvaluateInput): DedupDecision {
    if (input.windowMs <= 0) {
      this.reset();
      recordDedupMetrics({
        duplicate: false,
        threshold: input.threshold,
        reason: 'disabled',
        correlationId: input.correlationId,
      });
      return { isDuplicate: false, reason: 'disabled' };
    }

    this.pruneBuckets(input.windowMs, input.now);

    const patientId = input.patientId?.trim();
    const narrative = input.narrative?.trim();
    if (!patientId || !narrative) {
      recordDedupMetrics({
        duplicate: false,
        threshold: input.threshold,
        reason: 'missing_fields',
        correlationId: input.correlationId,
      });
      return { isDuplicate: false, reason: 'missing_fields' };
    }

    const now = input.now;
    const bucket = this.buckets.get(patientId) ?? [];
    const freshEntries = pruneEntries(bucket, input.windowMs, now);

    const normalized = normalizeText(narrative, input.textOptions);
    if (normalized.tokens.length === 0) {
      this.buckets.set(patientId, enforceLimit([...freshEntries], this.maxEntriesPerPatient));
      recordDedupMetrics({
        duplicate: false,
        threshold: input.threshold,
        similarity: 0,
        reason: 'no_tokens',
        correlationId: input.correlationId,
      });
      return { isDuplicate: false, normalized, entries: freshEntries, maxSimilarity: 0, reason: 'no_tokens' };
    }

    let bestMatch: DedupEntry | undefined;
    let bestSimilarity = 0;
    let maxSimilarity = 0;
    for (const entry of freshEntries) {
      const similarity = computeSimilarity(normalized.tokens, entry.tokens, {
        shingleSize: input.shingleSize,
      });
      if (similarity > maxSimilarity) {
        maxSimilarity = similarity;
      }
      if (similarity >= input.threshold && similarity >= bestSimilarity) {
        bestSimilarity = similarity;
        bestMatch = entry;
      }
    }

    const updatedEntries = enforceLimit(
      [...freshEntries, { narrative, normalized: normalized.normalized, tokens: normalized.tokens, timestamp: now }],
      this.maxEntriesPerPatient,
    );
    this.buckets.set(patientId, updatedEntries);

    const isDuplicate = Boolean(bestMatch);
    recordDedupMetrics({
      duplicate: isDuplicate,
      threshold: input.threshold,
      similarity: isDuplicate ? bestSimilarity : maxSimilarity,
      reason: isDuplicate ? undefined : freshEntries.length === 0 ? 'no_history' : 'below_threshold',
      correlationId: input.correlationId,
    });

    return {
      isDuplicate: Boolean(bestMatch),
      similarity: bestMatch ? bestSimilarity : undefined,
      maxSimilarity,
      reference: bestMatch,
      normalized,
      entries: updatedEntries,
      reason: bestMatch ? undefined : freshEntries.length === 0 ? 'no_history' : 'below_threshold',
    };
  }

  private pruneBuckets(windowMs: number, now: number): void {
    for (const [patientId, entries] of this.buckets.entries()) {
      const fresh = pruneEntries(entries, windowMs, now);
      if (fresh.length === 0) {
        this.buckets.delete(patientId);
      } else {
        this.buckets.set(patientId, fresh);
      }
    }
  }
}

export function createDedupStore(options?: DedupStoreOptions): DedupStore {
  return new DedupStore(options);
}

function recordDedupMetrics(options: {
  duplicate: boolean;
  threshold: number;
  similarity?: number;
  reason?: string;
  correlationId?: string;
}): void {
  const similarity = Number.isFinite(options.similarity) ? (options.similarity as number) : 0;
  const baseAttributes: Record<string, unknown> = {
    duplicate: options.duplicate ? 'yes' : 'no',
    threshold: options.threshold,
  };
  if (options.reason) {
    baseAttributes.reason = options.reason;
  }
  if (options.correlationId) {
    baseAttributes.correlationId = options.correlationId;
  }

  if (options.duplicate) {
    dedupHitCounter.add(1, baseAttributes);
  } else {
    dedupMissCounter.add(1, baseAttributes);
  }

  dedupSimilarityHistogram.record(similarity, { ...baseAttributes });
}
