import { FormEvent, useEffect, useId, useRef, useState } from 'react';
import { submitIntake } from '../lib/api';
import type { ErrorEnvelope, PortalSubmission, SafetyDecision } from '../lib/types';
import ErrorAlert from './ErrorAlert';

const buildInitialSubmission = (): PortalSubmission => ({
  practiceId: '',
  patient: {
    id: ''
  },
  channel: 'web',
  narrative: ''
});

const IntakeForm = () => {
  const [formData, setFormData] = useState<PortalSubmission>(() => buildInitialSubmission());
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [hasSubmitted, setHasSubmitted] = useState(false);
  const [submitError, setSubmitError] = useState<ErrorEnvelope | null>(null);
  const [decision, setDecision] = useState<SafetyDecision | null>(null);
  const [decisionCorrelationId, setDecisionCorrelationId] = useState<string | undefined>();
  const abortControllerRef = useRef<AbortController | null>(null);

  const practiceIdInputId = useId();
  const patientIdInputId = useId();
  const narrativeInputId = useId();
  const narrativeHintId = useId();
  const channelFieldsetId = useId();
  const statusMessageId = useId();

  const handleReset = () => {
    setFormData(buildInitialSubmission());
    setHasSubmitted(false);
    setSubmitError(null);
    setDecision(null);
    setDecisionCorrelationId(undefined);
  };

  const normalizeErrorEnvelope = async (error: unknown): Promise<ErrorEnvelope> => {
    const fallback: ErrorEnvelope = {
      error: {
        code: 'internal_error',
        message: 'Something went wrong. Please try again.'
      }
    };

    if (!error) {
      return fallback;
    }

    if (typeof error === 'object' && error !== null) {
      const withEnvelope = error as { envelope?: ErrorEnvelope };
      if (withEnvelope.envelope?.error) {
        const envelope = withEnvelope.envelope;
        return {
          correlationId: envelope.correlationId,
          error: {
            code: envelope.error.code,
            message: envelope.error.message ?? fallback.error.message,
            details: envelope.error.details
          }
        };
      }
    }

    if (error instanceof Response) {
      try {
        const payload = await error.json();
        if (payload && typeof payload === 'object' && 'error' in payload) {
          const envelope = payload as ErrorEnvelope;
          if (envelope.error && typeof envelope.error.code === 'string') {
            return {
              correlationId: envelope.correlationId,
              error: {
                code: envelope.error.code,
                message: envelope.error.message ?? fallback.error.message,
                details: envelope.error.details
              }
            };
          }
        }
      } catch {
        return fallback;
      }
      return fallback;
    }

    if (typeof error === 'object' && error !== null) {
      const candidate = error as {
        error?: { code?: string; message?: string; details?: Record<string, unknown> };
        correlationId?: string;
      };
      if (candidate.error && typeof candidate.error.code === 'string') {
        return {
          correlationId: candidate.correlationId,
          error: {
            code: candidate.error.code,
            message: candidate.error.message ?? fallback.error.message,
            details: candidate.error.details
          }
        };
      }
    }

    if (error instanceof Error) {
      return {
        error: {
          code: 'internal_error',
          message: error.message || fallback.error.message
        }
      };
    }

    return fallback;
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isSubmitting) {
      return;
    }
    setSubmitError(null);
    setDecision(null);
    setDecisionCorrelationId(undefined);
    setHasSubmitted(false);
    setIsSubmitting(true);

    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const result = await submitIntake(formData, { signal: controller.signal });
      setDecision(result.decision);
      setDecisionCorrelationId(result.correlationId);
      setHasSubmitted(true);
    } catch (error) {
      const envelope = await normalizeErrorEnvelope(error);
      setSubmitError(envelope);
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
      decision.outcome === 'SAFE_TO_CONTINUE' ? 'Safe to continue' : 'Divert for review';
    const defaultReason =
      decision.outcome === 'SAFE_TO_CONTINUE'
        ? 'No immediate safety risks detected.'
        : 'Our team will be alerted to follow up.';

    return (
      <section aria-labelledby={statusMessageId} role="status">
        <h2 id={statusMessageId}>{outcomeFriendly}</h2>
        <p>{decision.reason ?? defaultReason}</p>
        {decisionCorrelationId ? (
          <p>
            Reference: <code>{decisionCorrelationId}</code>
          </p>
        ) : null}
        <button type="button" onClick={handleReset}>
          Submit another response
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
        <h2 id={statusMessageId}>Submission received</h2>
        <p>Thanks for sharing the details. Our care team will review the information shortly.</p>
        <button type="button" onClick={handleReset}>
          Submit another response
        </button>
      </section>
    );
  }

  return (
    <form onSubmit={handleSubmit} aria-describedby={submitError ? statusMessageId : undefined}>
      <div>
        <label htmlFor={practiceIdInputId}>
          Practice ID <span aria-hidden="true">*</span>
        </label>
        <input
          id={practiceIdInputId}
          name="practiceId"
          type="text"
          required
          value={formData.practiceId}
          onChange={(event) =>
            setFormData((previous) => ({
              ...previous,
              practiceId: event.target.value
            }))
          }
        />
      </div>

      <div>
        <label htmlFor={patientIdInputId}>
          Patient ID <span aria-hidden="true">*</span>
        </label>
        <input
          id={patientIdInputId}
          name="patientId"
          type="text"
          required
          value={formData.patient.id}
          onChange={(event) =>
            setFormData((previous) => ({
              ...previous,
              patient: {
                ...previous.patient,
                id: event.target.value
              }
            }))
          }
        />
      </div>

      <fieldset id={channelFieldsetId}>
        <legend>
          Channel <span aria-hidden="true">*</span>
        </legend>
        <div>
          <input
            id={`${channelFieldsetId}-web`}
            type="radio"
            name="channel"
            value="web"
            checked={formData.channel === 'web'}
            onChange={() =>
              setFormData((previous) => ({
                ...previous,
                channel: 'web'
              }))
            }
          />
          <label htmlFor={`${channelFieldsetId}-web`}>Web</label>
        </div>
        <div>
          <input
            id={`${channelFieldsetId}-ivr`}
            type="radio"
            name="channel"
            value="ivr"
            checked={formData.channel === 'ivr'}
            onChange={() =>
              setFormData((previous) => ({
                ...previous,
                channel: 'ivr'
              }))
            }
          />
          <label htmlFor={`${channelFieldsetId}-ivr`}>Phone (IVR)</label>
        </div>
      </fieldset>

      <div>
        <label htmlFor={narrativeInputId}>
          Narrative <span aria-hidden="true">*</span>
        </label>
        <p id={narrativeHintId}>Share a concise description of the concern. Do not include sensitive details you would not want stored.</p>
        <textarea
          id={narrativeInputId}
          name="narrative"
          required
          aria-describedby={narrativeHintId}
          value={formData.narrative}
          onChange={(event) =>
            setFormData((previous) => ({
              ...previous,
              narrative: event.target.value
            }))
          }
          rows={6}
        />
      </div>

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

      <button type="submit" disabled={isSubmitting}>
        {isSubmitting ? 'Submitting…' : 'Submit'}
      </button>
    </form>
  );
};

export default IntakeForm;
