import { FormEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import SchemaForm, {
  collectValidationIssues,
  type JsonSchema,
  type ObjectJsonSchema,
  type SchemaFormHandle,
  type ValidationIssue
} from '../features/schemaForm/SchemaForm';
import { submitIntake } from '../lib/api';
import {
  clearInterpreterPreferences,
  persistInterpreterPreferences,
  readStoredInterpreterPreferences
} from '../lib/interpreterPreferencesStorage';
import type { ErrorEnvelope, PortalSubmission, PortalSubmissionAttachment, SafetyDecision } from '../lib/types';
import type { ErrorObject } from '@onecare/events/src/contracts/error-envelope';
import { classNames } from '../lib/classNames';
import StepIndicator from './StepIndicator';
import ErrorAlert from './ErrorAlert';
import ErrorSummary from './ErrorSummary';
import RetryNotice from './RetryNotice';
import SubmitButton from './SubmitButton';
import { useLocale, supportedLocales } from '../i18n';
import InterpreterPreferences, { type InterpreterPreferencesValue } from './InterpreterPreferences';
import { useAccessibilityConfig } from '../hooks/useAccessibilityConfig';
import Button from './ui/Button';
import {
  DEFAULT_WIZARD_META,
  createIntakeWizardSteps,
  findStepIndex,
  getNextStepId,
  getPreviousStepId,
  type IntakeWizardMeta,
  type IntakeWizardStepId
} from '../application/wizard/intakeWizard';
import { ensureHttpsUrl, sanitizeMultilineText, sanitizeText } from '../lib/security';
import { persistPatientContext, clearPatientContext } from '../lib/session';
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
  'not_found',
  'unsupported_media_type',
  'payload_too_large',
  'conflict',
  'upstream_timeout',
  'upstream_unavailable',
  'internal_error',
  'too_many_requests',
  'rate_limited',
  'busy',
  'over_capacity',
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
    const safeUrl = ensureHttpsUrl(rawUrl);
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
  const practiceId = sanitizeText(submission.practiceId, 120);
  const narrative = sanitizeMultilineText(submission.narrative ?? '', 1_200);
  const patientId = sanitizeText(submission.patient.id, 120);
  const dob = submission.patient.dob ? sanitizeText(submission.patient.dob, 40) : undefined;
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

  const notesRaw = preferences.notes ?? '';
  const notesSanitized = notesRaw
    ? sanitizeMultilineText(notesRaw, MAX_INTERPRETER_NOTES_LENGTH)
    : '';
  const notes = notesSanitized.length > 0 ? notesSanitized : undefined;

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
const WIZARD_STEP_IDS: IntakeWizardStepId[] = [
  'practice',
  'patient',
  'details',
  'attachments',
  'review'
];

type IntakeDraftEnvelope = {
  submission: PortalSubmission;
  updatedAt: number;
  stepId?: IntakeWizardStepId;
  wizard?: IntakeWizardMeta;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const isWizardStepId = (value: unknown): value is IntakeWizardStepId =>
  typeof value === 'string' && (WIZARD_STEP_IDS as readonly string[]).includes(value as string);

const coerceWizardMeta = (candidate: unknown): IntakeWizardMeta | null => {
  if (!isPlainObject(candidate)) {
    return null;
  }
  const includeAttachments =
    typeof candidate.includeAttachments === 'boolean'
      ? candidate.includeAttachments
      : DEFAULT_WIZARD_META.includeAttachments;
  return { includeAttachments };
};

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
    const parsed = JSON.parse(raw) as {
      submission?: unknown;
      updatedAt?: unknown;
      stepId?: unknown;
      wizard?: unknown;
    };
    if (!parsed.submission || typeof parsed.updatedAt !== 'number') {
      return null;
    }
    const submission = coercePortalSubmission(parsed.submission);
    if (!submission) {
      return null;
    }
    const stepId = isWizardStepId(parsed.stepId) ? parsed.stepId : undefined;
    const wizard = coerceWizardMeta(parsed.wizard) ?? DEFAULT_WIZARD_META;
    return { submission, updatedAt: parsed.updatedAt, stepId, wizard };
  } catch {
    return null;
  }
};

const writeDraftEnvelope = (envelope: IntakeDraftEnvelope): void => {
  if (typeof window === 'undefined' || !window.localStorage) {
    return;
  }
  try {
    window.localStorage.setItem(
      INTAKE_DRAFT_STORAGE_KEY,
      JSON.stringify({
        ...envelope,
        wizard: envelope.wizard ?? DEFAULT_WIZARD_META
      })
    );
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
  const [wizardMeta, setWizardMeta] = useState<IntakeWizardMeta>(DEFAULT_WIZARD_META);
  const [currentStepId, setCurrentStepId] = useState<IntakeWizardStepId>('practice');
  const restoredStepIdRef = useRef<IntakeWizardStepId | null>(null);
  const interpreterPreferredLanguagesSignature = useMemo(
    () => (interpreterPreferences.preferredLanguages ?? []).join('|'),
    [interpreterPreferences.preferredLanguages]
  );
  const sanitizedPatientId = useMemo(
    () => sanitizeText(formData.patient.id ?? '', 120),
    [formData.patient.id]
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
  const attachmentsChoiceId = useId();
  const attachmentsHelpId = useId();

  const wizardSteps = useMemo(
    () =>
      createIntakeWizardSteps(intakeSchema as ObjectJsonSchema, {
        accessibilityEnabled: accessibilityConfig.enabled,
        includeAttachments: wizardMeta.includeAttachments
      }),
    [accessibilityConfig.enabled, wizardMeta.includeAttachments]
  );

  const currentStep = useMemo(
    () => wizardSteps.find((step) => step.id === currentStepId) ?? wizardSteps[0],
    [wizardSteps, currentStepId]
  );

  const currentStepIndex = useMemo(
    () => findStepIndex(wizardSteps, currentStep?.id ?? currentStepId),
    [wizardSteps, currentStep, currentStepId]
  );

  const previousStepId = useMemo(
    () => getPreviousStepId(wizardSteps, currentStep?.id ?? currentStepId),
    [wizardSteps, currentStep, currentStepId]
  );

  const nextStepId = useMemo(
    () => getNextStepId(wizardSteps, currentStep?.id ?? currentStepId),
    [wizardSteps, currentStep, currentStepId]
  );

  useEffect(() => {
    if (!wizardSteps.length) {
      return;
    }
    if (restoredStepIdRef.current) {
      const desired = restoredStepIdRef.current;
      restoredStepIdRef.current = null;
      if (findStepIndex(wizardSteps, desired) !== -1) {
        setCurrentStepId(desired);
        return;
      }
    }
    if (findStepIndex(wizardSteps, currentStepId) === -1) {
      setCurrentStepId(wizardSteps[wizardSteps.length - 1].id);
    }
  }, [wizardSteps, currentStepId]);

  useEffect(() => {
    const envelope = readDraftEnvelope();
    if (!envelope) return;
    setFormData(envelope.submission);
    setWizardMeta(envelope.wizard ?? DEFAULT_WIZARD_META);
    if (envelope.stepId) {
      restoredStepIdRef.current = envelope.stepId;
    }
    setFormResetKey((previous) => previous + 1);
    setAutosaveStatus('restored');
    setLastSavedAt(envelope.updatedAt);
    skipNextAutosaveRef.current = true;
  }, []);

  useEffect(() => {
    setFormErrors({});
    setShowValidationSummary(false);
    setShouldFocusErrorSummary(false);
  }, [currentStepId]);

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
    if (!sanitizedPatientId) {
      return;
    }
    persistPatientContext({ id: sanitizedPatientId });
  }, [sanitizedPatientId]);

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
        updatedAt: Date.now(),
        stepId: currentStepId,
        wizard: wizardMeta
      };
      writeDraftEnvelope(envelope);
      setAutosaveStatus('saved');
      setLastSavedAt(envelope.updatedAt);
    }, AUTOSAVE_DEBOUNCE_MS);
    autosaveTimeoutRef.current = timeout;

    return () => {
      window.clearTimeout(timeout);
    };
  }, [formData, hasSubmitted, currentStepId, wizardMeta]);

  const handleReset = () => {
    setFormData(buildInitialSubmission());
    setFormResetKey((previous) => previous + 1);
    setWizardMeta(DEFAULT_WIZARD_META);
    setCurrentStepId('practice');
    restoredStepIdRef.current = null;
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
    clearPatientContext();
  };

  const mapIssuesToErrors = useCallback(
    (issues: ValidationIssue[]): Record<string, string> => {
      const next: Record<string, string> = {};
      issues.forEach((issue) => {
        const path = issue.path ?? '';
        if (!path) {
          return;
        }
        let messageId: string;
        switch (issue.kind) {
          case 'required':
            messageId = 'schemaForm.error.required';
            break;
          case 'enum':
            messageId = 'schemaForm.error.invalidOption';
            break;
          case 'format-date':
            messageId = 'schemaForm.error.invalidDate';
            break;
          case 'format-uri':
            messageId = 'schemaForm.error.invalidUrl';
            break;
          case 'type':
            messageId = 'schemaForm.error.invalidValue';
            break;
          case 'min-items':
            messageId = 'schemaForm.error.minItems';
            break;
          case 'max-items':
            messageId = 'schemaForm.error.maxItems';
            break;
          case 'minimum':
            messageId = 'schemaForm.error.minValue';
            break;
          case 'maximum':
            messageId = 'schemaForm.error.maxValue';
            break;
          case 'multiple-of':
            messageId = 'schemaForm.error.multipleOf';
            break;
          case 'min-length':
            messageId = 'schemaForm.error.minLength';
            break;
          case 'max-length':
            messageId = 'schemaForm.error.maxLength';
            break;
          case 'pattern':
            messageId = 'schemaForm.error.pattern';
            break;
          case 'additional-property':
            messageId = 'schemaForm.error.additionalProperty';
            break;
          default:
            messageId = 'schemaForm.error.required';
        }
        next[path] = intl.formatMessage({ id: messageId });
      });
      return next;
    },
    [intl]
  );

  const resolveStepForPath = useCallback(
    (path: string): IntakeWizardStepId => {
      if (path.startsWith('practiceId') || path.startsWith('channel')) {
        return 'practice';
      }
      if (path.startsWith('patient') || path.startsWith('interpreterPreferences')) {
        return 'patient';
      }
      if (path.startsWith('narrative')) {
        return 'details';
      }
      if (path.startsWith('attachments')) {
        return findStepIndex(wizardSteps, 'attachments') === -1 ? 'details' : 'attachments';
      }
      return 'practice';
    },
    [wizardSteps]
  );

  const handleStepSelect = useCallback(
    (stepId: string) => {
      if (!isWizardStepId(stepId)) {
        return;
      }
      setCurrentStepId(stepId);
      setShowValidationSummary(false);
      setShouldFocusErrorSummary(false);
    },
    []
  );

  const handleNextStep = useCallback(() => {
    if (currentStep?.schema && schemaFormRef.current) {
      const valid = schemaFormRef.current.validateAll();
      if (!valid) {
        setShowValidationSummary(true);
        setShouldFocusErrorSummary(true);
        return;
      }
    }
    setFormErrors({});
    setShowValidationSummary(false);
    setShouldFocusErrorSummary(false);
    const nextStepId = getNextStepId(wizardSteps, currentStep?.id ?? currentStepId);
    if (nextStepId) {
      setCurrentStepId(nextStepId);
    }
  }, [currentStep, currentStepId, wizardSteps]);

  const handlePreviousStep = useCallback(() => {
    const previousStepId = getPreviousStepId(wizardSteps, currentStep?.id ?? currentStepId);
    if (previousStepId) {
      setCurrentStepId(previousStepId);
      setShowValidationSummary(false);
      setShouldFocusErrorSummary(false);
    }
  }, [currentStep, currentStepId, wizardSteps]);

  const handleAttachmentIntent = useCallback(
    (shouldInclude: boolean) => {
      setWizardMeta((prev) =>
        prev.includeAttachments === shouldInclude ? prev : { includeAttachments: shouldInclude }
      );
      if (!shouldInclude) {
        setFormData((prev) => ({ ...prev, attachments: [] }));
      }
    },
    []
  );

  const handleSkipAttachments = useCallback(() => {
    handleAttachmentIntent(false);
    const nextStepId = getNextStepId(wizardSteps, 'attachments') ?? 'review';
    setCurrentStepId(nextStepId);
  }, [handleAttachmentIntent, wizardSteps]);

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

    if (currentStep?.id !== 'review') {
      handleNextStep();
      return;
    }

    if (isSubmitting) {
      return;
    }

    const baseSubmission = sanitizeSubmission(formData);
    const validationIssues = collectValidationIssues(intakeSchema, baseSubmission);
    if (validationIssues.length > 0) {
      const nextErrors = mapIssuesToErrors(validationIssues);
      setFormErrors(nextErrors);
      setShowValidationSummary(true);
      setShouldFocusErrorSummary(true);
      const firstPath = Object.keys(nextErrors)[0];
      if (firstPath) {
        const nextStep = resolveStepForPath(firstPath);
        if (nextStep !== currentStepId) {
          setCurrentStepId(nextStep);
        }
      }
      return;
    }

    setFormErrors({});
    setShowValidationSummary(false);
    setShouldFocusErrorSummary(false);

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

  const renderReview = () => {
    const emptyValue = intl.formatMessage({ id: 'intake.wizard.review.empty' });
    const sanitizedAttachments = sanitizeAttachments(formData.attachments);
    const attachmentsStepTarget =
      findStepIndex(wizardSteps, 'attachments') === -1 ? 'details' : 'attachments';
    const patientLocaleLabel = formData.patient.locale
      ? intl.formatMessage({
          id: `locale.name.${formData.patient.locale}`,
          defaultMessage: formData.patient.locale
        })
      : emptyValue;
    const patientDobLabel = formData.patient.dob
      ? intl.formatDate(`${formData.patient.dob}T00:00:00Z`, {
          timeZone: 'UTC'
        })
      : emptyValue;
    const interpreterLanguagesList = (interpreterPreferences.preferredLanguages ?? []).map((lang) =>
      intl.formatMessage({ id: `locale.name.${lang}`, defaultMessage: lang })
    );
    const interpreterLanguageText = interpreterLanguagesList.length
      ? intl.formatList(interpreterLanguagesList, { type: 'conjunction' })
      : intl.formatMessage({ id: 'intake.wizard.review.interpreter.anyLanguage' });

    return (
      <section
        className="wizard-review"
        aria-label={intl.formatMessage({ id: 'intake.wizard.review.title' })}
      >
        <article className="wizard-review__section">
          <header className="wizard-review__header">
            <h3>{intl.formatMessage({ id: 'intake.wizard.review.practice' })}</h3>
            <button
              type="button"
              className="wizard-review__edit"
              onClick={() => handleStepSelect('practice')}
            >
              {intl.formatMessage({ id: 'intake.wizard.review.change' })}
            </button>
          </header>
          <dl className="wizard-review__list">
            <div>
              <dt>{intl.formatMessage({ id: 'intake.practiceId.label' })}</dt>
              <dd>{formData.practiceId || emptyValue}</dd>
            </div>
            <div>
              <dt>{intl.formatMessage({ id: 'intake.channel.legend' })}</dt>
              <dd>
                {intl.formatMessage({
                  id:
                    formData.channel === 'ivr'
                      ? 'intake.channel.option.ivr'
                      : 'intake.channel.option.web'
                })}
              </dd>
            </div>
          </dl>
        </article>

        <article className="wizard-review__section">
          <header className="wizard-review__header">
            <h3>{intl.formatMessage({ id: 'intake.wizard.review.patient' })}</h3>
            <button
              type="button"
              className="wizard-review__edit"
              onClick={() => handleStepSelect('patient')}
            >
              {intl.formatMessage({ id: 'intake.wizard.review.change' })}
            </button>
          </header>
          <dl className="wizard-review__list">
            <div>
              <dt>{intl.formatMessage({ id: 'intake.patientId.label' })}</dt>
              <dd>{formData.patient.id || emptyValue}</dd>
            </div>
            <div>
              <dt>{intl.formatMessage({ id: 'intake.patient.dob.label' })}</dt>
              <dd>
                {patientDobLabel}
              </dd>
            </div>
            <div>
              <dt>{intl.formatMessage({ id: 'intake.patient.locale.label' })}</dt>
              <dd>{patientLocaleLabel}</dd>
            </div>
            <div>
              <dt>{intl.formatMessage({ id: 'intake.interpreter.checkbox' })}</dt>
              <dd>
                {interpreterPreferences.requiresInterpreter
                  ? intl.formatMessage(
                      { id: 'intake.wizard.review.interpreter.required' },
                      { languages: interpreterLanguageText }
                    )
                  : intl.formatMessage({ id: 'intake.wizard.review.interpreter.notRequired' })}
                {interpreterPreferences.notes ? (
                  <span className="wizard-review__note">
                    {intl.formatMessage(
                      { id: 'intake.wizard.review.interpreter.notes' },
                      { notes: interpreterPreferences.notes }
                    )}
                  </span>
                ) : null}
              </dd>
            </div>
          </dl>
        </article>

        <article className="wizard-review__section">
          <header className="wizard-review__header">
            <h3>{intl.formatMessage({ id: 'intake.wizard.review.details' })}</h3>
            <button
              type="button"
              className="wizard-review__edit"
              onClick={() => handleStepSelect('details')}
            >
              {intl.formatMessage({ id: 'intake.wizard.review.change' })}
            </button>
          </header>
          <p className="wizard-review__narrative">{formData.narrative || emptyValue}</p>
        </article>

        {(wizardMeta.includeAttachments || sanitizedAttachments.length > 0) && (
          <article className="wizard-review__section">
            <header className="wizard-review__header">
              <h3>{intl.formatMessage({ id: 'intake.wizard.review.attachments' })}</h3>
              <button
                type="button"
                className="wizard-review__edit"
                onClick={() => handleStepSelect(attachmentsStepTarget)}
              >
                {intl.formatMessage({ id: 'intake.wizard.review.change' })}
              </button>
            </header>
            {sanitizedAttachments.length > 0 ? (
              <ul className="wizard-review__attachments">
                {sanitizedAttachments.map((attachment, index) => (
                  <li key={`${attachment.url}-${index}`}>
                    <span>{attachment.contentType}</span>
                    <a href={attachment.url} target="_blank" rel="noopener noreferrer">
                      {attachment.url}
                    </a>
                  </li>
                ))}
              </ul>
            ) : (
              <p>{intl.formatMessage({ id: 'intake.wizard.review.none' })}</p>
            )}
          </article>
        )}
      </section>
    );
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
      <StepIndicator
        steps={wizardSteps}
        currentStepId={currentStep?.id ?? currentStepId}
        onStepSelect={handleStepSelect}
      />

      <header className="wizard-header">
        <h2>{intl.formatMessage({ id: currentStep?.titleId ?? 'intake.wizard.review.title' })}</h2>
        {currentStep?.descriptionId ? (
          <p>{intl.formatMessage({ id: currentStep.descriptionId })}</p>
        ) : null}
      </header>

      <ErrorSummary errors={showValidationSummary ? errorSummaryItems : []} autoFocus={shouldFocusErrorSummary} />

      {autosaveMessage ? (
        <div className="autosave-status" role="status" aria-live="polite">
          {autosaveMessage}
        </div>
      ) : null}

      {currentStep?.schema ? (
        <SchemaForm
          key={`${formResetKey}-${currentStep.id}`}
          ref={schemaFormRef}
          schema={currentStep.schema}
          value={formData}
          onChange={(next) => setFormData(next)}
          onErrorsChange={setFormErrors}
        />
      ) : (
        renderReview()
      )}

      {currentStep?.id === 'patient' && accessibilityConfig.enabled ? (
        <InterpreterPreferences
          config={accessibilityConfig}
          value={interpreterPreferences}
          onChange={handleInterpreterPreferencesChange}
          allowPersistence={allowInterpreterPersistence}
        />
      ) : null}

      {currentStep?.id === 'details' ? (
        <section
          className="wizard-panel"
          aria-labelledby={attachmentsChoiceId}
          aria-describedby={attachmentsHelpId}
        >
          <h3 id={attachmentsChoiceId}>{intl.formatMessage({ id: 'intake.wizard.attachments.prompt' })}</h3>
          <p id={attachmentsHelpId}>{intl.formatMessage({ id: 'intake.wizard.attachments.help' })}</p>
          <div className="wizard-panel__choices">
            <button
              type="button"
              className={classNames('wizard-choice', wizardMeta.includeAttachments ? 'wizard-choice--active' : '')}
              aria-pressed={wizardMeta.includeAttachments}
              onClick={() => handleAttachmentIntent(true)}
            >
              {intl.formatMessage({ id: 'intake.wizard.attachments.toggle.add' })}
            </button>
            <button
              type="button"
              className={classNames('wizard-choice', !wizardMeta.includeAttachments ? 'wizard-choice--active' : '')}
              aria-pressed={!wizardMeta.includeAttachments}
              onClick={() => handleAttachmentIntent(false)}
            >
              {intl.formatMessage({ id: 'intake.wizard.attachments.toggle.skip' })}
            </button>
          </div>
        </section>
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

      <div className="wizard-actions">
        <Button type="button" variant="subtle" onClick={handlePreviousStep} disabled={!previousStepId}>
          {intl.formatMessage({ id: 'intake.wizard.back' })}
        </Button>
        {currentStep?.id === 'attachments' && currentStep.optional ? (
          <Button type="button" variant="subtle" onClick={handleSkipAttachments}>
            {intl.formatMessage({ id: 'intake.wizard.skipAttachments' })}
          </Button>
        ) : null}
        {currentStep?.id === 'review' ? (
          <SubmitButton disabled={isSubmitting} />
        ) : (
          <Button type="button" onClick={handleNextStep} disabled={isSubmitting || !nextStepId}>
            {intl.formatMessage({ id: 'intake.wizard.next' })}
          </Button>
        )}
      </div>
    </form>
  );
};

export default IntakeForm;

export const __intakeDraftHelpers = {
  coercePortalSubmission
};
