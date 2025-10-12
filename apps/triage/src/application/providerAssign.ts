export interface ProviderCandidate {
  id: string;
  availability: number;
  workload: number;
  continuity: number;
  resolutionRate: number;
  distance: number;
  fairness: number;
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
}

function normalizeScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export function assignProvider(
  _task: AssignmentInput,
  providers: ProviderCandidate[],
  weights: AssignmentWeights,
): string | undefined {
  if (!Array.isArray(providers) || providers.length === 0) return undefined;

  const candidates = providers.map((provider) => {
    const availability = normalizeScore(provider.availability);
    const workload = 1 - normalizeScore(provider.workload); // invert: lower workload preferred
    const continuity = normalizeScore(provider.continuity);
    const resolutionRate = normalizeScore(provider.resolutionRate);
    const distance = 1 - normalizeScore(provider.distance); // invert: closer preferred
    const fairness = normalizeScore(provider.fairness);

    const score =
      availability * weights.availability +
      workload * weights.workload +
      continuity * weights.continuity +
      resolutionRate * weights.resolution_rate +
      distance * weights.distance +
      fairness * weights.fairness;

    return { provider, score };
  });

  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.provider.id.localeCompare(b.provider.id);
  });

  return candidates[0]?.provider.id;
}
