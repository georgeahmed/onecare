import { createCounter, createHistogram, startSpan } from '@onecare/observability';

export interface ProviderCandidate {
  id: string;
  availability: number;
  workload: number;
  continuity: number;
  resolutionRate: number;
  distance: number;
  fairness: number;
  lastAssignedAt?: number;
  rejectUntil?: number;
  capacityScore?: number;
  queueDepth?: number;
}

export interface AssignmentWeights {
  availability: number;
  workload: number;
  continuity: number;
  resolution_rate: number;
  distance: number;
  fairness: number;
}

export interface AssignmentInput {
  taskId: string;
  patientId: string;
  priority?: string;
  continuityProviderId?: string;
  correlationId?: string;
}

export interface FairnessConfig {
  maxShare: number;
}

export interface AssignmentDecision {
  selected?: ProviderCandidate;
  ranking: Array<{ id: string; score: number; reasons: string[] }>;
  rejected: Array<{ id: string; reason: string }>;
}

const assignmentSelectedCounter = createCounter('triage.assignment.selected');
const assignmentRejectedCounter = createCounter('triage.assignment.rejected');
const assignmentRankingHistogram = createHistogram('triage.assignment.rank_position');
const assignmentDurationHistogram = createHistogram('triage.assignment.duration_ms');

function normalizeScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function continuityBoost(candidate: ProviderCandidate, desiredProviderId?: string): number {
  if (!desiredProviderId) return 0;
  return candidate.id === desiredProviderId ? 0.05 : 0;
}

function computeScore(
  candidate: ProviderCandidate,
  weights: AssignmentWeights,
  continuityPreference?: string,
): { score: number; continuityBoostApplied: boolean } {
  const availability = normalizeScore(candidate.availability);
  const workload = 1 - normalizeScore(candidate.workload);
  const continuityBase = normalizeScore(candidate.continuity);
  const continuityBoostAmount = continuityBoost(candidate, continuityPreference);
  const continuity = continuityBase + continuityBoostAmount;
  const resolutionRate = normalizeScore(candidate.resolutionRate);
  const distance = 1 - normalizeScore(candidate.distance);
  const fairness = normalizeScore(candidate.fairness);
  const score =
    availability * weights.availability +
    workload * weights.workload +
    continuity * weights.continuity +
    resolutionRate * weights.resolution_rate +
    distance * weights.distance +
    fairness * weights.fairness;
  return { score, continuityBoostApplied: continuityBoostAmount > 0 };
}

function applyBackpressureBias(score: number, candidate: ProviderCandidate): { score: number; biased: boolean } {
  const queuePenalty = candidate.queueDepth ? Math.min(candidate.queueDepth / 10, 0.5) : 0;
  const capacity = normalizeScore(candidate.capacityScore ?? 1);
  const hasCapacity = capacity > 0.2;
  if (!hasCapacity) {
    return { score: score * 0.5, biased: true };
  }
  const adjusted = score * (1 - queuePenalty) * (0.7 + capacity * 0.3);
  return { score: adjusted, biased: adjusted !== score };
}

function tieBreakers(a: ProviderCandidate, b: ProviderCandidate): number {
  const aAssigned = a.lastAssignedAt ?? 0;
  const bAssigned = b.lastAssignedAt ?? 0;
  if (aAssigned !== bAssigned) return aAssigned - bAssigned;
  return a.id.localeCompare(b.id);
}

function isBlocked(candidate: ProviderCandidate, now: number): string | null {
  if (candidate.rejectUntil && candidate.rejectUntil > now) {
    return 'backpressure';
  }
  return null;
}

export function assignProvider(
  task: AssignmentInput,
  providers: ProviderCandidate[],
  weights: AssignmentWeights,
  fairness?: FairnessConfig,
  now: number = Date.now(),
): AssignmentDecision {
  const span = startSpan('triage.assign');
  const startedAt = Date.now();
  const totalCandidates = Array.isArray(providers) ? providers.length : 0;
  let decision: AssignmentDecision = { selected: undefined, ranking: [], rejected: [] };

  try {
    if (!Array.isArray(providers) || providers.length === 0) {
      decision = { selected: undefined, ranking: [], rejected: [] };
      return decision;
    }

    const rejected: Array<{ id: string; reason: string }> = [];
    const scored = providers
      .map((provider) => {
        const blockReason = isBlocked(provider, now);
        if (blockReason) {
          rejected.push({ id: provider.id, reason: blockReason });
          return null;
        }

        const { score: baseScore, continuityBoostApplied } = computeScore(
          provider,
          weights,
          task.continuityProviderId,
        );
        const fairnessExceeded = fairness
          ? normalizeScore(provider.fairness) > normalizeScore(fairness.maxShare)
          : false;
        const fairnessPenalty = fairnessExceeded ? -1 : 0;
        const { score: biasedScore, biased } = applyBackpressureBias(baseScore + fairnessPenalty, provider);

        return {
          provider,
          score: biasedScore,
          reasons: buildReasons(provider, baseScore, biasedScore, fairnessExceeded, biased, continuityBoostApplied),
        };
      })
      .filter((entry): entry is { provider: ProviderCandidate; score: number; reasons: string[] } => Boolean(entry));

    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return tieBreakers(a.provider, b.provider);
    });

    const ranking = scored.map((item, index) => ({ id: item.provider.id, score: item.score, reasons: item.reasons }));
    const selected = scored[0]?.provider;

    recordAssignmentMetrics(task, selected, ranking, rejected);
    decision = { selected, ranking, rejected };
    return decision;
  } finally {
    const durationAttributes: Record<string, unknown> = {
      priority: task.priority ?? 'unknown',
      outcome: decision.selected ? 'assigned' : 'none',
    };
    if (task.correlationId) {
      durationAttributes.correlationId = task.correlationId;
    }
    assignmentDurationHistogram.record(Date.now() - startedAt, durationAttributes);
    if (span.isRecording()) {
      span.setAttribute('triage.assign.candidates', totalCandidates);
      span.setAttribute('triage.assign.outcome', decision.selected ? 'assigned' : 'none');
      if (task.priority) {
        span.setAttribute('triage.assign.priority', task.priority);
      }
    }
    span.end();
  }
}

function buildReasons(
  provider: ProviderCandidate,
  baseScore: number,
  finalScore: number,
  fairnessExceeded: boolean,
  biased: boolean,
  continuityBoostApplied: boolean,
): string[] {
  const reasons: string[] = [];
  if (provider.continuity > 0.7) reasons.push('continuity_high');
  if (continuityBoostApplied) reasons.push('continuity_boost');
  if (fairnessExceeded) reasons.push('fairness_floor_hit');
  if (biased && finalScore < baseScore) reasons.push('backpressure_bias');
  return reasons;
}

function recordAssignmentMetrics(
  task: AssignmentInput,
  selected: ProviderCandidate | undefined,
  ranking: Array<{ id: string; score: number }>,
  rejected: Array<{ id: string; reason: string }>,
): void {
  const priority = task.priority ?? 'unknown';
  const correlationId = task.correlationId;

  assignmentSelectedCounter.add(1, {
    provider: selected?.id ?? 'none',
    priority,
    correlationId,
  });

  ranking.forEach((entry, index) => {
    assignmentRankingHistogram.record(index + 1, {
      provider: entry.id,
      priority,
      correlationId,
    });
  });

  rejected.forEach((entry) => {
    assignmentRejectedCounter.add(1, {
      provider: entry.id,
      priority,
      reason: entry.reason,
      correlationId,
    });
  });
}
