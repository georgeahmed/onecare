import { createHash } from 'node:crypto';
import type { GuidedHelpSessionRequest, GuidedHelpSessionResponse } from '@onecare/events';
import { logger, createHistogram } from '@onecare/observability';
import { callWithGuard, type GuardOptions } from './callWithGuard';
import { buildGuidedHelpStubResponse } from '../../application/guidedHelp.stub';
import { buildSystemPrompt, buildStepDeveloperPrompt, type GuidedHelpPurpose } from '../../application/guidedHelp.prompts';
import { validateGuidedHelpSessionResponse } from '../../application/validator';

const llmLatencyHistogram = createHistogram('guided_help_llm_duration_ms');
const FALLBACK_MAX_CONVERSATION = 12;
const MAX_USER_TEXT_LENGTH = 512;
const MAX_SEED_LENGTH = 1_200;
const UNSAFE_PATTERNS = [
  /prescrib/i,
  /antibiotic/i,
  /ibuprofen/i,
  /paracetamol/i,
  /acetaminophen/i,
  /aspirin/i,
  /dose/i,
  /dosage/i,
  /take\s+\d+/i,
  /medication/i,
  /treatment/i,
  /diagnos/i,
  /call\s+911/i,
  /call\s+999/i,
  /go to the er/i,
  /\bER\b/,
  /emergency room/i,
  /\bhttp(s)?:\/\//i,
  /\+?\d[\d()\s.-]{7,}\d/,
  /email/i,
];

function normalizeUrl(raw: string): URL {
  const parsed = new URL(raw.trim());
  if (parsed.protocol !== 'https:') {
    throw new Error('LLM endpoint must use HTTPS');
  }
  return parsed;
}

function scrubText(text: string, maxLength: number): string {
  const normalized = text.normalize('NFKC').replace(/[\u0000-\u001F\u007F]/g, ' ');
  const collapsed = normalized.replace(/\s+/g, ' ').trim();
  const bounded = collapsed.slice(0, maxLength);
  const withoutEmails = bounded.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '<redacted-email>');
  const withoutPhones = withoutEmails.replace(/\+?\d[\d()\s.-]{7,}\d/g, '<redacted-phone>');
  const withoutUrls = withoutPhones.replace(/https?:\/\/\S+/gi, '<redacted-url>');
  return withoutUrls;
}

function sanitizeConversation(
  request: GuidedHelpSessionRequest,
): NonNullable<GuidedHelpSessionRequest['conversation']> {
  const original = request.conversation ?? [];
  const trimmed = original.slice(-FALLBACK_MAX_CONVERSATION);
  return trimmed.map((item) => ({
    role: item.role,
    text: scrubText(typeof item.text === 'string' ? item.text : '', MAX_USER_TEXT_LENGTH),
    fieldTags: item.fieldTags,
    createdAt: item.createdAt,
    sequence: item.sequence,
  }));
}

function hashConversation(conversation: NonNullable<GuidedHelpSessionRequest['conversation']>): string {
  const hash = createHash('sha256');
  for (const item of conversation) {
    hash.update(item.role);
    hash.update('\u0000');
    hash.update(item.text ?? '');
    if (Array.isArray(item.fieldTags)) {
      hash.update(item.fieldTags.join('|'));
    }
  }
  return hash.digest('hex');
}

function isContentSafe(response: GuidedHelpSessionResponse): boolean {
  const fields: string[] = [];
  if (response.question) fields.push(response.question);
  if (response.rationale) fields.push(response.rationale);
  if (response.summary) fields.push(response.summary);
  if (Array.isArray(response.bullets)) fields.push(...response.bullets);
  if (Array.isArray(response.limitations)) fields.push(...response.limitations);
  const text = fields.join(' ').toLowerCase();
  if (!text) return true;
  return !UNSAFE_PATTERNS.some((pattern) => pattern.test(text));
}

export interface GuidedHelpLLMOptions extends GuardOptions {
  purpose: GuidedHelpPurpose;
  correlationId?: string;
}

export interface GuidedHelpLLMInput {
  request: GuidedHelpSessionRequest;
  missingFields: ('onset' | 'location' | 'severity' | 'otherSymptoms')[];
  maxSteps: number;
}

async function callOpenAiForStep(
  input: GuidedHelpLLMInput,
  correlationId: string | undefined,
  signal: AbortSignal,
): Promise<GuidedHelpSessionResponse> {
  const apiKey = (process.env.LLM_API_KEY ?? '').trim();
  const endpoint = (process.env.LLM_API_ENDPOINT ?? 'https://api.openai.com/v1').trim();
  const model = (process.env.LLM_MODEL ?? 'gpt-4o').trim();

  if (!apiKey) {
    logger.warn('guided_help.llm.missing_api_key', {
      correlationId,
    });
    return buildGuidedHelpStubResponse(input.request);
  }

  let url: string;
  try {
    const parsed = normalizeUrl(endpoint);
    parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/chat/completions`;
    url = parsed.toString();
  } catch (error) {
    logger.warn('guided_help.llm.invalid_endpoint', {
      correlationId,
      reason: error instanceof Error ? error.message : String(error),
    });
    return buildGuidedHelpStubResponse(input.request);
  }

  const sanitizedConversation = sanitizeConversation(input.request);
  const safeSeed = scrubText(typeof input.request.seedNarrative === 'string' ? input.request.seedNarrative : '', MAX_SEED_LENGTH);
  const systemPrompt = buildSystemPrompt(input.request.locale);
  const developerPrompt = buildStepDeveloperPrompt({
    request: { ...input.request, seedNarrative: safeSeed, conversation: sanitizedConversation },
    missingFields: input.missingFields,
    maxSteps: input.maxSteps,
  });

  const userPayload = {
    stepId: input.request.stepId,
    locale: input.request.locale,
    missingFields: input.missingFields,
    seedNarrative: safeSeed,
    conversation: sanitizedConversation,
    conversationDigest: hashConversation(sanitizedConversation),
  };

  const messages = [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: `${developerPrompt}\n\nInput JSON:\n${JSON.stringify(userPayload)}`,
    },
  ];

  try {
    // Use fetch when available; fall back to stub if not present.
    // eslint-disable-next-line no-undef
    if (typeof fetch !== 'function') {
      logger.warn('guided_help.llm.fetch_unavailable', { correlationId });
      return buildGuidedHelpStubResponse(input.request);
    }

    // eslint-disable-next-line no-undef
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.2,
        top_p: 0.9,
        max_tokens: 512,
      }),
      signal,
    });

    if (!response.ok) {
      logger.warn('guided_help.llm.openai_error', {
        correlationId,
        status: response.status,
      });
      return buildGuidedHelpStubResponse(input.request);
    }

    const body = await response.json();
    const firstChoice = body?.choices?.[0]?.message?.content;
    if (!firstChoice || typeof firstChoice !== 'string') {
      logger.warn('guided_help.llm.invalid_content', { correlationId });
      return buildGuidedHelpStubResponse(input.request);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(firstChoice);
    } catch (error) {
      logger.warn('guided_help.llm.json_parse_failed', {
        correlationId,
        reason: error instanceof Error ? error.message : String(error),
      });
      return buildGuidedHelpStubResponse(input.request);
    }

    const candidate = parsed as Partial<GuidedHelpSessionResponse>;
    const validation = validateGuidedHelpSessionResponse(candidate);
    if (validation.ok !== true) {
      logger.warn('guided_help.llm.response_validation_failed', {
        correlationId,
        errors: validation.errors.slice(0, 5),
      });
      return buildGuidedHelpStubResponse(input.request);
    }

    const responseBody: GuidedHelpSessionResponse = {
      ...candidate,
      sessionId: candidate.sessionId ?? input.request.sessionId,
      stepId: candidate.stepId ?? input.request.stepId,
      redFlags: candidate.redFlags ?? ['none'],
      proceedToSummary: candidate.proceedToSummary ?? false,
      needsStep6: candidate.needsStep6 ?? false,
      telemetryMeta: {
        ...(candidate.telemetryMeta ?? {}),
        llmProvider: 'openai',
        llmModel: model,
      },
    } as GuidedHelpSessionResponse;

    if (!isContentSafe(responseBody)) {
      logger.warn('guided_help.llm.content_rejected', { correlationId });
      return buildGuidedHelpStubResponse(input.request);
    }

    return responseBody;
  } catch (error) {
    if (signal.aborted) {
      const abortError = Object.assign(new Error('guided_help_llm_timeout'), { code: 'timeout' });
      throw abortError;
    }
    logger.warn('guided_help.llm.call_failed', {
      correlationId,
      reason: error instanceof Error ? error.message : String(error),
    });
    return buildGuidedHelpStubResponse(input.request);
  }
}

export async function callGuidedHelpLLM(
  input: GuidedHelpLLMInput,
  options: GuidedHelpLLMOptions,
): Promise<GuidedHelpSessionResponse> {
  const { purpose, correlationId, ...guard } = options;
  const mode = (process.env.GUIDED_HELP_LLM_MODE ?? 'stub').trim().toLowerCase();
  const start = Date.now();

  const result = await callWithGuard(
    `guidedHelp.llm.${purpose}`,
    async (signal) => {
      if (mode === 'stub') {
        return buildGuidedHelpStubResponse(input.request);
      }

      if (mode === 'openai') {
        return callOpenAiForStep(input, correlationId, signal);
      }

      logger.warn('guided_help.llm.unconfigured_mode', {
        mode,
        correlationId,
      });
      return buildGuidedHelpStubResponse(input.request);
    },
    {
      timeoutMs: guard.timeoutMs ?? 2_000,
      maxRetries: guard.maxRetries ?? 2,
      baseDelayMs: guard.baseDelayMs ?? 100,
      correlationId,
      cbFailureThreshold: guard.cbFailureThreshold,
      cbCooldownMs: guard.cbCooldownMs,
      now: guard.now,
      sleep: guard.sleep,
      random: guard.random,
    },
  );

  const durationMs = Date.now() - start;
  llmLatencyHistogram.record(durationMs, {
    purpose,
  });
  logger.info('guided_help.llm.call', {
    purpose,
    mode,
    durationMs,
    correlationId,
  });

  return result;
}
