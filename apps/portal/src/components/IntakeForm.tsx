import { FormEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import SchemaForm, { type JsonSchema, type SchemaFormHandle } from '../features/schemaForm/SchemaForm';
import { submitIntake } from '../lib/api';
import {
  clearInterpreterPreferences,
  persistInterpreterPreferences,
  readStoredInterpreterPreferences
} from '../lib/interpreterPreferencesStorage';
import type { ErrorEnvelope, PortalSubmission, PortalSubmissionAttachment, SafetyDecision } from '../lib/types';
import type { ErrorObject } from '@onecare/events/src/contracts/error-envelope';
import ErrorAlert from './ErrorAlert';
import ErrorSummary from './ErrorSummary';
import RetryNotice from './RetryNotice';
import SubmitButton from './SubmitButton';
import { useLocale, supportedLocales } from '../i18n';
import InterpreterPreferences, { type InterpreterPreferencesValue } from './InterpreterPreferences';
import { useAccessibilityConfig } from '../hooks/useAccessibilityConfig';
import Button from './ui/Button';
// Import JSON Schema directly (tsconfig resolves JSON modules)
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import portalSubmissionSchema from '../../../../schemas/ingest/portal-submission.json';

const intakeSchema = portalSubmissionSchema as JsonSchema;
const MAX_ATTACHMENTS = 10;
const ALLOWED_ATTACHMENT_TYPES = /^(application\/pdf|image\/[A-Za-z0-9.+-]+|audio\/[A-Za-z0-9.+-]+)$/i;
const MAX_INTERPRETER_LANGUAGES = 3;
const MAX_INTERPRETER_NOTES_LENGTH = 300;
const KNOWN_ERROR_CODES: readonly ErrorObject['code'][] = [
  'unauthorized',
  'forbidden',
  'invalid_input',
  'unsupported_media_type',
  'payload_too_large',
  'conflict',
  'upstream_timeout',
  'upstream_unavailable',
  'internal_error',
  'too_many_requests',
  'busy',
  'invalid_fhir',
] as const;

const isKnownErrorCode = (code: string): code is ErrorObject['code'] =>
  (KNOWN_ERROR_CODES as readonly string[]).includes(code);

const buildInitialSubmission = (): PortalSubmission => ({
  practiceId: '',
  patient: {
    id: ''
  },
  channel: 'web',
  narrative: '',
  attachments: []
});

const isSafeAttachmentUrl = (candidate: string): string | null => {
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'https:') {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
};

type SupportedLocale = (typeof supportedLocales)[number];

const isSupportedPortalLocale = (value: string | null | undefined): value is SupportedLocale =>
  typeof value === 'string' && supportedLocales.includes(value as SupportedLocale);

const sanitizeAttachments = (
  attachments: PortalSubmissionAttachment[] | undefined
): PortalSubmissionAttachment[] =>
  (attachments ?? []).reduce<PortalSubmissionAttachment[]>((acc, attachment) => {
    if (acc.length >= MAX_ATTACHMENTS) {
      return acc;
    }
    const contentType = (attachment.contentType ?? '').trim();
    const rawUrl = (attachment.url ?? '').trim();
    if (!contentType || !rawUrl) {
      return acc;
    }
    if (!ALLOWED_ATTACHMENT_TYPES.test(contentType)) {
      return acc;
    }
    const safeUrl = isSafeAttachmentUrl(rawUrl);
    if (!safeUrl) {
      return acc;
    }
    if (acc.some((existing) => existing.url === safeUrl)) {
      return acc;
    }
    acc.push({ contentType, url: safeUrl });
    return acc;
  }, []);

const toContractAttachments = (
  attachments: PortalSubmissionAttachment[]
): PortalSubmission['attachments'] =>
  attachments as unknown as PortalSubmission['attachments'];

export const sanitizeSubmission = (submission: PortalSubmission): PortalSubmission => {
  const practiceId = submission.practiceId.trim();
  const narrative = submission.narrative.trim();
  const patientId = submission.patient.id.trim();
  const dob = submission.patient.dob?.trim();
  const locale = submission.patient.locale?.trim();
  const attachments = sanitizeAttachments(submission.attachments);

  const patient: PortalSubmission['patient'] = {
    id: patientId
  };

  if (dob) {
    patient.dob = dob;
  }
  if (locale && isSupportedPortalLocale(locale)) {
    patient.locale = locale;
  }

  const channel: PortalSubmission['channel'] = submission.channel === 'ivr' ? 'ivr' : 'web';

  const normalized: PortalSubmission = {
    practiceId,
    patient,
    narrative,
    channel
  };

  if (attachments.length > 0) {
    normalized.attachments = toContractAttachments(attachments);
  }

  return normalized;
};

const toPreferredLanguagesTuple = (
  languages: string[]
): PortalSubmission['interpreterPreferences'] extends { preferredLanguages?: infer T }
  ? T
  : [string] | undefined => {
  const limited = languages.slice(0, MAX_INTERPRETER_LANGUAGES);
  if (limited.length === 0) {
    return undefined as never;
  }
  if (limited.length === 1) {
    return [limited[0]] as never;
  }
  if (limited.length === 2) {
    return [limited[0], limited[1]] as never;
  }
  return [limited[0], limited[1], limited[2]] as never;
};

export const sanitizeInterpreterPreferences = (
  preferences: InterpreterPreferencesValue,
  allowedLanguages: readonly string[]
): PortalSubmission['interpreterPreferences'] | undefined => {
  if (!preferences.requiresInterpreter) {
    return undefined;
  }

  const normalizedLanguages = Array.from(
    new Set((preferences.preferredLanguages ?? []).map((item) => item.trim().toLowerCase()))
  )
    .filter((item) => allowedLanguages.includes(item))
    .slice(0, MAX_INTERPRETER_LANGUAGES);

  const notesRaw = preferences.notes?.trim() ?? '';
  const notes = notesRaw.length > 0 ? notesRaw.slice(0, MAX_INTERPRETER_NOTES_LENGTH) : undefined;

  const payload: PortalSubmission['interpreterPreferences'] = {
    requiresInterpreter: true
  };

  const preferredLanguagesTuple = toPreferredLanguagesTuple(normalizedLanguages);
  if (preferredLanguagesTuple) {
    payload.preferredLanguages = preferredLanguagesTuple;
  }

  if (notes) {
    payload.notes = notes;
  }

  if (preferences.requiresInterpreterConfirmed) {
    payload.requiresInterpreterConfirmed = true;
  }

  return payload;
};

const INTAKE_DRAFT_STORAGE_KEY = 'onecare.portal.intakeDraft';
const AUTOSAVE_DEBOUNCE_MS = 750;

type IntakeDraftEnvelope = {
  submission: PortalSubmission;
  updatedAt: number;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const coercePortalSubmission = (candidate: unknown): PortalSubmission | null => {
  if (!isPlainObject(candidate)) {
    return null;
  }
  const base = buildInitialSubmission();
  if (typeof candidate.practiceId === 'string') {
    base.practiceId = candidate.practiceId;
  }
  if (candidate.patient && isPlainObject(candidate.patient)) {
    const patientCandidate = candidate.patient;
    base.patient = {
      id: typeof patientCandidate.id === 'string' ? patientCandidate.id : ''
    };
    if (typeof patientCandidate.dob === 'string') {
      base.patient.dob = patientCandidate.dob;
    }
    if (typeof patientCandidate.locale === 'string') {
      base.patient.locale = patientCandidate.locale;
    }
  }
  if (typeof candidate.narrative === 'string') {
    base.narrative = candidate.narrative;
  }
  if (candidate.channel === 'ivr' || candidate.channel === 'web') {
    base.channel = candidate.channel;
  }
  if (Array.isArray(candidate.attachments)) {
    const attachments = candidate.attachments
      .filter(isPlainObject)
      .map((item) => ({
        contentType: typeof item.contentType === 'string' ? item.contentType : '',
        url: typeof item.url === 'string' ? item.url : ''
      }))
      .filter((item) => item.contentType || item.url);
    if (attachments.length > 0) {
      base.attachments = attachments as PortalSubmissionAttachment[];
    }
  }
  return base;
};

const readDraftEnvelope = (): IntakeDraftEnvelope | null => {
  if (typeof window === 'undefined' || !window.localStorage) {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(INTAKE_DRAFT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { submission?: unknown; updatedAt?: unknown };
    if (!parsed.submission || typeof parsed.updatedAt !== 'number') {
      return null;
    }
    const submission = coercePortalSubmission(parsed.submission);
    if (!submission) {
      return null;
    }
    return { submission, updatedAt: parsed.updatedAt };
  } catch {
    return null;
  }
};

const writeDraftEnvelope = (envelope: IntakeDraftEnvelope): void => {
  if (typeof window === 'undefined' || !window.localStorage) {
    return;
  }
  try {
    window.localStorage.setItem(INTAKE_DRAFT_STORAGE_KEY, JSON.stringify(envelope));
  } catch {
    // ignore failures to avoid blocking the UI
  }
};

const clearDraftEnvelope = (): void => {
  if (typeof window === 'undefined' || !window.localStorage) {
    return;
  }
  try {
    window.localStorage.removeItem(INTAKE_DRAFT_STORAGE_KEY);
  } catch {
    // ignore failures
  }
};

const IntakeForm = () => {
  const intl = useIntl();
  const { locale } = useLocale();
  const accessibilityConfig = useAccessibilityConfig();
  const interpreterLanguages = useMemo(
    () => (accessibilityConfig.interpreterLanguages ?? []).map((item) => item.trim().toLowerCase()),
    [accessibilityConfig.interpreterLanguages]
  );
  const allowInterpreterPersistence = Boolean(
    accessibilityConfig.collectPatientPrefs?.includes?.('remember_interpreter')
  );
  const [formData, setFormData] = useState<PortalSubmission>(() => buildInitialSubmission());
  const [formResetKey, setFormResetKey] = useState(0);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [hasSubmitted, setHasSubmitted] = useState(false);
  const [submitError, setSubmitError] = useState<ErrorEnvelope | null>(null);
  const [decision, setDecision] = useState<SafetyDecision | null>(null);
  const [decisionCorrelationId, setDecisionCorrelationId] = useState<string | undefined>();
  const [retryAttempts, setRetryAttempts] = useState(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const schemaFormRef = useRef<SchemaFormHandle>(null);
  const MAX_RETRIES = 2;
  const [interpreterPreferences, setInterpreterPreferences] = useState<InterpreterPreferencesValue>({
    requiresInterpreter: false,
    preferredLanguages: []
  });
  const interpreterPreferredLanguagesSignature = useMemo(
    () => (interpreterPreferences.preferredLanguages ?? []).join('|'),
    [interpreterPreferences.preferredLanguages]
  );
  const handleInterpreterPreferencesChange = useCallback(
    (next: InterpreterPreferencesValue) => {
      const normalizedLanguages = Array.from(
        new Set((next.preferredLanguages ?? []).map((item) => item.trim().toLowerCase()))
      )
        .filter((item) => interpreterLanguages.includes(item))
        .slice(0, MAX_INTERPRETER_LANGUAGES);

      const nextNotes = next.notes?.slice(0, MAX_INTERPRETER_NOTES_LENGTH);

      setInterpreterPreferences({
        ...next,
        preferredLanguages: normalizedLanguages,
        notes: nextNotes
      });
    },
    [interpreterLanguages]
  );
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [showValidationSummary, setShowValidationSummary] = useState(false);
  const [shouldFocusErrorSummary, setShouldFocusErrorSummary] = useState(false);
  const [autosaveStatus, setAutosaveStatus] = useState<'idle' | 'saving' | 'saved' | 'restored'>('idle');
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const autosaveTimeoutRef = useRef<number | null>(null);
  const skipNextAutosaveRef = useRef(true);
  const hasLoadedStoredInterpreterPrefs = useRef(false);

  const errorSummaryItems = useMemo(
    () => Object.entries(formErrors).map(([path, message]) => ({ path, message })),
    [formErrors]
  );

  const autosaveMessage = useMemo(() => {
    if (autosaveStatus === 'saving') {
      return intl.formatMessage({ id: 'autosave.status.saving' });
    }
    if (autosaveStatus === 'saved' && lastSavedAt) {
      return intl.formatMessage(
        { id: 'autosave.status.saved' },
        { time: intl.formatTime(new Date(lastSavedAt), { timeStyle: 'short' }) }
      );
    }
    if (autosaveStatus === 'restored' && lastSavedAt) {
      return intl.formatMessage(
        { id: 'autosave.status.restored' },
        { time: intl.formatTime(new Date(lastSavedAt), { timeStyle: 'short' }) }
      );
    }
    return null;
  }, [autosaveStatus, intl, lastSavedAt]);

  const statusMessageId = useId();

  useEffect(() => {
    const envelope = readDraftEnvelope();
    if (!envelope) return;
    setFormData(envelope.submission);
    setFormResetKey((previous) => previous + 1);
    setAutosaveStatus('restored');
    setLastSavedAt(envelope.updatedAt);
    skipNextAutosaveRef.current = true;
  }, []);

  useEffect(() => {
    if (accessibilityConfig.enabled) {
      return;
    }
    setInterpreterPreferences((prev) => ({
      requiresInterpreter: false,
      preferredLanguages: [],
      rememberSelection: allowInterpreterPersistence ? prev.rememberSelection : false
    }));
  }, [accessibilityConfig.enabled, allowInterpreterPersistence]);

  useEffect(() => {
    setFormData((prev) => {
      const currentLocale = prev.patient.locale?.trim();
      if (isSupportedPortalLocale(currentLocale)) {
        return prev;
      }
      if (!isSupportedPortalLocale(locale)) {
        return prev;
      }
      if (locale === currentLocale) {
        return prev;
      }
      return {
        ...prev,
        patient: {
          ...prev.patient,
          locale
        }
      };
    });
  }, [locale]);

  useEffect(() => {
    if (!accessibilityConfig.enabled) {
      return;
    }
    if (!interpreterPreferences.requiresInterpreter) {
      return;
    }
    if (!isSupportedPortalLocale(locale)) {
      return;
    }
    if (!interpreterLanguages.includes(locale)) {
      return;
    }
    setInterpreterPreferences((prev) => {
      if (!prev.requiresInterpreter) {
        return prev;
      }
      const existing = prev.preferredLanguages ?? [];
      if (existing.length > 0) {
        return prev;
      }
      return {
        ...prev,
        preferredLanguages: [locale]
      };
    });
  }, [
    accessibilityConfig.enabled,
    interpreterLanguages,
    interpreterPreferences.requiresInterpreter,
    interpreterPreferences.preferredLanguages,
    locale
  ]);

  useEffect(() => {
    if (Object.keys(formErrors).length === 0) {
      setShowValidationSummary(false);
    }
  }, [formErrors]);

  useEffect(() => {
    if (!allowInterpreterPersistence) {
      setInterpreterPreferences((prev) =>
        prev.rememberSelection
          ? {
              ...prev,
              rememberSelection: false
            }
          : prev
      );
      hasLoadedStoredInterpreterPrefs.current = false;
      clearInterpreterPreferences();
      return;
    }

    if (!accessibilityConfig.enabled) {
      hasLoadedStoredInterpreterPrefs.current = false;
      return;
    }

    if (hasLoadedStoredInterpreterPrefs.current) {
      return;
    }

    const stored = readStoredInterpreterPreferences();
    hasLoadedStoredInterpreterPrefs.current = true;
    if (!stored) {
      return;
    }
    const filteredLanguages = (stored.preferredLanguages ?? [])
      .map((item) => item.trim().toLowerCase())
      .filter((item) => interpreterLanguages.includes(item))
      .slice(0, MAX_INTERPRETER_LANGUAGES);

    setInterpreterPreferences((prev) => ({
      ...prev,
      requiresInterpreter: stored.requiresInterpreter,
      preferredLanguages: filteredLanguages,
      requiresInterpreterConfirmed: stored.requiresInterpreterConfirmed,
      rememberSelection: true
    }));
  }, [allowInterpreterPersistence, accessibilityConfig.enabled, interpreterLanguages]);

  useEffect(() => {
    if (!allowInterpreterPersistence) {
      return;
    }
    if (!interpreterPreferences.rememberSelection) {
      clearInterpreterPreferences();
      return;
    }
    if (!interpreterPreferences.requiresInterpreter) {
      clearInterpreterPreferences();
      return;
    }
    const sanitized = sanitizeInterpreterPreferences(interpreterPreferences, interpreterLanguages);
    if (!sanitized) {
      clearInterpreterPreferences();
      return;
    }
    const languages = sanitized.preferredLanguages ? Array.from(sanitized.preferredLanguages) : [];
    persistInterpreterPreferences({
      requiresInterpreter: true,
      preferredLanguages: languages,
      requiresInterpreterConfirmed: sanitized.requiresInterpreterConfirmed
    });
  }, [
    allowInterpreterPersistence,
    interpreterPreferences.rememberSelection,
    interpreterPreferences.requiresInterpreter,
    interpreterPreferences.requiresInterpreterConfirmed,
    interpreterPreferredLanguagesSignature,
    interpreterLanguages
  ]);

  useEffect(() => {
    if (!showValidationSummary) {
      setShouldFocusErrorSummary(false);
    }
  }, [showValidationSummary]);

  useEffect(() => {
    return () => {
      if (autosaveTimeoutRef.current !== null && typeof window !== 'undefined') {
        window.clearTimeout(autosaveTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (hasSubmitted) {
      return undefined;
    }
    if (skipNextAutosaveRef.current) {
      skipNextAutosaveRef.current = false;
      return undefined;
    }
    if (typeof window === 'undefined') {
      return undefined;
    }
    setAutosaveStatus('saving');
    if (autosaveTimeoutRef.current !== null) {
      window.clearTimeout(autosaveTimeoutRef.current);
    }
    const timeout = window.setTimeout(() => {
      const envelope: IntakeDraftEnvelope = {
        submission: formData,
        updatedAt: Date.now()
      };
      writeDraftEnvelope(envelope);
      setAutosaveStatus('saved');
      setLastSavedAt(envelope.updatedAt);
    }, AUTOSAVE_DEBOUNCE_MS);
    autosaveTimeoutRef.current = timeout;

    return () => {
      window.clearTimeout(timeout);
    };
  }, [formData, hasSubmitted]);

  const handleReset = () => {
    setFormData(buildInitialSubmission());
    setFormResetKey((previous) => previous + 1);
    setHasSubmitted(false);
    setSubmitError(null);
    setDecision(null);
    setDecisionCorrelationId(undefined);
    setRetryAttempts(0);
    setInterpreterPreferences({
      requiresInterpreter: false,
      preferredLanguages: [],
      rememberSelection: allowInterpreterPersistence ? interpreterPreferences.rememberSelection : false
    });
    hasLoadedStoredInterpreterPrefs.current = false;
    setShowValidationSummary(false);
    setFormErrors({});
    setShouldFocusErrorSummary(false);
    clearDraftEnvelope();
    setAutosaveStatus('idle');
    setLastSavedAt(null);
    skipNextAutosaveRef.current = true;
  };

  const normalizeErrorEnvelope = async (error: unknown): Promise<ErrorEnvelope> => {
    const fallbackMessage = intl.formatMessage({ id: 'error.description.internal_error' });
    const fallback: ErrorEnvelope = {
      error: {
        code: 'internal_error',
        message: fallbackMessage,
      },
    };

    const coerceEnvelope = (envelope: ErrorEnvelope): ErrorEnvelope => {
      const code = isKnownErrorCode(envelope.error.code) ? envelope.error.code : 'internal_error';
      return {
        error: {
          code,
          message: envelope.error.message ?? fallbackMessage,
          details: envelope.error.details,
          ...(envelope.error.correlationId ? { correlationId: envelope.error.correlationId } : {}),
        },
      };
    };

    if (!error) {
      return fallback;
    }

    const extractFromObject = (candidate: { envelope?: ErrorEnvelope } | null | undefined) => {
      if (candidate?.envelope?.error) {
        return coerceEnvelope(candidate.envelope);
      }
      return undefined;
    };

    if (typeof error === 'object' && error !== null) {
      const fromWrapped = extractFromObject(error as { envelope?: ErrorEnvelope });
      if (fromWrapped) return fromWrapped;
    }

    if (error instanceof Response) {
      try {
        const payload = await error.json();
        if (payload && typeof payload === 'object' && 'error' in payload) {
          const envelope = payload as ErrorEnvelope;
          if (envelope.error && isKnownErrorCode(envelope.error.code)) {
            return coerceEnvelope(envelope);
          }
        }
      } catch {
        return fallback;
      }
      return fallback;
    }

    if (typeof error === 'object' && error !== null) {
      const candidate = error as {
        error?: { code?: string; message?: string; details?: Record<string, unknown>; correlationId?: string };
      };
      const candidateError = candidate.error;
      if (candidateError) {
        const candidateCode = candidateError.code;
        if (typeof candidateCode === 'string' && isKnownErrorCode(candidateCode)) {
          const { message, details, correlationId } = candidateError;
          return {
            error: {
              code: candidateCode,
              message: message ?? fallbackMessage,
              details,
              ...(correlationId ? { correlationId } : {}),
            },
          } satisfies ErrorEnvelope;
        }
      }
    }

    if (error instanceof Error) {
      return {
        error: {
          code: 'internal_error',
          message: error.message ?? fallbackMessage,
        }
      } satisfies ErrorEnvelope;
    }

    return fallback;
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isSubmitting) {
      return;
    }

    const schemaValid = schemaFormRef.current?.validateAll() ?? true;
    if (!schemaValid) {
      setShowValidationSummary(true);
      setShouldFocusErrorSummary(true);
      setSubmitError({
        error: {
          code: 'invalid_input',
          message: intl.formatMessage({ id: 'error.description.invalid_input' })
        }
      });
      return;
    }

    setSubmitError(null);
    setDecision(null);
    setDecisionCorrelationId(undefined);
    setHasSubmitted(false);
    setRetryAttempts(0);
    setIsSubmitting(true);

    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const baseSubmission = sanitizeSubmission(formData);
      const interpreterPayload = sanitizeInterpreterPreferences(
        interpreterPreferences,
        interpreterLanguages
      );
      const payload: PortalSubmission = interpreterPayload
        ? { ...baseSubmission, interpreterPreferences: interpreterPayload }
        : baseSubmission;
      const result = await submitIntake(payload, {
        signal: controller.signal,
        locale,
        retry: {
          maxRetries: MAX_RETRIES,
          baseDelayMs: 250,
          jitter: true
        },
        onRetry: ({ attempt }) => setRetryAttempts(attempt)
      });
      setDecision(result.decision);
      setDecisionCorrelationId(result.correlationId);
      setRetryAttempts(0);
      setHasSubmitted(true);
      setShowValidationSummary(false);
      setFormErrors({});
      setShouldFocusErrorSummary(false);
      clearDraftEnvelope();
      setAutosaveStatus('idle');
      setLastSavedAt(null);
      skipNextAutosaveRef.current = true;
    } catch (error) {
      if ((error as { __clientCancelled?: boolean }).__clientCancelled) {
        setRetryAttempts(0);
        setSubmitError(null);
        return;
      }
      const envelope = await normalizeErrorEnvelope(error);
      setSubmitError(envelope);
      setRetryAttempts(0);
    } finally {
      setIsSubmitting(false);
      abortControllerRef.current = null;
    }
  };

  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
    };
  }, []);

  const renderDecision = () => {
    if (!decision) return null;

    const outcomeFriendly =
      decision.outcome === 'SAFE_TO_CONTINUE'
        ? intl.formatMessage({ id: 'decision.safe.title' })
        : intl.formatMessage({ id: 'decision.diverted.title' });
    const defaultReason =
      decision.outcome === 'SAFE_TO_CONTINUE'
        ? intl.formatMessage({ id: 'decision.safe.defaultReason' })
        : intl.formatMessage({ id: 'decision.diverted.defaultReason' });

    return (
      <section aria-labelledby={statusMessageId} role="status">
        <h2 id={statusMessageId}>{outcomeFriendly}</h2>
        <p>{decision.reason ?? defaultReason}</p>
        {decisionCorrelationId ? (
          <p>
            {intl.formatMessage({ id: 'decision.reference' })}: <code>{decisionCorrelationId}</code>
          </p>
        ) : null}
        <Button type="button" variant="subtle" onClick={handleReset}>
          {intl.formatMessage({ id: 'intake.success.cta' })}
        </Button>
      </section>
    );
  };

  if (hasSubmitted && decision) {
    return renderDecision();
  }

  if (hasSubmitted) {
    return (
      <section aria-labelledby={statusMessageId} role="status">
        <h2 id={statusMessageId}>{intl.formatMessage({ id: 'intake.success.title' })}</h2>
        <p>{intl.formatMessage({ id: 'intake.success.body' })}</p>
        <Button type="button" variant="subtle" onClick={handleReset}>
          {intl.formatMessage({ id: 'intake.success.cta' })}
        </Button>
      </section>
    );
  }

  return (
    <form onSubmit={handleSubmit} aria-describedby={submitError ? statusMessageId : undefined}>
      <ErrorSummary errors={showValidationSummary ? errorSummaryItems : []} autoFocus={shouldFocusErrorSummary} />
      {autosaveMessage ? (
        <div className="autosave-status" role="status" aria-live="polite">
          {autosaveMessage}
        </div>
      ) : null}
      <SchemaForm
        key={formResetKey}
        ref={schemaFormRef}
        schema={intakeSchema}
        value={formData}
        onChange={(next) => setFormData(next)}
        onErrorsChange={setFormErrors}
      />

      {accessibilityConfig.enabled ? (
        <InterpreterPreferences
          config={accessibilityConfig}
          value={interpreterPreferences}
          onChange={handleInterpreterPreferencesChange}
          allowPersistence={allowInterpreterPersistence}
        />
      ) : null}

      {submitError ? (
        <ErrorAlert
          id={statusMessageId}
          error={submitError}
          onRetry={() => setSubmitError(null)}
          supportUrl="mailto:support@onecare.example"
        />
      ) : (
        <div id={statusMessageId} aria-live="polite" />
      )}

      <RetryNotice
        attempts={isSubmitting ? retryAttempts : 0}
        maxRetries={MAX_RETRIES}
        onCancel={() => {
          abortControllerRef.current?.abort();
          setRetryAttempts(0);
        }}
      />

      <SubmitButton disabled={isSubmitting} />
    </form>
  );
};

export default IntakeForm;

export const __intakeDraftHelpers = {
  coercePortalSubmission
};
