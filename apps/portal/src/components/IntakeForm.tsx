import { FormEvent, useId, useState } from 'react';
import { submitIntake } from '../lib/api';
import { PortalSubmission } from '../lib/types';

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
  const [submitError, setSubmitError] = useState<string | null>(null);

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
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isSubmitting) {
      return;
    }
    setSubmitError(null);
    setIsSubmitting(true);

    try {
      await submitIntake(formData);
      setHasSubmitted(true);
    } catch (error) {
      setSubmitError('We could not submit the form. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

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
        <div id={statusMessageId} role="alert">
          {submitError}
        </div>
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
