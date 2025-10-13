import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import type { BookingSlot } from '../../lib/booking';
import { confirmBooking, type BookingApiError, type ConfirmBookingResult } from '../../lib/api';

export interface ConfirmBookingProps {
  slot: BookingSlot;
  patientId: string;
  idempotencyKey: string;
  onBack: () => void;
  onSuccess: (result: ConfirmBookingResult) => void;
  onError: (error: BookingConfirmationError) => void;
}

export interface ConfirmBookingContentProps {
  slot: BookingSlot;
  patientId: string;
  idempotencyKey: string;
  isSubmitting: boolean;
  statusMessageId: string;
  onBack: () => void;
  onConfirm: () => void;
  titleId?: string;
  descriptionId?: string;
}

export interface BookingConfirmationError {
  code?: string;
  message: string;
  correlationId?: string;
  retryAfterSeconds?: number;
  status?: number;
}

export const ConfirmBookingContent = ({
  slot,
  patientId,
  idempotencyKey,
  isSubmitting,
  statusMessageId,
  onBack,
  onConfirm,
  titleId,
  descriptionId,
}: ConfirmBookingContentProps & { titleId?: string; descriptionId?: string }) => {
  const intl = useIntl();
  const resolvedTitleId = titleId ?? 'booking-confirm-title';
  const resolvedDescriptionId = descriptionId ?? `${resolvedTitleId}-description`;

  const dateLabel = useMemo(
    () =>
      intl.formatDate(new Date(slot.start), {
        dateStyle: 'full'
      }),
    [slot.start, intl]
  );

  const timeLabel = useMemo(
    () =>
      `${intl.formatTime(new Date(slot.start), { timeStyle: 'short' })} – ${intl.formatTime(new Date(slot.end), { timeStyle: 'short' })}`,
    [slot.start, slot.end, intl]
  );

  const modalityLabel = intl.formatMessage({ id: `booking.modality.${slot.modality}` });
  const locationLabel = slot.location ?? intl.formatMessage({ id: 'booking.location.unassigned' });

  const submittingLabel = intl.formatMessage({ id: 'booking.confirm.submitting' });
  const confirmLabel = intl.formatMessage({ id: 'booking.confirm.submit' });
  const statusLabel = isSubmitting ? submittingLabel : '';

  return (
    <section
      aria-labelledby={resolvedTitleId}
      aria-describedby={`${resolvedDescriptionId}${statusLabel ? ` ${statusMessageId}` : ''}`}
    >
      <header>
        <h2 id={resolvedTitleId}>{intl.formatMessage({ id: 'booking.confirm.title' })}</h2>
        <p id={resolvedDescriptionId}>{intl.formatMessage({ id: 'booking.confirm.summary' })}</p>
      </header>

      <dl className="booking-confirm-summary">
        <div>
          <dt>{intl.formatMessage({ id: 'booking.confirm.patient' })}</dt>
          <dd>{patientId}</dd>
        </div>
        <div>
          <dt>{intl.formatMessage({ id: 'booking.confirm.date' })}</dt>
          <dd>{dateLabel}</dd>
        </div>
        <div>
          <dt>{intl.formatMessage({ id: 'booking.confirm.time' })}</dt>
          <dd>{timeLabel}</dd>
        </div>
        <div>
          <dt>{intl.formatMessage({ id: 'booking.confirm.modality' })}</dt>
          <dd>{modalityLabel}</dd>
        </div>
        <div>
          <dt>{intl.formatMessage({ id: 'booking.confirm.location' })}</dt>
          <dd>{locationLabel}</dd>
        </div>
        <div>
          <dt>{intl.formatMessage({ id: 'booking.confirm.idempotencyKey' })}</dt>
          <dd>
            <code>{idempotencyKey}</code>
          </dd>
        </div>
      </dl>

      <div id={statusMessageId} aria-live="polite" role="status">
        {statusLabel}
      </div>

      <div className="booking-confirm-actions">
        <button type="button" onClick={onBack} disabled={isSubmitting}>
          {intl.formatMessage({ id: 'booking.confirm.back' })}
        </button>
        <button type="button" onClick={onConfirm} disabled={isSubmitting} aria-describedby={statusLabel ? statusMessageId : undefined}>
          {isSubmitting ? submittingLabel : confirmLabel}
        </button>
      </div>
    </section>
  );
};

const getFocusableElements = (container: HTMLElement): HTMLElement[] =>
  Array.from(
    container.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    )
  ).filter((element) => !element.hasAttribute('disabled') && !element.getAttribute('aria-hidden'));

const ConfirmBooking = ({ slot, patientId, idempotencyKey, onBack, onSuccess, onError }: ConfirmBookingProps) => {
  const intl = useIntl();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const statusMessageId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
    const focusables = getFocusableElements(dialog);
    (focusables[0] ?? dialog).focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onBack();
        return;
      }
      if (event.key !== 'Tab') return;

      const elements = getFocusableElements(dialog);
      if (elements.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = elements[0];
      const last = elements[elements.length - 1];
      const active = document.activeElement as HTMLElement | null;

      if (event.shiftKey) {
        if (!active || active === first) {
          event.preventDefault();
          last.focus();
        }
      } else if (active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    dialog.addEventListener('keydown', handleKeyDown);

    return () => {
      dialog.removeEventListener('keydown', handleKeyDown);
      previouslyFocusedRef.current?.focus?.();
    };
  }, [onBack]);

  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
    };
  }, []);

  const handleConfirm = async () => {
    if (isSubmitting) return;
    setIsSubmitting(true);

    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const result = await confirmBooking(
        {
          slotId: slot.id,
          patientId
        },
        {
          idempotencyKey,
          signal: controller.signal
        }
      );
      onSuccess(result);
    } catch (error) {
      const fallbackMessage = intl.formatMessage({ id: 'booking.confirm.error' });
      const candidate = error as BookingApiError | Error;
      const message =
        candidate instanceof Error && typeof candidate.message === 'string' && candidate.message.trim().length > 0
          ? candidate.message
          : fallbackMessage;
      const correlationId =
        'envelope' in candidate && candidate.envelope?.error?.correlationId
          ? candidate.envelope.error.correlationId
          : 'correlationId' in candidate
            ? candidate.correlationId
            : undefined;
      const payload: BookingConfirmationError = {
        code: 'code' in candidate ? candidate.code : undefined,
        message,
        correlationId,
        retryAfterSeconds: 'retryAfterSeconds' in candidate ? candidate.retryAfterSeconds : undefined,
        status: 'status' in candidate ? candidate.status : undefined
      };
      onError(payload);
    } finally {
      setIsSubmitting(false);
      abortControllerRef.current = null;
    }
  };

  return (
    <div className="booking-dialog-backdrop" role="presentation">
      <div
        className="booking-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={`${descriptionId} ${statusMessageId}`}
        ref={dialogRef}
        tabIndex={-1}
      >
        <ConfirmBookingContent
          slot={slot}
          patientId={patientId}
          idempotencyKey={idempotencyKey}
          isSubmitting={isSubmitting}
          statusMessageId={statusMessageId}
          onBack={onBack}
          onConfirm={handleConfirm}
          titleId={titleId}
          descriptionId={descriptionId}
        />
      </div>
    </div>
  );
};

export default ConfirmBooking;
