import { loadConfig, type ResolvedConfig } from '@onecare/config';
import { BaseState } from '@onecare/statekit';
import { logger } from '@onecare/observability';
import { Topics, createEnvelope } from '@onecare/events';
import type { TriageInput } from '@onecare/events';
import { executeWithIdempotency } from '@onecare/ports';
import { buildCallTranscribed } from '../adapters/asr.client';
import { buildIntentClassifiedEvent } from '../adapters/intent.classifier';
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

function deriveCallTranscribedIdempotencyKey(ctx: TelephonyContext, callId: string): string {
  return ctx.callTranscribedIdempotencyKey ?? `telephony:call-transcribed:${callId}`;
}

function deriveIntentClassifiedIdempotencyKey(ctx: TelephonyContext, callId: string): string {
  return ctx.intentClassifiedIdempotencyKey ?? `telephony:intent-classified:${callId}`;
}

function deriveTriagePublishIdempotencyKey(ctx: TelephonyContext, callId: string, patientId?: string | null): string {
  const patient = patientId ?? ctx.patientId ?? 'unknown-patient';
  return ctx.triagePublishIdempotencyKey ?? `telephony:triage-input:${patient}:${callId}`;
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

function parseCallbackWindowOverrides(raw: string | undefined): Partial<Record<CallbackPriority, { code: string; label?: string }>> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, { code?: string; label?: string }>;
    const result: Partial<Record<CallbackPriority, { code: string; label?: string }>> = {};
    for (const [key, value] of Object.entries(parsed)) {
      const priority = key.trim().toLowerCase() as CallbackPriority;
      if (!['stat', 'urgent', 'soon', 'routine'].includes(priority)) continue;
      const code = value?.code?.trim();
      if (!code) continue;
      result[priority] = { code, label: value?.label?.trim() || undefined };
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

function ensureCallbackWindowOptions(ctx: TelephonyContext, priority: CallbackPriority): CallbackWindowOptions {
  if (!ctx.callbackWindowOptions || ctx.callbackWindowOptions.priority !== priority) {
    const overrides = parseCallbackWindowOverrides(process.env.TELEPHONY_CALLBACK_WINDOWS);
    const base = overrides?.[priority] ?? DEFAULT_CALLBACK_WINDOWS[priority];
    const windowCode = base.code;
    const windowLabel = base.label ?? humanizeWindowLabel(windowCode);
    ctx.callbackWindowOptions = {
      priority,
      windowCode,
      windowLabel,
    };
  }
  return ctx.callbackWindowOptions;
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
): IntentClassificationInput {
  return {
    callId: payload.callId,
    transcript: payload.transcript,
    lang: payload.lang ?? fallbackLang ?? null,
    patientId: payload.patientId ?? null,
    correlationId,
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
    const asrClient = ctx.asrClient;
    if (!asrClient) {
      throw new Error('asr_client_missing');
    }

    const callId = ctx.callId?.trim();
    if (!callId) {
      throw new Error('call_id_missing');
    }

    const audioRef = ctx.audioRef?.trim();
    if (!audioRef) {
      throw new Error('audio_ref_missing');
    }

    const languages = ensureLanguageFallback(ctx.availableLanguages);
    const selectedLanguage = ensureSelectedLanguage(ctx, languages);

    const builder = ctx.buildCallTranscribed ?? buildCallTranscribed;
    ctx.buildCallTranscribed = builder;

    const transcription = await asrClient.transcribe(callId, audioRef);
    ctx.transcription = transcription;

    const payload = builder({
      callId,
      transcription,
      context: ctx.patientId !== undefined ? { patientId: ctx.patientId } : undefined,
    });

    if (!payload.lang && selectedLanguage) {
      payload.lang = selectedLanguage;
    }

    ctx.callTranscribed = payload;

    const envelope = createEnvelope(Topics.telephony.callTranscribed, payload, ctx.correlationId);
    ctx.callTranscribedEnvelope = envelope;
    ctx.intentClassificationInput = buildIntentClassificationInput(payload, ctx.correlationId, selectedLanguage);
    ensureIntentConfidenceThreshold(ctx);
    ensureEmergencyTransferEnabled(ctx);

    const bus = ctx.bus;
    if (!bus) {
      throw new Error('message_bus_missing');
    }

    const headers = ctx.correlationId ? { 'x-correlation-id': ctx.correlationId } : undefined;
    const callIdempotencyKey = deriveCallTranscribedIdempotencyKey(ctx, callId);
    const ttlSeconds = resolveTelephonyIdempotencyTtl(ctx);

    const { status } = await executeWithIdempotency({
      store: ctx.idempotencyStore,
      key: callIdempotencyKey,
      ttlSeconds,
      execute: async () => {
        try {
          await bus.publish(Topics.telephony.callTranscribed, envelope, headers);
        } catch (error) {
          logger.error('telephony.call.transcribed.publish_failed', {
            callId,
            correlationId: ctx.correlationId,
            reason: (error as Error).message,
          });
          throw new Error('call_transcribed_publish_failed');
        }

        logger.info('telephony.call.transcribed', {
          callId,
          correlationId: ctx.correlationId,
          lang: payload.lang ?? undefined,
          patientIdPresent: payload.patientId != null,
        });
        return true;
      },
      onDuplicate: () => {
        logger.warn('telephony.idempotency.duplicate', {
          stage: 'callTranscribed',
          key: callIdempotencyKey,
          callId,
          correlationId: ctx.correlationId,
        });
      },
      onError: (error) => {
        logger.error('telephony.idempotency.failed', {
          stage: 'callTranscribed',
          key: callIdempotencyKey,
          callId,
          correlationId: ctx.correlationId,
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
  }
}

export class IntentClassifiedState extends BaseState<TelephonyContext, TelephonyEvent> {
  constructor() {
    super('IntentClassified');
  }

  async handle(ctx: TelephonyContext): Promise<string> {
    const input = ctx.intentClassificationInput;
    if (!input) {
      throw new Error('intent_input_missing');
    }

    const intentClassifier = ctx.intentClassifier;
    if (!intentClassifier) {
      throw new Error('intent_classifier_missing');
    }

    const bus = ctx.bus;
    if (!bus) {
      throw new Error('message_bus_missing');
    }

    const result = await intentClassifier.classify(input);
    ctx.intentClassificationResult = result;

    const payload = buildIntentClassifiedEvent(input, result);
    ctx.intentClassified = payload;
    const transcriptText = ctx.transcription?.text ?? '';
    const route = mapIntentToRoute(payload.intent, transcriptText, ctx.patientId, payload.confidence ?? undefined);
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
      typeof payload.confidence === 'number' && Number.isFinite(payload.confidence) ? payload.confidence : undefined;
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
        intent: payload.intent,
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
        intent: payload.intent,
        confidence,
        correlationId: ctx.correlationId,
      });
    }
    logger.info('telephony.intent.route', {
      callId: input.callId,
      intent: payload.intent,
      target: ctx.intentRouteTarget,
      reason: ctx.intentRouteReason,
      triageInput: Boolean(ctx.triageInput),
      correlationId: ctx.correlationId,
    });

    const envelope = createEnvelope(Topics.telephony.intentClassified, payload, ctx.correlationId);
    ctx.intentClassifiedEnvelope = envelope;

    const headers = ctx.correlationId ? { 'x-correlation-id': ctx.correlationId } : undefined;
    const intentKey = deriveIntentClassifiedIdempotencyKey(ctx, input.callId);
    const ttlSeconds = resolveTelephonyIdempotencyTtl(ctx);
    const nowFn = ctx.now ?? Date.now;

    const { status: intentPublishStatus } = await executeWithIdempotency({
      store: ctx.idempotencyStore,
      key: intentKey,
      ttlSeconds,
      execute: async () => {
        try {
          await bus.publish(Topics.telephony.intentClassified, envelope, headers);
        } catch (error) {
          logger.error('telephony.intent.classified.publish_failed', {
            callId: input.callId,
            intent: payload.intent,
            correlationId: ctx.correlationId,
            reason: (error as Error).message,
          });
          throw new Error('intent_classified_publish_failed');
        }

        logger.info('telephony.intent.classified', {
          callId: input.callId,
          intent: payload.intent,
          confidence: payload.confidence,
          correlationId: ctx.correlationId,
        });
        return true;
      },
      onDuplicate: () => {
        logger.warn('telephony.idempotency.duplicate', {
          stage: 'intentClassified',
          key: intentKey,
          callId: input.callId,
          correlationId: ctx.correlationId,
        });
      },
      onError: (error) => {
        logger.error('telephony.idempotency.failed', {
          stage: 'intentClassified',
          key: intentKey,
          callId: input.callId,
          correlationId: ctx.correlationId,
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
      const triageEnvelope = createEnvelope(Topics.triage.input, triageInput, ctx.correlationId);
      const triageKey = deriveTriagePublishIdempotencyKey(ctx, input.callId, triageInput.patientId);

      const { status: triageStatus } = await executeWithIdempotency({
        store: ctx.idempotencyStore,
        key: triageKey,
        ttlSeconds,
        execute: async () => {
          try {
            await bus.publish(Topics.triage.input, triageEnvelope, headers);
          } catch (error) {
            logger.error('telephony.triage_input.publish_failed', {
              callId: input.callId,
              patientId: triageInput.patientId,
              correlationId: ctx.correlationId,
              reason: (error as Error).message,
            });
            throw new Error('triage_input_publish_failed');
          }
          ctx.triageInputEnvelope = triageEnvelope;
          ctx.triageInputPublishedAt = nowFn();
          logger.info('telephony.triage_input.published', {
            callId: input.callId,
            patientId: triageInput.patientId,
            correlationId: ctx.correlationId,
          });
          return true;
        },
        onDuplicate: () => {
          logger.warn('telephony.idempotency.duplicate', {
            stage: 'triageInput',
            key: triageKey,
            callId: input.callId,
            patientId: triageInput.patientId,
            correlationId: ctx.correlationId,
          });
        },
        onError: (error) => {
          logger.error('telephony.idempotency.failed', {
            stage: 'triageInput',
            key: triageKey,
            callId: input.callId,
            patientId: ctx.triageInput?.patientId,
            correlationId: ctx.correlationId,
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
