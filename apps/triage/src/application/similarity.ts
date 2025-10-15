export interface SimilarityOptions {
  shingleSize?: number;
}

const DEFAULT_SHINGLE_SIZE = 2;

function buildShingles(tokens: string[], size: number): Set<string> {
  if (tokens.length === 0) {
    return new Set();
  }
  if (tokens.length < size) {
    return new Set(tokens);
  }
  const shingles = new Set<string>();
  for (let i = 0; i <= tokens.length - size; i += 1) {
    shingles.add(tokens.slice(i, i + size).join(' '));
  }
  return shingles;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const value of a) {
    if (b.has(value)) {
      intersection += 1;
    }
  }
  const union = a.size + b.size - intersection;
  if (union === 0) return 0;
  return intersection / union;
}

export function computeSimilarity(tokensA: string[], tokensB: string[], options: SimilarityOptions = {}): number {
  const size = options.shingleSize && options.shingleSize >= 2 ? Math.floor(options.shingleSize) : DEFAULT_SHINGLE_SIZE;
  const shinglesA = buildShingles(tokensA, size);
  const shinglesB = buildShingles(tokensB, size);
  const shingleScore = jaccard(shinglesA, shinglesB);
  const tokenScore = jaccard(new Set(tokensA), new Set(tokensB));
  return Math.max(shingleScore, tokenScore);
}
