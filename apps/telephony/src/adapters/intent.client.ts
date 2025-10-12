import {
  IntentClassifierError,
  type IntentClassifier,
  type IntentClassificationInput,
  type IntentClassificationResult,
  StubIntentClassifier,
} from './intent.classifier';

export interface IntentServiceClassifierOptions {
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
  path?: string;
  fetchImpl?: typeof fetch;
  fallback?: IntentClassifier;
}

const DEFAULT_TIMEOUT_MS = 1_500;
const MIN_TIMEOUT_MS = 250;
const DEFAULT_PATH = '/classify';

export class IntentServiceClassifier implements IntentClassifier {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly path: string;
  private readonly fetchImpl: typeof fetch;
  private readonly fallback?: IntentClassifier;

  constructor(options: IntentServiceClassifierOptions) {
    if (!options.baseUrl?.trim()) {
      throw new IntentClassifierError('intent_classifier_configuration', 'intent service baseUrl missing');
    }
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.apiKey = options.apiKey?.trim() || undefined;
    const normalizedTimeout =
      typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
    this.timeoutMs = Math.max(MIN_TIMEOUT_MS, normalizedTimeout);
    this.path = options.path?.startsWith('/') ? options.path : DEFAULT_PATH;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.fallback = options.fallback;
  }

  static fromEnv(): IntentServiceClassifier {
    const baseUrl = process.env.INTENT_SERVICE_URL?.trim();
    if (!baseUrl) {
      throw new IntentClassifierError('intent_classifier_configuration', 'INTENT_SERVICE_URL missing');
    }
    const apiKey = process.env.INTENT_SERVICE_API_KEY?.trim() || undefined;
    const timeoutRaw = process.env.INTENT_SERVICE_TIMEOUT_MS?.trim();
    const timeoutMs = timeoutRaw ? Number.parseInt(timeoutRaw, 10) : undefined;
    const path = process.env.INTENT_SERVICE_PATH?.trim();
    const fallback =
      process.env.INTENT_SERVICE_FALLBACK === 'stub' ? new StubIntentClassifier() : undefined;
    return new IntentServiceClassifier({
      baseUrl,
      apiKey,
      timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : undefined,
      path,
      fallback,
    });
  }

  async classify(input: IntentClassificationInput): Promise<IntentClassificationResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${this.path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({
          text: input.transcript,
          lang: input.lang ?? null,
          callId: input.callId,
          patientId: input.patientId ?? null,
          correlationId: input.correlationId ?? null,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new IntentClassifierError(
          'intent_classifier_unavailable',
          `intent classifier responded with ${response.status}`,
          { status: response.status },
        );
      }

      const data = (await response.json()) as { intent?: string; confidence?: number | null };
      const intent = typeof data.intent === 'string' ? data.intent.trim() : '';
      if (!intent) {
        throw new IntentClassifierError('intent_classifier_invalid_response', 'intent classifier response missing intent', data);
      }
      const confidence =
        typeof data.confidence === 'number' && Number.isFinite(data.confidence) ? data.confidence : undefined;
      return {
        intent,
        confidence,
      };
    } catch (error) {
      if (error instanceof IntentClassifierError) {
        if (this.fallback) {
          return this.fallback.classify(input);
        }
        throw error;
      }
      if ((error as Error)?.name === 'AbortError') {
        const timeoutError = new IntentClassifierError('intent_classifier_timeout', 'intent classifier timed out', error);
        if (this.fallback) {
          return this.fallback.classify(input);
        }
        throw timeoutError;
      }
      if (this.fallback) {
        return this.fallback.classify(input);
      }
      throw new IntentClassifierError('intent_classifier_unavailable', 'intent classifier request failed', error);
    } finally {
      clearTimeout(timeout);
    }
  }
}

