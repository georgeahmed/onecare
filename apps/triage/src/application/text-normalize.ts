export interface TextNormalizeOptions {
  stopwords?: string[];
  applyStemming?: boolean;
  minTokenLength?: number;
}

export interface NormalizedText {
  normalized: string;
  tokens: string[];
}

const DEFAULT_STOPWORDS = new Set<string>([
  'a',
  'an',
  'and',
  'are',
  'be',
  'been',
  'but',
  'by',
  'for',
  'from',
  'had',
  'has',
  'have',
  'in',
  'is',
  'it',
  'its',
  'of',
  'on',
  'or',
  'that',
  'the',
  'their',
  'there',
  'they',
  'this',
  'to',
  'was',
  'were',
  'with',
  'you',
  'your',
]);

const DEFAULT_OPTIONS: Required<TextNormalizeOptions> = Object.freeze({
  stopwords: Array.from(DEFAULT_STOPWORDS),
  applyStemming: true,
  minTokenLength: 2,
});

function buildStopwordSet(options: TextNormalizeOptions): Set<string> {
  const custom = options.stopwords;
  if (!custom || custom.length === 0) {
    return DEFAULT_STOPWORDS;
  }
  return new Set(custom.map((word) => word.toLowerCase()));
}

function stemToken(token: string): string {
  if (token.length <= 4) return token;
  if (token.endsWith('ing')) {
    return token.slice(0, -3);
  }
  if (token.endsWith('ed')) {
    return token.slice(0, -2);
  }
  if (token.endsWith('es')) {
    return token.slice(0, -2);
  }
  if (token.endsWith('s')) {
    return token.slice(0, -1);
  }
  return token;
}

function shouldKeep(token: string, minTokenLength: number, stopwords: Set<string>): boolean {
  if (token.length < minTokenLength) return false;
  if (stopwords.has(token)) return false;
  return true;
}

export function normalizeText(input: string, options: TextNormalizeOptions = {}): NormalizedText {
  const effective: Required<TextNormalizeOptions> = {
    stopwords: options.stopwords ?? DEFAULT_OPTIONS.stopwords,
    applyStemming: options.applyStemming ?? DEFAULT_OPTIONS.applyStemming,
    minTokenLength: options.minTokenLength ?? DEFAULT_OPTIONS.minTokenLength,
  };

  const stopwords = buildStopwordSet(effective);
  const normalizedInput = input.normalize('NFKC').toLowerCase();
  const rawTokens = normalizedInput
    .split(/\W+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  const tokens: string[] = [];

  for (const token of rawTokens) {
    const stemmed = effective.applyStemming ? stemToken(token) : token;
    if (!shouldKeep(stemmed, effective.minTokenLength, stopwords)) {
      continue;
    }
    tokens.push(stemmed);
  }

  return {
    normalized: tokens.join(' '),
    tokens,
  };
}

export function defaultStopwords(): string[] {
  return Array.from(DEFAULT_STOPWORDS);
}
