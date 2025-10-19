import { performance } from 'node:perf_hooks';
import { loadConfig, type ResolvedConfig } from '@onecare/config';
import { BaseState } from '@onecare/statekit';
import { logger, ensureTracing, createCounter, createHistogram, startSpan } from '@onecare/observability';
import { SpanStatusCode } from '@opentelemetry/api';
import {
  Topics,
  createEnvelope,
  validateCallTranscribed,
  validateIntentClassified,
  type ContractValidationError,
  type TriageInput,
} from '@onecare/events';
import {
  executeWithIdempotency,
  reserveIdempotency,
  releaseIdempotency,
  type IdempotencyStore,
} from '@onecare/ports';
import { withMessageGuards } from '@onecare/bus';
import type { MessageBus } from '@onecare/bus';
import {
  buildCallTranscribed,
  type TranscriptionResponse,
  type DiarizationSegment,
  AsrClientError,
} from '../adapters/asr.client';
import {
  buildIntentClassifiedEvent,
  IntentClassifierError,
  type IntentClassificationResult,
} from '../adapters/intent.classifier';
import { IntentClassifierClient } from '../adapters/intent.classifier.client';
import { queuePromptForCall } from '../adapters/ivr.prompts';
import { executeEmergencyHandoff } from '../adapters/emergency.handoff';
import type {
  TelephonyContext,
  TelephonyEvent,
  IntentClassificationInput,
  IntentRoutingDecision,
  IntentRouteTarget,
  CallbackPriority,
  CallbackWindowOptions,
  LanguagePromptSelection,
  EmergencyHandoffDetails,
} from './types';
import { TelephonyContractError } from './errors';

ensureTracing('telephony');

const DEFAULT_LANGUAGE_CODE = 'en';

interface LanguagePromptConfig {
  intro?: string;
  confirm?: string;
  fallbackOption?: string;
  options: Record<string, string>;
}

interface AccessibilityLanguageSettings {
  languages: string[];
  prompts: LanguagePromptConfig;
}

const DEFAULT_LANGUAGE_PROMPT_CONFIG: LanguagePromptConfig = {
  intro: 'ivr.prompt.language.select',
  options: {
    [DEFAULT_LANGUAGE_CODE]: 'ivr.prompt.language.option.en',
  },
  fallbackOption: 'ivr.prompt.language.option.en',
};

const DEFAULT_ACCESSIBILITY_SETTINGS: AccessibilityLanguageSettings = {
  languages: [DEFAULT_LANGUAGE_CODE],
  prompts: DEFAULT_LANGUAGE_PROMPT_CONFIG,
};

const accessibilitySettingsCache = new Map<string, AccessibilityLanguageSettings>();
const DEFAULT_TELEPHONY_IDEMPOTENCY_TTL_SECONDS = 15 * 60;

const TELEPHONY_ALLOWED_TOPICS = new Set<string>([
  Topics.telephony.callTranscribed,
  Topics.telephony.intentClassified,
  Topics.triage.input,
]);

const telephonyIdempotencyHitCounter = createCounter('telephony.idempotency.hit');
const telephonyIdempotencyMissCounter = createCounter('telephony.idempotency.miss');
const telephonyPipelineDuration = createHistogram('telephony.pipeline_duration_ms');
const telephonyAsrLatency = createHistogram('telephony.asr.latency_ms');
const telephonyAsrCalls = createCounter('telephony.asr.calls');
const telephonyIntentCalls = createCounter('telephony.intent.calls');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normaliseLanguageCode(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  return trimmed.toLowerCase();
}

function parseLanguageList(raw: unknown): string[] | undefined {
  if (!raw) return undefined;
  if (Array.isArray(raw)) {
    const parsed = raw
      .map((entry) => normaliseLanguageCode(entry))
      .filter((entry): entry is string => Boolean(entry));
    return parsed.length > 0 ? parsed : undefined;
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return undefined;
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parseLanguageList(parsed);
      }
    } catch {
      // fall through to comma parsing
    }
    const split = trimmed
      .split(',')
      .map((entry) => normaliseLanguageCode(entry))
      .filter((entry): entry is string => Boolean(entry));
    return split.length > 0 ? split : undefined;
  }
  return undefined;
}

function ensureLanguageFallback(languages: string[] | undefined): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  const source = Array.isArray(languages) && languages.length > 0 ? languages : DEFAULT_ACCESSIBILITY_SETTINGS.languages;
  for (const code of source) {
    const normalized = normaliseLanguageCode(code);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  if (!seen.has(DEFAULT_LANGUAGE_CODE)) {
    result.unshift(DEFAULT_LANGUAGE_CODE);
  }
  return result;
}

function clonePromptConfig(config: LanguagePromptConfig): LanguagePromptConfig {
  return {
    intro: config.intro,
    confirm: config.confirm,
    fallbackOption: config.fallbackOption,
    options: { ...config.options },
  };
}

function cloneAccessibilitySettings(settings: AccessibilityLanguageSettings): AccessibilityLanguageSettings {
  return {
    languages: [...settings.languages],
    prompts: clonePromptConfig(settings.prompts),
  };
}

function resolveTelephonyIdempotencyTtl(ctx: TelephonyContext): number {
  const ttl = ctx.idempotencyTtlSeconds;
  return typeof ttl === 'number' && Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_TELEPHONY_IDEMPOTENCY_TTL_SECONDS;
}

function deriveTelephonyPipelineIdempotencyKey(ctx: TelephonyContext, callId: string): string {
  return ctx.pipelineIdempotencyKey ?? `telephony:call:${callId}`;
}

function deriveCallTranscribedIdempotencyKey(ctx: TelephonyContext, callId: string): string {
  if (ctx.callTranscribedIdempotencyKey) {
    return ctx.callTranscribedIdempotencyKey;
  }
  const base = deriveTelephonyPipelineIdempotencyKey(ctx, callId);
  return `${base}:call-transcribed`;
}

function deriveIntentClassifiedIdempotencyKey(ctx: TelephonyContext, callId: string): string {
  if (ctx.intentClassifiedIdempotencyKey) {
    return ctx.intentClassifiedIdempotencyKey;
  }
  const base = deriveTelephonyPipelineIdempotencyKey(ctx, callId);
  return `${base}:intent-classified`;
}

function deriveTriagePublishIdempotencyKey(ctx: TelephonyContext, callId: string, patientId?: string | null): string {
  const patient = patientId ?? ctx.patientId ?? 'unknown-patient';
  if (ctx.triagePublishIdempotencyKey) {
    return ctx.triagePublishIdempotencyKey;
  }
  const base = deriveTelephonyPipelineIdempotencyKey(ctx, callId);
  return `${base}:triage-input:${patient}`;
}

function ensureTelephonyBus(ctx: TelephonyContext): MessageBus {
  if (!ctx.bus) {
    throw new Error('message_bus_missing');
  }
  const guarded = withMessageGuards(ctx.bus, { allowedTopics: TELEPHONY_ALLOWED_TOPICS });
  ctx.bus = guarded;
  return guarded;
}

async function releasePipelineReservation(
  ctx: TelephonyContext,
  reason: string,
  error?: unknown,
): Promise<void> {
  if (!ctx.idempotencyStore || !ctx.pipelineIdempotencyKey || !ctx.pipelineIdempotencyReserved) {
    return;
  }
  try {
    const store = ctx.idempotencyStore;
    const key = ctx.pipelineIdempotencyKey;
    let released = false;
    if (typeof releaseIdempotency === 'function') {
      try {
        await releaseIdempotency(store, key);
        released = true;
      } catch (fallbackError) {
        const message = fallbackError instanceof Error ? fallbackError.message : '';
        if (!message.includes('releaseIdempotency')) {
          throw fallbackError;
        }
      }
    }

    if (!released) {
      if (typeof store.delete === 'function') {
        await store.delete(key);
      } else {
        await store.put(key, 0);
      }
    }

    ctx.pipelineIdempotencyReserved = false;
    logger.warn('telephony.idempotency.released', {
      callId: ctx.callId,
      correlationId: ctx.correlationId,
      reason,
    });
  } catch (releaseError) {
    logger.error('telephony.idempotency.release_failed', {
      callId: ctx.callId,
      correlationId: ctx.correlationId,
      reason,
      error: releaseError instanceof Error ? releaseError.message : String(releaseError),
      originalError: error instanceof Error ? error.message : String(error ?? ''),
    });
  }
}

function normalizeCorrelationId(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function ensureCorrelationId(ctx: TelephonyContext): string | undefined {
  const normalized = normalizeCorrelationId(ctx.correlationId);
  ctx.correlationId = normalized;
  return normalized;
}

function raiseContractValidationError(
  stage: 'call_transcribed' | 'intent_classified',
  callId: string,
  correlationId: string | undefined,
  errors: ContractValidationError[],
): never {
  const safeErrors = errors.map((error) => ({
    path: error.path,
    keyword: error.keyword,
    message: error.message,
  }));
  logger.error(`telephony.${stage}.validation_failed`, {
    callId,
    correlationId,
    errorCount: safeErrors.length,
    errors: safeErrors,
  });
  const code: TelephonyContractError['code'] =
    stage === 'call_transcribed' ? 'call_transcribed_invalid' : 'intent_classified_invalid';
  throw new TelephonyContractError(code, `${stage} payload failed validation`, safeErrors);
}

function mergePromptConfig(base: LanguagePromptConfig, override?: LanguagePromptConfig): LanguagePromptConfig {
  if (!override) {
    return clonePromptConfig(base);
  }
  const merged = clonePromptConfig(base);
  if (override.intro) {
    merged.intro = override.intro.trim();
  }
  if (override.confirm) {
    merged.confirm = override.confirm.trim();
  }
  if (override.fallbackOption) {
    merged.fallbackOption = override.fallbackOption.trim();
  }
  if (override.options) {
    for (const [code, value] of Object.entries(override.options)) {
      const normalizedCode = normaliseLanguageCode(code);
      const trimmedValue = typeof value === 'string' ? value.trim() : undefined;
      if (!normalizedCode || !trimmedValue) continue;
      merged.options[normalizedCode] = trimmedValue;
    }
  }
  return merged;
}

function parsePromptConfig(raw: unknown): LanguagePromptConfig | undefined {
  if (!isRecord(raw)) return undefined;
  const options: Record<string, string> = {};
  const rawOptions = raw.options;
  if (isRecord(rawOptions)) {
    for (const [code, value] of Object.entries(rawOptions)) {
      const normalizedCode = normaliseLanguageCode(code);
      if (!normalizedCode || typeof value !== 'string') continue;
      const trimmedValue = value.trim();
      if (trimmedValue) {
        options[normalizedCode] = trimmedValue;
      }
    }
  }
  const intro =
    typeof raw.intro === 'string' && raw.intro.trim().length > 0 ? raw.intro.trim() : undefined;
  const confirm =
    typeof raw.confirm === 'string' && raw.confirm.trim().length > 0 ? raw.confirm.trim() : undefined;
  let fallbackOption: string | undefined;
  const fallbackRaw = (raw as Record<string, unknown>).fallbackOption ?? (raw as Record<string, unknown>).fallback_option;
  if (typeof fallbackRaw === 'string' && fallbackRaw.trim().length > 0) {
    fallbackOption = fallbackRaw.trim();
  }
  if (!intro && !confirm && Object.keys(options).length === 0 && !fallbackOption) {
    return undefined;
  }
  return {
    intro,
    confirm,
    fallbackOption,
    options,
  };
}

function parsePromptConfigFromEnv(raw: string | undefined): LanguagePromptConfig | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return parsePromptConfig(parsed);
  } catch {
    return undefined;
  }
}

function parseLanguageListFromEnv(): string[] | undefined {
  const candidates = [
    process.env.TELEPHONY_IVR_LANGUAGES,
    process.env.NHS_GP_ACCESSIBILITY_AND_LANGUAGE_INTERPRETER_LANGUAGES,
  ];
  for (const candidate of candidates) {
    const parsed = parseLanguageList(candidate);
    if (parsed && parsed.length > 0) {
      return parsed;
    }
  }
  return undefined;
}

function resolvePromptOptions(config: LanguagePromptConfig): LanguagePromptConfig {
  const cloned = clonePromptConfig(config);
  if (!cloned.options[DEFAULT_LANGUAGE_CODE]) {
    cloned.options[DEFAULT_LANGUAGE_CODE] =
      DEFAULT_LANGUAGE_PROMPT_CONFIG.options[DEFAULT_LANGUAGE_CODE];
  }
  if (!cloned.fallbackOption) {
    cloned.fallbackOption =
      cloned.options[DEFAULT_LANGUAGE_CODE] ?? DEFAULT_LANGUAGE_PROMPT_CONFIG.fallbackOption;
  }
  if (!cloned.intro) {
    cloned.intro = DEFAULT_LANGUAGE_PROMPT_CONFIG.intro;
  }
  return cloned;
}

function getAccessibilityLanguageSettings(practiceId: string): AccessibilityLanguageSettings {
  const cached = accessibilitySettingsCache.get(practiceId);
  if (cached) {
    return cloneAccessibilitySettings(cached);
  }

  let languages = ensureLanguageFallback(DEFAULT_ACCESSIBILITY_SETTINGS.languages);
  let prompts = clonePromptConfig(DEFAULT_LANGUAGE_PROMPT_CONFIG);

  try {
    const resolved: ResolvedConfig = loadConfig(practiceId);
    const section = (resolved as Record<string, unknown>).accessibility_and_language;
    if (isRecord(section)) {
      const configLanguages = parseLanguageList(section.interpreter_languages);
      if (configLanguages && configLanguages.length > 0) {
        languages = ensureLanguageFallback(configLanguages);
      }
      const configPrompts = parsePromptConfig(section.ivr_prompt_keys);
      if (configPrompts) {
        prompts = mergePromptConfig(prompts, configPrompts);
      }
    }
  } catch (error) {
    logger.warn('telephony.language.config_load_failed', {
      practiceId,
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  const envLanguages = parseLanguageListFromEnv();
  if (envLanguages && envLanguages.length > 0) {
    languages = ensureLanguageFallback(envLanguages);
  }

  const promptEnvCandidates = [
    parsePromptConfigFromEnv(process.env.NHS_GP_ACCESSIBILITY_AND_LANGUAGE_IVR_PROMPT_KEYS),
    parsePromptConfigFromEnv(process.env.TELEPHONY_IVR_PROMPT_KEYS),
  ];
  for (const override of promptEnvCandidates) {
    if (override) {
      prompts = mergePromptConfig(prompts, override);
    }
  }

  prompts = resolvePromptOptions(prompts);
  const settings: AccessibilityLanguageSettings = {
    languages,
    prompts,
  };
  accessibilitySettingsCache.set(practiceId, cloneAccessibilitySettings(settings));
  return cloneAccessibilitySettings(settings);
}

function resolvePracticeId(ctx: TelephonyContext): string {
  const ctxId = ctx.metadata?.practiceId?.trim();
  if (ctxId) return ctxId;
  const envId =
    process.env.TELEPHONY_PRACTICE_ID?.trim() ||
    process.env.PRACTICE_ID?.trim();
  if (envId) return envId;
  return 'nhs_gp_defaults';
}

interface AsrFeatureFlags {
  langDetect: boolean;
  diarization: boolean;
}

function resolveAsrFeatureFlags(ctx: TelephonyContext): AsrFeatureFlags {
  let langDetect = false;
  let diarization = false;
  const practiceId = resolvePracticeId(ctx);
  try {
    const resolved: ResolvedConfig = loadConfig(practiceId);
    const telephonyConfig = (resolved as Record<string, unknown>).telephony;
    if (isRecord(telephonyConfig)) {
      const asrConfig = isRecord(telephonyConfig.asr) ? (telephonyConfig.asr as Record<string, unknown>) : undefined;
      if (asrConfig) {
        if (typeof asrConfig.lang_detect === 'boolean') {
          langDetect = asrConfig.lang_detect;
        }
        if (typeof asrConfig.diarization === 'boolean') {
          diarization = asrConfig.diarization;
        }
      }
    }
  } catch (error) {
    logger.warn('telephony.asr.feature_config_unavailable', {
      practiceId,
      reason: error instanceof Error ? error.message : 'unknown_error',
    });
  }

  const envLang = parseBooleanFlag(process.env.TELEPHONY_ASR_LANG_DETECT);
  if (envLang !== undefined) {
    langDetect = envLang;
  }
  const envDiarization = parseBooleanFlag(process.env.TELEPHONY_ASR_DIARIZATION);
  if (envDiarization !== undefined) {
    diarization = envDiarization;
  }

  return { langDetect, diarization };
}

function applyAsrFeatureFlags(
  ctx: TelephonyContext,
  transcription: TranscriptionResponse,
  features: AsrFeatureFlags,
): void {
  if (!features.langDetect) {
    transcription.lang = undefined;
  }

  if (features.diarization && Array.isArray(transcription.diarization) && transcription.diarization.length > 0) {
    ctx.diarizationSummary = transcription.diarization.map((segment: DiarizationSegment) => ({ ...segment }));
  } else {
    ctx.diarizationSummary = undefined;
    if ('diarization' in transcription) {
      transcription.diarization = undefined;
    }
  }
}

function ensureLanguageOptions(ctx: TelephonyContext): {
  practiceId: string;
  languages: string[];
  prompts: LanguagePromptConfig;
} {
  const practiceId = resolvePracticeId(ctx);
  const settings = getAccessibilityLanguageSettings(practiceId);
  ctx.availableLanguages = [...settings.languages];
  return {
    practiceId,
    languages: settings.languages,
    prompts: settings.prompts,
  };
}

function extractLanguagePreference(ctx: TelephonyContext): string | undefined {
  const explicit = normaliseLanguageCode(ctx.selectedLanguage);
  if (explicit) return explicit;
  const attributes = ctx.metadata?.attributes;
  if (attributes) {
    const candidates = [
      attributes.preferredLanguage,
      attributes.preferred_language,
      attributes.language,
      attributes.lang,
    ];
    for (const entry of candidates) {
      const normalized = normaliseLanguageCode(entry);
      if (normalized) {
        return normalized;
      }
    }
  }
  return undefined;
}

function ensureSelectedLanguage(ctx: TelephonyContext, languages: string[]): string {
  const normalizedLanguages = languages
    .map((code) => normaliseLanguageCode(code))
    .filter((code): code is string => Boolean(code));
  const available = new Set(normalizedLanguages);
  if (!available.has(DEFAULT_LANGUAGE_CODE)) {
    available.add(DEFAULT_LANGUAGE_CODE);
    normalizedLanguages.unshift(DEFAULT_LANGUAGE_CODE);
  }

  const preferred = extractLanguagePreference(ctx);
  if (preferred && available.has(preferred)) {
    ctx.selectedLanguage = preferred;
    return preferred;
  }

  const envDefault = normaliseLanguageCode(process.env.TELEPHONY_IVR_DEFAULT_LANGUAGE);
  if (envDefault && available.has(envDefault)) {
    ctx.selectedLanguage = envDefault;
    return envDefault;
  }

  const fallback = normalizedLanguages.find((code) => available.has(code)) ?? DEFAULT_LANGUAGE_CODE;
  ctx.selectedLanguage = fallback;
  return fallback;
}

function resolveLanguageOptionPrompt(prompts: LanguagePromptConfig, code: string): string {
  const normalized = normaliseLanguageCode(code) ?? DEFAULT_LANGUAGE_CODE;
  const candidate = prompts.options[normalized];
  if (candidate && candidate.trim()) {
    return candidate.trim();
  }
  const fallback =
    prompts.fallbackOption ??
    prompts.options[DEFAULT_LANGUAGE_CODE] ??
    DEFAULT_LANGUAGE_PROMPT_CONFIG.options[DEFAULT_LANGUAGE_CODE];
  return fallback;
}

function resolveIntroPrompt(prompts: LanguagePromptConfig): string | undefined {
  const intro = prompts.intro ?? DEFAULT_LANGUAGE_PROMPT_CONFIG.intro;
  const trimmed = intro?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function sanitizePatientId(raw: string | null | undefined): string | null | undefined {
  if (raw === null) return null;
  if (typeof raw !== 'string') return raw;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

const DEFAULT_INTENT_CONFIDENCE_THRESHOLD = 0.55;
const DEFAULT_CALLBACK_WINDOWS: Record<CallbackPriority, { code: string; label: string }> = {
  stat: { code: 'immediate', label: 'We will connect you immediately.' },
  urgent: { code: 'within_2h', label: 'We can call you back within 2 hours.' },
  soon: { code: 'same_day', label: 'We can call you back later today.' },
  routine: { code: 'within_48h', label: 'We can call you back within 48 hours.' },
};

function normalizeConfidenceThreshold(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    if (raw <= 0) return 0;
    if (raw >= 1) return 1;
    return raw;
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return undefined;
    const parsed = Number.parseFloat(trimmed);
    if (!Number.isFinite(parsed)) return undefined;
    return normalizeConfidenceThreshold(parsed);
  }
  return undefined;
}

function parseBooleanFlag(value: string | undefined): boolean | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) return false;
  return undefined;
}

function resolveIntentConfidenceThreshold(explicit?: number): number {
  const normalized = normalizeConfidenceThreshold(explicit);
  if (normalized !== undefined) return normalized;
  const env = normalizeConfidenceThreshold(process.env.TELEPHONY_INTENT_CONFIDENCE_THRESHOLD);
  if (env !== undefined) return env;
  return DEFAULT_INTENT_CONFIDENCE_THRESHOLD;
}

function ensureIntentConfidenceThreshold(ctx: TelephonyContext): number {
  const resolved = resolveIntentConfidenceThreshold(ctx.intentConfidenceThreshold);
  ctx.intentConfidenceThreshold = resolved;
  return resolved;
}

function ensureEmergencyTransferEnabled(ctx: TelephonyContext): boolean {
  if (typeof ctx.emergencyTransferEnabled === 'boolean') {
    return ctx.emergencyTransferEnabled;
  }
  const envOverride = parseBooleanFlag(process.env.TELEPHONY_EMERGENCY_TRANSFER_ENABLED);
  if (envOverride !== undefined) {
    ctx.emergencyTransferEnabled = envOverride;
    return envOverride;
  }
  const configDefault = parseBooleanFlag(process.env.NHS_GP_TELEPHONY_EMERGENCY_TRANSFER_ENABLED);
  const resolved = configDefault !== undefined ? configDefault : true;
  ctx.emergencyTransferEnabled = resolved;
  return resolved;
}

async function queuePrompt(ctx: TelephonyContext, prompt: string): Promise<void> {
  const sanitized = prompt?.trim();
  if (!sanitized) return;
  ctx.ivrPrompts = ctx.ivrPrompts ?? [];
  ctx.ivrPrompts.push(sanitized);
  if (ctx.enqueuePrompt) {
    await Promise.resolve(ctx.enqueuePrompt(sanitized));
  }
  try {
    await queuePromptForCall(ctx.callId, sanitized);
  } catch (error) {
    logger.warn('telephony.ivr.prompt.dispatch_failed', {
      callId: ctx.callId,
      correlationId: ctx.correlationId,
      reason: (error as Error).message,
    });
  }
}

async function triggerEmergencyHandoff(
  ctx: TelephonyContext,
  reason: string,
  triggeredAt: number,
): Promise<void> {
  const handler = ctx.emergencyHandoff ?? executeEmergencyHandoff;
  const details: EmergencyHandoffDetails = {
    callId: ctx.callId,
    reason,
    triggeredAt,
    correlationId: ctx.correlationId,
    practiceId: ctx.metadata?.practiceId,
    patientId: ctx.patientId ?? null,
    metadata: ctx.metadata?.attributes,
  };
  try {
    await Promise.resolve(handler(details));
    ctx.emergencyHandoffAt = triggeredAt;
    logger.warn('telephony.emergency.handoff.triggered', {
      callId: ctx.callId,
      correlationId: ctx.correlationId,
      practiceId: ctx.metadata?.practiceId,
      reason,
    });
  } catch (error) {
    logger.error('telephony.emergency.handoff.failed', {
      callId: ctx.callId,
      correlationId: ctx.correlationId,
      practiceId: ctx.metadata?.practiceId,
      reason,
      failure: error instanceof Error ? error.message : String(error),
    });
  }
}

type CallbackWindowOverride = { code: string; label?: string };

function parseCallbackWindowOverrides(
  raw: string | undefined,
): Partial<Record<CallbackPriority, CallbackWindowOverride[]>> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const result: Partial<Record<CallbackPriority, CallbackWindowOverride[]>> = {};
    for (const [key, value] of Object.entries(parsed)) {
      const priority = key.trim().toLowerCase() as CallbackPriority;
      if (!['stat', 'urgent', 'soon', 'routine'].includes(priority)) continue;
      const addEntry = (entry: unknown, bucket: CallbackWindowOverride[]): void => {
        if (!entry || typeof entry !== 'object') return;
        const candidate = entry as { code?: string; label?: string };
        const code = candidate.code?.trim();
        if (!code) return;
        bucket.push({ code, label: candidate.label?.trim() || undefined });
      };

      const bucket: CallbackWindowOverride[] = [];
      if (Array.isArray(value)) {
        for (const entry of value) {
          addEntry(entry, bucket);
        }
      } else {
        addEntry(value, bucket);
      }
      if (bucket.length > 0) {
        result[priority] = bucket;
      }
    }
    return result;
  } catch {
    return undefined;
  }
}

function humanizeWindowLabel(code: string): string {
  return code
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function resolveCallbackWindowChoices(ctx: TelephonyContext, priority: CallbackPriority): CallbackWindowOptions[] {
  const overrides = parseCallbackWindowOverrides(process.env.TELEPHONY_CALLBACK_WINDOWS);
  const practiceId = resolvePracticeId(ctx);
  let configEntries: CallbackWindowOverride[] | undefined;
  try {
    const resolved: ResolvedConfig = loadConfig(practiceId);
    const telephonyConfig = (resolved as Record<string, unknown>).telephony;
    if (isRecord(telephonyConfig) && isRecord(telephonyConfig.callback_windows_by_priority)) {
      const priorities = telephonyConfig.callback_windows_by_priority as Record<string, unknown>;
      const priorityConfig = priorities[priority];
      if (Array.isArray(priorityConfig)) {
        const mapped: CallbackWindowOverride[] = [];
        for (const entry of priorityConfig) {
          if (!entry || typeof entry !== 'object') continue;
          const candidate = entry as { code?: string; label?: string };
          const code = candidate.code?.trim();
          if (!code) continue;
          mapped.push({ code, label: candidate.label?.trim() || undefined });
        }
        if (mapped.length > 0) {
          configEntries = mapped;
        }
      }
    }
  } catch (error) {
    logger.warn('telephony.callback_window.config_unavailable', {
      practiceId,
      reason: error instanceof Error ? error.message : 'unknown_error',
    });
  }

  const defaultEntry: CallbackWindowOverride = {
    code: DEFAULT_CALLBACK_WINDOWS[priority].code,
    label: DEFAULT_CALLBACK_WINDOWS[priority].label,
  };
  const baseEntries = overrides?.[priority] ?? configEntries ?? [defaultEntry];
  const seen = new Set<string>();
  return baseEntries
    .map((entry) => {
      const code = entry.code.trim();
      if (!code) return null;
      if (seen.has(code)) return null;
      seen.add(code);
      const label = entry.label?.trim() || humanizeWindowLabel(code);
      return {
        priority,
        windowCode: code,
        windowLabel: label,
      } satisfies CallbackWindowOptions;
    })
    .filter((entry): entry is CallbackWindowOptions => Boolean(entry));
}

function ensureCallbackWindowOptions(ctx: TelephonyContext, priority: CallbackPriority): CallbackWindowOptions {
  const choices = resolveCallbackWindowChoices(ctx, priority);
  ctx.callbackWindowChoices = choices;
  const selected = choices[0] ?? {
    priority,
    windowCode: DEFAULT_CALLBACK_WINDOWS[priority].code,
    windowLabel: DEFAULT_CALLBACK_WINDOWS[priority].label,
  };
  ctx.callbackWindowOptions = selected;
  return selected;
}

interface IntentRouteResult {
  target: IntentRouteTarget;
  reason: string;
  triageInput?: TriageInput;
}

const INTENT_ROUTE_TABLE: Record<string, IntentRouteTarget> = {
  'telephony.emergency': 'emergency',
  'telephony.medication': 'pharmacy',
  'telephony.billing': 'billing',
  'telephony.appointment': 'admin',
  'telephony.test.results': 'admin',
};

function buildTriageNarrative(intent: string, transcript: string): string {
  const summaryIntent = intent.replace(/^telephony\./, '').replace(/_/g, ' ');
  const trimmed = transcript.trim();
  if (trimmed) return trimmed;
  return `Caller reported intent: ${summaryIntent}`;
}

function buildTriageInput(
  intent: string,
  transcript: string,
  patientId: string | null | undefined,
  confidence?: number,
): TriageInput | undefined {
  if (!patientId) return undefined;
  const narrative = buildTriageNarrative(intent, transcript);
  const features: Record<string, string | number | boolean | null> = {
    channel: 'telephony',
    intent,
  };
  if (typeof confidence === 'number' && Number.isFinite(confidence)) {
    features.confidence = Number.parseFloat(confidence.toFixed(3));
  }
  return {
    patientId,
    narrative,
    features,
  };
}

function mapIntentToRoute(
  intent: string,
  transcript: string,
  patientId: string | null | undefined,
  confidence?: number,
): IntentRouteResult {
  const normalizedIntent = intent || 'telephony.callback';
  const target = INTENT_ROUTE_TABLE[normalizedIntent] ?? 'triage';
    if (target === 'triage') {
      const triageInput = buildTriageInput(normalizedIntent, transcript, patientId, confidence);
      return {
        target,
        reason: 'triage_pipeline',
        triageInput,
      };
    }
  if (target === 'emergency') {
    return {
      target,
      reason: 'emergency_transfer',
    };
  }
  const reasonMap: Record<IntentRouteTarget, string> = {
    admin: 'admin_routing',
    pharmacy: 'pharmacy_routing',
    billing: 'billing_support',
    triage: 'triage_pipeline',
    emergency: 'emergency_transfer',
  };
  return {
    target,
    reason: reasonMap[target] ?? 'routing',
  };
}

function determineCallbackPriority(ctx: TelephonyContext, confidence?: number): CallbackPriority {
  if (ctx.intentRouteTarget === 'emergency' || ctx.intentRoutingDecision === 'emergency') {
    return 'stat';
  }
  if (typeof confidence === 'number' && Number.isFinite(confidence)) {
    if (confidence >= 0.85) return 'urgent';
    if (confidence >= 0.65) return 'soon';
  }
  return 'routine';
}

function buildIntentClassificationInput(
  payload: { callId: string; transcript: string; lang?: string | null; patientId?: string | null },
  correlationId?: string,
  fallbackLang?: string | null,
  practiceId?: string,
): IntentClassificationInput {
  return {
    callId: payload.callId,
    transcript: payload.transcript,
    lang: payload.lang ?? fallbackLang ?? null,
    patientId: payload.patientId ?? null,
    correlationId,
    practiceId,
  };
}

export class CallReceivedState extends BaseState<TelephonyContext, TelephonyEvent> {
  constructor() {
    super('CallReceived');
  }

  async handle(ctx: TelephonyContext): Promise<string> {
    const callId = ctx.callId?.trim();
    if (!callId) {
      throw new Error('call_id_missing');
    }
    ctx.callId = callId;
    ctx.id = callId;

    const audioRef = ctx.audioRef?.trim();
    if (!audioRef) {
      throw new Error('audio_ref_missing');
    }
    ctx.audioRef = audioRef;

    if (!ctx.asrClient) {
      throw new Error('asr_client_missing');
    }

    if (!ctx.intentClassifier) {
      throw new Error('intent_classifier_missing');
    }

    ctx.pipelineStartedAt = ctx.pipelineStartedAt ?? performance.now();
    const correlationId = ensureCorrelationId(ctx);
    const pipelineKey = deriveTelephonyPipelineIdempotencyKey(ctx, callId);
    ctx.pipelineIdempotencyKey = pipelineKey;
    ctx.callTranscribedIdempotencyKey = ctx.callTranscribedIdempotencyKey ?? `${pipelineKey}:call-transcribed`;
    ctx.intentClassifiedIdempotencyKey = ctx.intentClassifiedIdempotencyKey ?? `${pipelineKey}:intent-classified`;

    const ttlSeconds = resolveTelephonyIdempotencyTtl(ctx);
    ctx.idempotencyTtlSeconds = ttlSeconds;
    const store = ctx.idempotencyStore;

    if (store) {
      try {
        const outcome = await reservePipelineKey(store, pipelineKey, ttlSeconds);
        if (outcome === 'exists') {
          ctx.pipelineDuplicate = true;
          ctx.pipelineIdempotencyReserved = false;
          telephonyIdempotencyHitCounter.add(1, { stage: 'pipeline' });
          logger.info('telephony.idempotency.hit', {
            callId,
            correlationId,
            key: pipelineKey,
          });
        } else {
          ctx.pipelineDuplicate = false;
          ctx.pipelineIdempotencyReserved = true;
          telephonyIdempotencyMissCounter.add(1, { stage: 'pipeline' });
          logger.debug('telephony.idempotency.reserved', {
            callId,
            correlationId,
            key: pipelineKey,
            ttlSeconds,
          });
        }
      } catch (error) {
        logger.error('telephony.idempotency.reserve_failed', {
          callId,
          correlationId,
          key: pipelineKey,
          reason: error instanceof Error ? error.message : 'unknown_error',
        });
        throw new Error('telephony_idempotency_reserve_failed');
      }
    } else {
      ctx.pipelineDuplicate = false;
      ctx.pipelineIdempotencyReserved = false;
    }

    ctx.buildCallTranscribed = ctx.buildCallTranscribed ?? buildCallTranscribed;
    ctx.patientId = sanitizePatientId(ctx.patientId);
    ensureIntentConfidenceThreshold(ctx);
    ensureEmergencyTransferEnabled(ctx);

    if (ctx.metadata?.callerId) {
      ctx.metadata = {
        ...ctx.metadata,
        callerId: ctx.metadata.callerId.trim(),
      };
    }

    const normalizedLang = normaliseLanguageCode(ctx.selectedLanguage);
    ctx.selectedLanguage = normalizedLang ?? DEFAULT_LANGUAGE_CODE;

    return 'LanguageSelection';
  }
}

export class LanguageSelectionState extends BaseState<TelephonyContext, TelephonyEvent> {
  constructor() {
    super('LanguageSelection');
  }

  async handle(ctx: TelephonyContext): Promise<string> {
    const callId = ctx.callId?.trim();
    if (!callId) {
      throw new Error('call_id_missing');
    }

    if (ctx.pipelineDuplicate) {
      logger.info('telephony.idempotency.skip', {
        stage: 'language_selection',
        callId,
        correlationId: ctx.correlationId,
      });
      return 'Transcribed';
    }

    const { practiceId, languages, prompts } = ensureLanguageOptions(ctx);
    const selectedLanguage = ensureSelectedLanguage(ctx, languages);

    const introPrompt = resolveIntroPrompt(prompts);
    const promptKeys: string[] = [];
    if (introPrompt) {
      await queuePrompt(ctx, introPrompt);
      promptKeys.push(introPrompt);
    }

    const selections: LanguagePromptSelection[] = [];
    languages.forEach((code, index) => {
      const promptKey = resolveLanguageOptionPrompt(prompts, code);
      selections.push({
        code,
        promptKey,
        digit: index + 1,
      });
    });

    for (const selection of selections) {
      await queuePrompt(ctx, selection.promptKey);
      promptKeys.push(selection.promptKey);
    }

    ctx.languagePromptSelections = selections;
    ctx.availableLanguages = [...languages];
    logger.info('telephony.ivr.language.prompts', {
      callId,
      practiceId,
      languages,
      selectedLanguage,
      promptKeys,
    });

    return 'Transcribed';
  }
}

export class TranscribedState extends BaseState<TelephonyContext, TelephonyEvent> {
  constructor() {
    super('Transcribed');
  }

  async handle(ctx: TelephonyContext): Promise<string> {
    const callId = ctx.callId?.trim();
    if (!callId) {
      throw new Error('call_id_missing');
    }

    if (ctx.pipelineDuplicate) {
      logger.info('telephony.idempotency.skip', {
        stage: 'transcription',
        callId,
        correlationId: ctx.correlationId,
      });
      return 'IntentClassified';
    }

    const asrClient = ctx.asrClient;
    if (!asrClient) {
      throw new Error('asr_client_missing');
    }

    const audioRef = ctx.audioRef?.trim();
    if (!audioRef) {
      throw new Error('audio_ref_missing');
    }

    try {
      const practiceId = ctx.metadata?.practiceId ?? resolvePracticeId(ctx);
      const languages = ensureLanguageFallback(ctx.availableLanguages);
      const selectedLanguage = ensureSelectedLanguage(ctx, languages);

      const builder = ctx.buildCallTranscribed ?? buildCallTranscribed;
      ctx.buildCallTranscribed = builder;

      const asrSpan = startSpan('telephony.asr.transcribe');
      asrSpan.setAttribute('telephony.call_id', callId);
      asrSpan.setAttribute('telephony.practice_id', practiceId);
      const asrStart = performance.now();
      let transcription: TranscriptionResponse;
      try {
        transcription = await asrClient.transcribe(callId, audioRef);
      } catch (error) {
        const errorCode = error instanceof AsrClientError ? error.code : 'unknown';
        telephonyAsrCalls.add(1, { outcome: 'error', practiceId, error: errorCode });
        if (error instanceof Error) {
          asrSpan.recordException(error);
          asrSpan.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        }
        asrSpan.end();
        throw error;
      }
      const asrDuration = performance.now() - asrStart;
      telephonyAsrLatency.record(asrDuration, { practiceId });
      telephonyAsrCalls.add(1, { outcome: 'ok', practiceId });
      asrSpan.setAttribute('telephony.asr.duration_ms', asrDuration);
      asrSpan.end();

      const asrFeatureFlags = resolveAsrFeatureFlags(ctx);
      applyAsrFeatureFlags(ctx, transcription, asrFeatureFlags);
      ctx.transcription = transcription;

      const payload = builder({
        callId,
        transcription,
        context: ctx.patientId !== undefined ? { patientId: ctx.patientId } : undefined,
      });

      if (!payload.lang && selectedLanguage) {
        payload.lang = selectedLanguage;
      }

      const correlationId = ensureCorrelationId(ctx);
      const validation = validateCallTranscribed(payload);
      if (!validation.ok) {
        raiseContractValidationError('call_transcribed', callId, correlationId, validation.errors);
      }
      const validatedPayload = validation.value;

      ctx.callTranscribed = validatedPayload;

      const envelope = createEnvelope(Topics.telephony.callTranscribed, validatedPayload, correlationId);
      ctx.callTranscribedEnvelope = envelope;
      ctx.intentClassificationInput = buildIntentClassificationInput(
        validatedPayload,
        correlationId,
        selectedLanguage,
        practiceId,
      );
      ensureIntentConfidenceThreshold(ctx);
      ensureEmergencyTransferEnabled(ctx);

      const bus = ensureTelephonyBus(ctx);
      const headers = correlationId ? { 'x-correlation-id': correlationId } : undefined;
      const callIdempotencyKey = deriveCallTranscribedIdempotencyKey(ctx, callId);
      const ttlSeconds = resolveTelephonyIdempotencyTtl(ctx);

      const { status } = await executeWithIdempotency({
        store: ctx.idempotencyStore,
        key: callIdempotencyKey,
        ttlSeconds,
        execute: async () => {
          const publishSpan = startSpan('telephony.publish.call_transcribed');
          publishSpan.setAttribute('telephony.call_id', callId);
          publishSpan.setAttribute('telephony.topic', Topics.telephony.callTranscribed);
          try {
            await bus.publish(Topics.telephony.callTranscribed, envelope, headers);
            publishSpan.end();
          } catch (error) {
            publishSpan.recordException(error as Error);
            publishSpan.setStatus({
              code: SpanStatusCode.ERROR,
              message: error instanceof Error ? error.message : 'publish_failed',
            });
            publishSpan.end();
            logger.error('telephony.call.transcribed.publish_failed', {
              callId,
              correlationId,
              reason: (error as Error).message,
            });
            throw new Error('call_transcribed_publish_failed');
          }

          logger.info('telephony.call.transcribed', {
            callId,
            correlationId,
            lang: validatedPayload.lang ?? undefined,
            patientIdPresent: validatedPayload.patientId != null,
          });
          return true;
        },
        onDuplicate: () => {
          logger.warn('telephony.idempotency.duplicate', {
            stage: 'callTranscribed',
            key: callIdempotencyKey,
            callId,
            correlationId,
          });
        },
        onError: (error) => {
          logger.error('telephony.idempotency.failed', {
            stage: 'callTranscribed',
            key: callIdempotencyKey,
            callId,
            correlationId,
            reason: error instanceof Error ? error.message : 'unknown_error',
          });
        },
      });

      const nowFn = ctx.now ?? Date.now;
      if (status === 'executed') {
        ctx.callTranscribedPublishedAt = nowFn();
      } else {
        ctx.callTranscribedPublishedAt = ctx.callTranscribedPublishedAt ?? nowFn();
      }

      return 'IntentClassified';
    } catch (error) {
      if (typeof ctx.pipelineStartedAt === 'number') {
        telephonyPipelineDuration.record(performance.now() - ctx.pipelineStartedAt, {
          outcome: 'error',
          stage: 'transcription',
        });
        ctx.pipelineStartedAt = undefined;
      }
      await releasePipelineReservation(ctx, 'transcription_failed', error);
      throw error;
    }
  }
}

export class IntentClassifiedState extends BaseState<TelephonyContext, TelephonyEvent> {
  constructor() {
    super('IntentClassified');
  }

  async handle(ctx: TelephonyContext): Promise<string> {
    const callId = ctx.callId?.trim() ?? ctx.intentClassificationInput?.callId ?? 'unknown-call';
    const correlationId = ensureCorrelationId(ctx);

    if (ctx.pipelineDuplicate) {
      if (typeof ctx.pipelineStartedAt === 'number') {
        telephonyPipelineDuration.record(performance.now() - ctx.pipelineStartedAt, {
          outcome: 'duplicate',
        });
        ctx.pipelineStartedAt = undefined;
      }
      logger.info('telephony.idempotency.skip', {
        stage: 'intent_classification',
        callId,
        correlationId,
      });
      return 'Routed';
    }

    const input = ctx.intentClassificationInput;
    if (!input) {
      throw new Error('intent_input_missing');
    }

    const practiceId = ctx.metadata?.practiceId ?? resolvePracticeId(ctx);
    let classificationOutcome: 'ok' | 'error' | null = null;

    const intentClassifier = ctx.intentClassifier;
    if (!intentClassifier) {
      throw new Error('intent_classifier_missing');
    }

    const bus = ensureTelephonyBus(ctx);

    try {
      const classifierClient = new IntentClassifierClient({ classifier: intentClassifier });
      const intentSpan = startSpan('telephony.intent.classify');
      intentSpan.setAttribute('telephony.call_id', input.callId);
      intentSpan.setAttribute('telephony.practice_id', practiceId);
      let result: IntentClassificationResult;
      try {
        result = await classifierClient.classify({
          ...input,
          practiceId,
        });
      } catch (error) {
        const errorCode = error instanceof IntentClassifierError ? error.code : 'unknown';
        telephonyIntentCalls.add(1, { outcome: 'error', practiceId, error: errorCode });
        classificationOutcome = 'error';
        if (error instanceof Error) {
          intentSpan.recordException(error);
          intentSpan.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        }
        intentSpan.end();
        throw error;
      }
      telephonyIntentCalls.add(1, { outcome: 'ok', practiceId, intent: result.intent });
      classificationOutcome = 'ok';
      intentSpan.end();
      ctx.intentClassificationResult = result;


    const payload = buildIntentClassifiedEvent(input, result);
    const validation = validateIntentClassified(payload);
    if (!validation.ok) {
      raiseContractValidationError('intent_classified', input.callId, correlationId, validation.errors);
    }
    const validatedPayload = validation.value;
    ctx.intentClassified = validatedPayload;
    const transcriptText = ctx.transcription?.text ?? '';
    const route = mapIntentToRoute(
      validatedPayload.intent,
      transcriptText,
      ctx.patientId,
      validatedPayload.confidence ?? undefined,
    );
    ctx.intentRouteTarget = route.target;
    ctx.intentRouteReason = route.reason;
    ctx.triageInput = route.triageInput;
    if (route.target === 'triage' && !route.triageInput) {
      logger.warn('telephony.intent.triage_input_missing_patient', {
        callId: input.callId,
        correlationId: ctx.correlationId,
      });
    }
    const threshold = ensureIntentConfidenceThreshold(ctx);

    const confidence =
      typeof validatedPayload.confidence === 'number' && Number.isFinite(validatedPayload.confidence)
        ? validatedPayload.confidence
        : undefined;
    const highConfidence = confidence !== undefined && confidence >= threshold;
    const decision: IntentRoutingDecision = highConfidence ? 'auto' : 'fallback';
    ctx.intentRoutingDecision = decision;
    const emergencyEnabled = ensureEmergencyTransferEnabled(ctx);
    const forcedTransfer = Boolean(ctx.forceEmergencyTransfer);
    const shouldTransfer = emergencyEnabled && (forcedTransfer || !highConfidence);
    ctx.emergencyTransferTriggered = shouldTransfer;
    if (!highConfidence) {
      logger.warn('telephony.intent.low_confidence', {
        callId: input.callId,
        confidence,
        threshold,
        intent: validatedPayload.intent,
        correlationId: ctx.correlationId,
      });
    }
    if (shouldTransfer) {
      ctx.intentRoutingDecision = 'emergency';
      ctx.intentRouteTarget = 'emergency';
      ctx.intentRouteReason = 'emergency_transfer';
      ctx.callbackWindowOptions = ensureCallbackWindowOptions(ctx, 'stat');
      logger.error('telephony.emergency_transfer.queued', {
        callId: input.callId,
        intent: validatedPayload.intent,
        confidence,
        correlationId: ctx.correlationId,
      });
    }
    logger.info('telephony.intent.route', {
      callId: input.callId,
      intent: validatedPayload.intent,
      target: ctx.intentRouteTarget,
      reason: ctx.intentRouteReason,
      triageInput: Boolean(ctx.triageInput),
      correlationId: ctx.correlationId,
    });

    const envelope = createEnvelope(Topics.telephony.intentClassified, validatedPayload, correlationId);
    ctx.intentClassifiedEnvelope = envelope;

    const headers = correlationId ? { 'x-correlation-id': correlationId } : undefined;
    const intentKey = deriveIntentClassifiedIdempotencyKey(ctx, input.callId);
    const ttlSeconds = resolveTelephonyIdempotencyTtl(ctx);
    const nowFn = ctx.now ?? Date.now;

    const { status: intentPublishStatus } = await executeWithIdempotency({
      store: ctx.idempotencyStore,
      key: intentKey,
      ttlSeconds,
      execute: async () => {
        const publishSpan = startSpan('telephony.publish.intent_classified');
        publishSpan.setAttribute('telephony.call_id', input.callId);
        publishSpan.setAttribute('telephony.topic', Topics.telephony.intentClassified);
        try {
          await bus.publish(Topics.telephony.intentClassified, envelope, headers);
          publishSpan.end();
        } catch (error) {
          publishSpan.recordException(error as Error);
          publishSpan.setStatus({
            code: SpanStatusCode.ERROR,
            message: error instanceof Error ? error.message : 'publish_failed',
          });
          publishSpan.end();
          logger.error('telephony.intent.classified.publish_failed', {
            callId: input.callId,
            intent: validatedPayload.intent,
            correlationId,
            reason: (error as Error).message,
          });
          throw new Error('intent_classified_publish_failed');
        }

        logger.info('telephony.intent.classified', {
          callId: input.callId,
          intent: validatedPayload.intent,
          confidence: validatedPayload.confidence,
          correlationId,
        });
        return true;
      },
      onDuplicate: () => {
        logger.warn('telephony.idempotency.duplicate', {
          stage: 'intentClassified',
          key: intentKey,
          callId: input.callId,
          correlationId,
        });
      },
      onError: (error) => {
        logger.error('telephony.idempotency.failed', {
          stage: 'intentClassified',
          key: intentKey,
          callId: input.callId,
          correlationId,
          reason: error instanceof Error ? error.message : 'unknown_error',
        });
      },
    });

    if (intentPublishStatus === 'executed') {
      ctx.intentClassifiedPublishedAt = nowFn();
    } else {
      ctx.intentClassifiedPublishedAt = ctx.intentClassifiedPublishedAt ?? nowFn();
    }

    if (ctx.intentRouteTarget === 'triage' && ctx.triageInput) {
      const triageInput = ctx.triageInput;
      const triageEnvelope = createEnvelope(Topics.triage.input, triageInput, correlationId);
      const triageKey = deriveTriagePublishIdempotencyKey(ctx, input.callId, triageInput.patientId);
      ctx.triagePublishIdempotencyKey = ctx.triagePublishIdempotencyKey ?? triageKey;

      const { status: triageStatus } = await executeWithIdempotency({
        store: ctx.idempotencyStore,
        key: triageKey,
        ttlSeconds,
        execute: async () => {
          const publishSpan = startSpan('telephony.publish.triage_input');
          publishSpan.setAttribute('telephony.call_id', input.callId);
          publishSpan.setAttribute('telephony.topic', Topics.triage.input);
          try {
            await bus.publish(Topics.triage.input, triageEnvelope, headers);
            publishSpan.end();
          } catch (error) {
            publishSpan.recordException(error as Error);
            publishSpan.setStatus({
              code: SpanStatusCode.ERROR,
              message: error instanceof Error ? error.message : 'publish_failed',
            });
            publishSpan.end();
            logger.error('telephony.triage_input.publish_failed', {
              callId: input.callId,
              patientId: triageInput.patientId,
              correlationId,
              reason: (error as Error).message,
            });
            throw new Error('triage_input_publish_failed');
          }
          ctx.triageInputEnvelope = triageEnvelope;
          ctx.triageInputPublishedAt = nowFn();
          logger.info('telephony.triage_input.published', {
            callId: input.callId,
            patientId: triageInput.patientId,
            correlationId,
          });
          return true;
        },
        onDuplicate: () => {
          logger.warn('telephony.idempotency.duplicate', {
            stage: 'triageInput',
            key: triageKey,
            callId: input.callId,
            patientId: triageInput.patientId,
            correlationId,
          });
        },
        onError: (error) => {
          logger.error('telephony.idempotency.failed', {
            stage: 'triageInput',
            key: triageKey,
            callId: input.callId,
            patientId: ctx.triageInput?.patientId,
            correlationId,
            reason: error instanceof Error ? error.message : 'unknown_error',
          });
        },
      });

      if (triageStatus === 'executed') {
        const priority = determineCallbackPriority(ctx, confidence);
        const options = ensureCallbackWindowOptions(ctx, priority);
        await queuePrompt(ctx, options.windowLabel);
        logger.info('telephony.callback_window.selected', {
          callId: input.callId,
          priority,
          windowCode: options.windowCode,
          correlationId: ctx.correlationId,
        });
      } else {
        ctx.triageInputEnvelope = ctx.triageInputEnvelope ?? triageEnvelope;
        ctx.triageInputPublishedAt = ctx.triageInputPublishedAt ?? nowFn();
      }
    }

    if (typeof ctx.pipelineStartedAt === 'number') {
      telephonyPipelineDuration.record(performance.now() - ctx.pipelineStartedAt, {
        outcome: ctx.emergencyTransferTriggered && ctx.emergencyTransferEnabled ? 'emergency' : 'processed',
        target: ctx.intentRouteTarget ?? 'unknown',
      });
      ctx.pipelineStartedAt = undefined;
    }

    } catch (error) {
      if (classificationOutcome === null) {
        telephonyIntentCalls.add(1, { outcome: 'error', practiceId, error: 'pipeline' });
      }
      if (typeof ctx.pipelineStartedAt === 'number') {
        telephonyPipelineDuration.record(performance.now() - ctx.pipelineStartedAt, {
          outcome: 'error',
          stage: 'classification',
        });
        ctx.pipelineStartedAt = undefined;
      }
      await releasePipelineReservation(ctx, 'intent_failed', error);
      throw error;
    }

    if (ctx.emergencyTransferTriggered && ctx.emergencyTransferEnabled) {
      return 'EmergencyTransfer';
    }
    return 'Routed';
  }
}

export class EmergencyTransferState extends BaseState<TelephonyContext, TelephonyEvent> {
  constructor() {
    super('EmergencyTransfer');
  }

  async handle(ctx: TelephonyContext): Promise<string> {
    const nowFn = ctx.now ?? Date.now;
    const triggeredAt = ctx.emergencyTransferAt ?? nowFn();
    ctx.emergencyTransferAt = triggeredAt;
    if (!ctx.emergencyHandoffAt) {
      const reason = ctx.intentRouteReason ?? 'emergency_transfer';
      await triggerEmergencyHandoff(ctx, reason, triggeredAt);
    }
    const prompt = 'Connecting you to emergency services. Please stay on the line.';
    await queuePrompt(ctx, prompt);
    logger.warn('telephony.ivr.prompt.emergency_transfer', {
      callId: ctx.callId,
      prompt,
      correlationId: ctx.correlationId,
    });
    logger.error('telephony.emergency_transfer.initiated', {
      callId: ctx.callId,
      intent: ctx.intentClassified?.intent ?? 'unknown',
      correlationId: ctx.correlationId,
    });
    return 'Routed';
  }
}

export class RoutedState extends BaseState<TelephonyContext, TelephonyEvent> {
  constructor() {
    super('Routed');
  }

  async handle(ctx: TelephonyContext): Promise<string> {
    if (!ctx.intentClassified) {
      if (ctx.pipelineDuplicate) {
        logger.info('telephony.idempotency.skip', {
          stage: 'routing',
          callId: ctx.callId,
          correlationId: ctx.correlationId,
        });
        return 'Routed';
      }
      throw new Error('intent_classified_missing');
    }

    const decision = ctx.intentRoutingDecision ?? 'fallback';
    logger.debug('telephony.call.routed', {
      callId: ctx.intentClassified.callId,
      intent: ctx.intentClassified.intent,
      correlationId: ctx.correlationId,
      decision,
      target: ctx.intentRouteTarget ?? 'unknown',
    });
    if (decision === 'emergency') {
      logger.error('telephony.routing.emergency_transfer', {
        callId: ctx.intentClassified.callId,
        intent: ctx.intentClassified.intent,
        correlationId: ctx.correlationId,
      });
    } else if (ctx.intentRouteTarget === 'triage' && ctx.triageInput) {
      logger.info('telephony.routing.triage_ready', {
        callId: ctx.intentClassified.callId,
        intent: ctx.intentClassified.intent,
        correlationId: ctx.correlationId,
      });
    } else if (decision === 'auto') {
      logger.info('telephony.routing.auto', {
        callId: ctx.intentClassified.callId,
        intent: ctx.intentClassified.intent,
        confidence: ctx.intentClassified.confidence,
        correlationId: ctx.correlationId,
      });
    } else {
      logger.warn('telephony.routing.fallback', {
        callId: ctx.intentClassified.callId,
        intent: ctx.intentClassified.intent,
        confidence: ctx.intentClassified.confidence,
        threshold: ctx.intentConfidenceThreshold,
        target: ctx.intentRouteTarget ?? 'unknown',
        correlationId: ctx.correlationId,
      });
    }

    return 'Routed';
  }
}
async function reservePipelineKey(
  store: IdempotencyStore | undefined,
  key: string,
  ttlSeconds: number,
): Promise<'reserved' | 'exists'> {
  if (!store) {
    return 'reserved';
  }

  if (typeof reserveIdempotency === 'function') {
    try {
      return await reserveIdempotency(store, key, { ttlSeconds });
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (!message.includes('reserveIdempotency')) {
        throw error;
      }
    }
  }

  if (typeof store.reserve === 'function') {
    return store.reserve(key, ttlSeconds);
  }

  const alreadyExists = await store.exists(key);
  if (alreadyExists) {
    return 'exists';
  }
  await store.put(key, ttlSeconds);
  return 'reserved';
}
