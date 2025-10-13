import { FormEvent, useEffect, useId, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import SchemaForm, { type JsonSchema, type SchemaFormHandle } from '../features/schemaForm/SchemaForm';
import { submitIntake } from '../lib/api';
import type { ErrorEnvelope, PortalSubmission, PortalSubmissionAttachment, SafetyDecision } from '../lib/types';
import type { ErrorObject } from '@onecare/events/src/contracts/error-envelope';
import ErrorAlert from './ErrorAlert';
import RetryNotice from './RetryNotice';
import SubmitButton from './SubmitButton';
import { useLocale, supportedLocales } from '../i18n';
import InterpreterPreferences, { type InterpreterPreferencesValue } from './InterpreterPreferences';
import { useAccessibilityConfig } from '../hooks/useAccessibilityConfig';
// Import JSON Schema directly (tsconfig resolves JSON modules)
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import portalSubmissionSchema from '../../../../schemas/ingest/portal-submission.json';

const intakeSchema = portalSubmissionSchema as JsonSchema;
const MAX_ATTACHMENTS = 10;
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
    const contentType = (attachment.contentType ?? '').trim();
    const rawUrl = (attachment.url ?? '').trim();
    if (!contentType || !rawUrl) {
      return acc;
    }
    const safeUrl = isSafeAttachmentUrl(rawUrl);
    if (!safeUrl) {
      return acc;
    }
    acc.push({ contentType, url: safeUrl });
    return acc;
  }, []);

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
    normalized.attachments = attachments;
  }

  return normalized;
};

const IntakeForm = () => {
  const intl = useIntl();
  const { locale } = useLocale();
  const accessibilityConfig = useAccessibilityConfig();
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
  const [interpreterPreferences, setInterpreterPreferences] = useState<InterpreterPreferencesValue>({ requiresInterpreter: false });

  const statusMessageId = useId();

  useEffect(() => {
    setFormData((prev) => {
      const currentLocale = prev.patient.locale?.trim();
      if (isSupportedPortalLocale(currentLocale)) {
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
      setInterpreterPreferences((prev) => (prev.requiresInterpreter ? { requiresInterpreter: false } : prev));
      return;
    }
    if (!interpreterPreferences.requiresInterpreter) {
      return;
    }
    if (interpreterPreferences.preferredLanguage) {
      return;
    }
    if (accessibilityConfig.interpreterLanguages?.includes(locale)) {
      setInterpreterPreferences((prev) => ({ ...prev, preferredLanguage: locale }));
    }
  }, [accessibilityConfig, locale, interpreterPreferences.requiresInterpreter, interpreterPreferences.preferredLanguage]);

  const handleReset = () => {
    setFormData(buildInitialSubmission());
    setFormResetKey((previous) => previous + 1);
    setHasSubmitted(false);
    setSubmitError(null);
    setDecision(null);
    setDecisionCorrelationId(undefined);
    setRetryAttempts(0);
    setInterpreterPreferences({ requiresInterpreter: false });
  };

  const normalizeErrorEnvelope = async (error: unknown): Promise<ErrorEnvelope> => {
    const fallbackMessage = intl.formatMessage({ id: 'error.description.internal_error' });
    const fallback: ErrorEnvelope = {
      error: {
        code: 'internal_error',
        message: fallbackMessage,
      },
    };

    const coerceEnvelope = (envelope: ErrorEnvelope): ErrorEnvelope => ({
      error: {
        code: envelope.error.code,
        message: envelope.error.message ?? fallbackMessage,
        details: envelope.error.details,
        ...(envelope.error.correlationId ? { correlationId: envelope.error.correlationId } : {}),
      },
    });

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
          if (envelope.error && typeof envelope.error.code === 'string') {
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
      if (candidate.error && typeof candidate.error.code === 'string') {
        return {
          error: {
            code: candidate.error.code,
            message: candidate.error.message ?? fallbackMessage,
            details: candidate.error.details,
            ...(candidate.error.correlationId ? { correlationId: candidate.error.correlationId } : {}),
          },
        } satisfies ErrorEnvelope;
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
      const payload = sanitizeSubmission(formData);
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
        <button type="button" onClick={handleReset}>
          {intl.formatMessage({ id: 'intake.success.cta' })}
        </button>
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
        <button type="button" onClick={handleReset}>
          {intl.formatMessage({ id: 'intake.success.cta' })}
        </button>
      </section>
    );
  }

  return (
    <form onSubmit={handleSubmit} aria-describedby={submitError ? statusMessageId : undefined}>
      <SchemaForm
        key={formResetKey}
        ref={schemaFormRef}
        schema={intakeSchema}
        value={formData}
        onChange={(next) => setFormData(next)}
      />

      {accessibilityConfig.enabled ? (
        <InterpreterPreferences
          config={accessibilityConfig}
          value={interpreterPreferences}
          onChange={setInterpreterPreferences}
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
