import {
  IntentClassifierError,
  type IntentClassifier,
  type IntentClassificationInput,
  type IntentClassificationResult,
  StubIntentClassifier,
} from './intent.classifier';

export interface KeywordIntentConfig {
  intent: string;
  keywords: string[];
  confidence?: number;
}

export interface IntentServiceClassifierOptions {
  baseUrl?: string;
  apiKey?: string;
  defaultIntent?: string;
  defaultConfidence?: number;
  keywordIntents?: KeywordIntentConfig[];
  fallback?: IntentClassifier;
}

const DEFAULT_INTENT = 'telephony.callback';
const DEFAULT_CONFIDENCE = 0.6;

const FALLBACK_KEYWORD_CONFIG: KeywordIntentConfig[] = [
  { intent: 'telephony.emergency', keywords: ['emergency', 'ambulance', 'help now'], confidence: 0.95 },
  { intent: 'telephony.medication', keywords: ['refill', 'prescription', 'medication'], confidence: 0.8 },
  { intent: 'telephony.appointment', keywords: ['appointment', 'schedule', 'book'], confidence: 0.75 },
  { intent: 'telephony.test.results', keywords: ['results', 'lab', 'test'], confidence: 0.7 },
  { intent: 'telephony.billing', keywords: ['bill', 'payment', 'invoice'], confidence: 0.65 },
];

function parseFloatEnv(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseKeywordConfig(raw: string | undefined): KeywordIntentConfig[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as KeywordIntentConfig[];
    if (!Array.isArray(parsed)) return undefined;
    return parsed
      .filter((entry) => typeof entry?.intent === 'string' && Array.isArray(entry?.keywords))
      .map((entry) => ({
        intent: entry.intent.trim(),
        keywords: entry.keywords.map((kw) => kw.toLowerCase().trim()).filter(Boolean),
        confidence: typeof entry.confidence === 'number' ? entry.confidence : undefined,
      }))
      .filter((entry) => entry.intent && entry.keywords.length > 0);
  } catch {
    return undefined;
  }
}

function normaliseKeywordIntents(intents?: KeywordIntentConfig[]): KeywordIntentConfig[] {
  if (!intents || intents.length === 0) {
    return FALLBACK_KEYWORD_CONFIG;
  }
  return intents.map((entry) => ({
    intent: entry.intent.trim(),
    keywords: entry.keywords.map((kw) => kw.toLowerCase().trim()).filter(Boolean),
    confidence: typeof entry.confidence === 'number' ? entry.confidence : undefined,
  }));
}

export class IntentServiceClassifier implements IntentClassifier {
  private readonly baseUrl?: string;
  private readonly apiKey?: string;
  private readonly defaultIntent: string;
  private readonly defaultConfidence: number;
  private readonly keywordIntents: KeywordIntentConfig[];
  private readonly fallback?: IntentClassifier;

  constructor(options?: IntentServiceClassifierOptions) {
    this.baseUrl = options?.baseUrl?.trim() || undefined;
    this.apiKey = options?.apiKey?.trim() || undefined;
    this.defaultIntent = options?.defaultIntent?.trim() || DEFAULT_INTENT;
    const confidence = options?.defaultConfidence;
    this.defaultConfidence = typeof confidence === 'number' && Number.isFinite(confidence) ? confidence : DEFAULT_CONFIDENCE;
    this.keywordIntents = normaliseKeywordIntents(options?.keywordIntents);
    this.fallback = options?.fallback;
  }

  static fromEnv(): IntentServiceClassifier {
    const baseUrl = process.env.INTENT_SERVICE_URL?.trim();
    const apiKey = process.env.INTENT_SERVICE_API_KEY?.trim();
    const defaultIntent = process.env.INTENT_SERVICE_DEFAULT_INTENT?.trim();
    const defaultConfidence = parseFloatEnv(process.env.INTENT_SERVICE_DEFAULT_CONFIDENCE);
    const keywordConfig = parseKeywordConfig(process.env.INTENT_SERVICE_KEYWORD_INTENTS);
    const fallback = process.env.INTENT_SERVICE_FALLBACK === 'stub' ? new StubIntentClassifier() : undefined;

    return new IntentServiceClassifier({
      baseUrl,
      apiKey,
      defaultIntent,
      defaultConfidence,
      keywordIntents: keywordConfig,
      fallback,
    });
  }

  async classify(input: IntentClassificationInput): Promise<IntentClassificationResult> {
    const transcript = (input.transcript ?? '').toLowerCase();
    if (!transcript.trim()) {
      return this.resolveFallback(input, this.defaultIntent, this.defaultConfidence);
    }

    for (const config of this.keywordIntents) {
      if (config.keywords.some((keyword) => transcript.includes(keyword))) {
        return {
          intent: config.intent,
          confidence: config.confidence ?? this.defaultConfidence,
        };
      }
    }

    if (this.fallback) {
      try {
        return await this.fallback.classify(input);
      } catch (error) {
        throw new IntentClassifierError('intent_classifier_unavailable', 'fallback classifier failed', error);
      }
    }

    return {
      intent: this.defaultIntent,
      confidence: this.defaultConfidence,
    };
  }

  private resolveFallback(
    input: IntentClassificationInput,
    intent: string,
    confidence: number,
  ): IntentClassificationResult {
    if (this.fallback) {
      return {
        intent,
        confidence,
      };
    }
    return {
      intent,
      confidence,
    };
  }
}
