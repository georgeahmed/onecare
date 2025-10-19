import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import type { BookingSlot } from '../../lib/booking';
import { confirmBooking, type BookingApiError, type ConfirmBookingResult } from '../../lib/api';
import {
  enqueueOfflineJob,
  getOfflineJob,
  removeOfflineJob,
  subscribeOfflineQueue,
  updateOfflineJob,
  type OfflineBookingJob,
} from '../../lib/offlineQueue';
import { createCorrelationId, recordRumEvent, safeLog, startTimer } from '../../lib/telemetry';
import { formatAccessibleDateTime, formatDate, formatTimeRange, formatTimeZoneName } from '../../lib/format';
import { useLocale } from '../../i18n';

const BASE_BACKOFF_MS = 1_500;
const MAX_BACKOFF_MS = 30_000;
const RETRY_JITTER_MAX_MS = 750;
const isBrowser = typeof window !== 'undefined';

const isNavigatorOnline = (): boolean => {
  if (typeof navigator === 'undefined' || typeof navigator.onLine !== 'boolean') {
    return true;
  }
  return navigator.onLine;
};

type QueueStatus = 'idle' | 'queued' | 'processing';

export interface ConfirmBookingProps {
  slot: BookingSlot;
  patientId: string;
  idempotencyKey: string;
  timezone: string;
  onBack: () => void;
  onSuccess: (result: ConfirmBookingResult) => void;
  onError: (error: BookingConfirmationError) => void;
}

export interface ConfirmBookingContentProps {
  slot: BookingSlot;
  patientId: string;
  idempotencyKey: string;
  timezone: string;
  isSubmitting: boolean;
  statusMessageId: string;
  onBack: () => void;
  onConfirm: () => void;
  titleId?: string;
  descriptionId?: string;
  queueJob: OfflineBookingJob | null;
  queueStatus: QueueStatus;
  retryCountdown: number | null;
  onRetryQueued: () => void;
  onCancelQueued: () => void;
}

export interface BookingConfirmationError {
  code?: string;
  message: string;
  correlationId?: string;
  retryAfterSeconds?: number;
  status?: number;
}

const ConfirmBookingSkeleton = () => (
  <div className="booking-confirm-skeleton" aria-hidden="true">
    <div className="booking-confirm-skeleton__header skeleton skeleton-line long" />
    <div className="booking-confirm-skeleton__grid">
      {Array.from({ length: 6 }, (_, index) => (
        <div key={index} className="booking-confirm-skeleton__row">
          <span className="skeleton skeleton-line short" />
          <span className="skeleton skeleton-line long" />
        </div>
      ))}
    </div>
  </div>
);

export const ConfirmBookingContent = ({
  slot,
  patientId,
  idempotencyKey,
  timezone,
  isSubmitting,
  statusMessageId,
  onBack,
  onConfirm,
  titleId,
  descriptionId,
  queueJob,
  queueStatus,
  retryCountdown,
  onRetryQueued,
  onCancelQueued,
}: ConfirmBookingContentProps) => {
  const intl = useIntl();
  const { direction } = useLocale();
  const resolvedTitleId = titleId ?? 'booking-confirm-title';
  const resolvedDescriptionId = descriptionId ?? `${resolvedTitleId}-description`;

  const locale = intl.locale;
  const dateLabel = useMemo(
    () => formatDate(slot.start, { locale, timeZone: timezone, dateStyle: 'full' }),
    [slot.start, locale, timezone],
  );

  const timeLabel = useMemo(
    () => formatTimeRange(slot.start, slot.end, { locale, timeZone: timezone }),
    [slot.start, slot.end, locale, timezone],
  );

  const accessibleStart = useMemo(
    () => formatAccessibleDateTime(slot.start, { locale, timeZone: timezone }),
    [slot.start, locale, timezone],
  );

  const accessibleEnd = useMemo(
    () => formatAccessibleDateTime(slot.end, { locale, timeZone: timezone }),
    [slot.end, locale, timezone],
  );

  const accessibleRange = useMemo(() => `${accessibleStart} – ${accessibleEnd}`, [accessibleStart, accessibleEnd]);
  const timeZoneLabel = useMemo(() => formatTimeZoneName(timezone, { locale }), [timezone, locale]);

  const modalityLabel = intl.formatMessage({ id: `booking.modality.${slot.modality}` });
  const locationLabel = slot.location ?? intl.formatMessage({ id: 'booking.location.unassigned' });

  const submittingLabel = intl.formatMessage({ id: 'booking.confirm.submitting' });
  const confirmLabel = intl.formatMessage({ id: 'booking.confirm.submit' });
  const statusLabel = isSubmitting ? submittingLabel : '';

  return (
    <section
      aria-labelledby={resolvedTitleId}
      aria-describedby={`${resolvedDescriptionId}${statusLabel ? ` ${statusMessageId}` : ''}`}
      dir={direction}
    >
      <header>
        <h2 id={resolvedTitleId}>{intl.formatMessage({ id: 'booking.confirm.title' })}</h2>
        <p id={resolvedDescriptionId}>{intl.formatMessage({ id: 'booking.confirm.summary' })}</p>
      </header>

      <div
        className={['booking-confirm-summary-container', (isSubmitting || queueStatus === 'processing') ? 'booking-confirm-summary-container--loading' : '']
          .filter(Boolean)
          .join(' ')}
      >
        <dl className="booking-confirm-summary">
          <div>
            <dt>{intl.formatMessage({ id: 'booking.confirm.patient' })}</dt>
            <dd>{patientId}</dd>
          </div>
          <div>
            <dt>{intl.formatMessage({ id: 'booking.confirm.date' })}</dt>
            <dd>
              <span aria-hidden="true">{dateLabel}</span>
              <span className="visually-hidden">{accessibleStart}</span>
            </dd>
          </div>
          <div>
            <dt>{intl.formatMessage({ id: 'booking.confirm.time' })}</dt>
            <dd>
              <span aria-hidden="true">{timeLabel}</span>
              <span className="visually-hidden">{accessibleRange}</span>
            </dd>
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
            <dt>{intl.formatMessage({ id: 'booking.confirm.timeZone' })}</dt>
            <dd>
              <span aria-hidden="true">{timeZoneLabel}</span>
              <span className="visually-hidden">{timezone}</span>
            </dd>
          </div>
          <div>
            <dt>{intl.formatMessage({ id: 'booking.confirm.idempotencyKey' })}</dt>
            <dd>
              <code>{idempotencyKey}</code>
            </dd>
          </div>
        </dl>
        {(isSubmitting || queueStatus === 'processing') ? <ConfirmBookingSkeleton /> : null}
      </div>

      <div id={statusMessageId} aria-live="polite" role="status">
        {statusLabel}
      </div>

      <div className="booking-confirm-actions">
        <button
          type="button"
          className="ui-button ui-button--subtle"
          onClick={onBack}
          disabled={isSubmitting || queueStatus === 'processing'}
        >
          {intl.formatMessage({ id: 'booking.confirm.back' })}
        </button>
        <button
          type="button"
          className="ui-button"
          onClick={onConfirm}
          disabled={isSubmitting || queueStatus === 'processing' || Boolean(queueJob)}
          aria-describedby={statusLabel ? statusMessageId : undefined}
        >
          {isSubmitting ? submittingLabel : confirmLabel}
        </button>
      </div>

      {queueJob ? (
        <div className="booking-offline-banner" role="status">
          <p className="booking-offline-banner__title">
            {intl.formatMessage({
              id: queueStatus === 'processing' ? 'booking.confirm.offline.processing' : 'booking.confirm.offline.queued',
            })}
          </p>
          <p className="booking-offline-banner__body">
            {queueStatus === 'processing'
              ? intl.formatMessage({ id: 'booking.confirm.offline.inProgress' })
              : retryCountdown !== null
                ? intl.formatMessage(
                    { id: 'booking.confirm.offline.autoResume' },
                    { seconds: Math.max(retryCountdown, 0) },
                  )
                : intl.formatMessage({ id: 'booking.confirm.offline.waiting' })}
          </p>
          {queueJob.lastError ? (
            <p className="booking-offline-banner__error">
              {intl.formatMessage({ id: 'booking.confirm.offline.lastError' })}{' '}
              <span>{queueJob.lastError}</span>
            </p>
          ) : null}
          <div className="booking-offline-actions">
            <button
              type="button"
              className="ui-button"
              onClick={onRetryQueued}
              disabled={queueStatus === 'processing'}
            >
              {intl.formatMessage({ id: 'booking.confirm.offline.retryNow' })}
            </button>
            <button
              type="button"
              className="ui-button ui-button--subtle"
              onClick={onCancelQueued}
              disabled={queueStatus === 'processing'}
            >
              {intl.formatMessage({ id: 'booking.confirm.offline.cancel' })}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
};

const getFocusableElements = (container: HTMLElement): HTMLElement[] =>
  Array.from(
    container.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    )
  ).filter((element) => !element.hasAttribute('disabled') && !element.getAttribute('aria-hidden'));

const ConfirmBooking = ({ slot, patientId, idempotencyKey, timezone, onBack, onSuccess, onError }: ConfirmBookingProps) => {
  const intl = useIntl();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const statusMessageId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();
  const confirmCorrelationRef = useRef<string>(createCorrelationId());
  const [queueJob, setQueueJob] = useState<OfflineBookingJob | null>(() => getOfflineJob(idempotencyKey) ?? null);
  const [queueStatus, setQueueStatus] = useState<QueueStatus>(() => (getOfflineJob(idempotencyKey) ? 'queued' : 'idle'));
  const [retryCountdown, setRetryCountdown] = useState<number | null>(null);
  const countdownTimerRef = useRef<number | null>(null);

  const clearCountdownTimer = useCallback(() => {
    if (countdownTimerRef.current !== null) {
      window.clearInterval(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }
  }, []);

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

  const processQueuedJob = useCallback(
    async (job: OfflineBookingJob) => {
      setQueueStatus('processing');
      confirmCorrelationRef.current = job.correlationId;
      recordRumEvent('booking.confirm.retry.start', {
        correlationId: job.correlationId,
        attempt: job.attempt,
        slotId: job.payload.slotId,
      });
      safeLog('booking.confirm.retry.start', {
        correlationId: job.correlationId,
        attempt: job.attempt,
      });
      const stopTimer = startTimer();
      try {
        const result = await confirmBooking(
          {
            slotId: job.payload.slotId,
            patientId: job.payload.patientId,
          },
          {
            idempotencyKey: job.idempotencyKey,
            correlationId: job.correlationId,
          },
        );
        removeOfflineJob(job.id);
        setQueueJob(null);
        setQueueStatus('idle');
        setRetryCountdown(null);
        const durationMs = stopTimer();
        recordRumEvent('booking.confirm.retry.success', {
          correlationId: job.correlationId,
          durationMs,
        });
        safeLog('booking.confirm.retry.success', {
          correlationId: job.correlationId,
          durationMs,
        });
        onSuccess(result);
      } catch (error) {
        const fallbackMessage = intl.formatMessage({ id: 'booking.confirm.error' });
        const message =
          error instanceof Error && typeof error.message === 'string' && error.message.trim().length > 0
            ? error.message
            : fallbackMessage;
        const attempts = job.attempt + 1;
        const jitter = Math.floor(Math.random() * RETRY_JITTER_MAX_MS);
        const delay = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempts) + jitter;
        const next = updateOfflineJob(job.id, {
          attempt: attempts,
          lastError: message,
          nextAttemptAt: Date.now() + delay,
        });
        setQueueJob(next ?? job);
        setQueueStatus('queued');
        const durationMs = stopTimer();
        recordRumEvent('booking.confirm.retry.error', {
          correlationId: job.correlationId,
          durationMs,
          attempt: attempts,
        });
        safeLog('booking.confirm.retry.error', {
          correlationId: job.correlationId,
          durationMs,
          message,
        });
      }
    },
    [intl, onSuccess],
  );

  useEffect(() => {
    const unsubscribe = subscribeOfflineQueue((jobs) => {
      const job = jobs.find((entry) => entry.id === idempotencyKey) ?? null;
      setQueueJob(job);
      setQueueStatus(job ? 'queued' : 'idle');
    });
    return unsubscribe;
  }, [idempotencyKey]);

  useEffect(() => {
    clearCountdownTimer();
    if (!queueJob || queueStatus === 'processing') {
      setRetryCountdown(null);
      return () => {};
    }

    const tick = () => {
      const latest = getOfflineJob(queueJob.id);
      if (!latest) {
        setRetryCountdown(null);
        clearCountdownTimer();
        return;
      }
      const remainingMs = latest.nextAttemptAt - Date.now();
      if (remainingMs <= 0) {
        setRetryCountdown(0);
        if (isNavigatorOnline()) {
          clearCountdownTimer();
          void processQueuedJob(latest);
        }
      } else {
        setRetryCountdown(Math.max(0, Math.ceil(remainingMs / 1000)));
      }
    };

    tick();
    countdownTimerRef.current = window.setInterval(tick, 1000);
    return () => clearCountdownTimer();
  }, [queueJob, queueStatus, clearCountdownTimer, processQueuedJob]);

  useEffect(() => {
    if (!isBrowser || !queueJob) return;
    const handleOnline = () => {
      const latest = getOfflineJob(queueJob.id);
      if (latest) {
        void processQueuedJob(latest);
      }
    };
    window.addEventListener('online', handleOnline);
    return () => window.removeEventListener('online', handleOnline);
  }, [queueJob, processQueuedJob]);

  const queueAndNotify = useCallback(() => {
    const job = enqueueOfflineJob({
      id: idempotencyKey,
      idempotencyKey,
      correlationId: createCorrelationId(),
      payload: {
        slotId: slot.id,
        patientId,
      },
      slot: {
        start: slot.start,
        end: slot.end,
        modality: slot.modality,
        location: slot.location,
      },
    });
    setQueueJob(job);
    setQueueStatus('queued');
    setRetryCountdown(0);
    confirmCorrelationRef.current = job.correlationId;
    recordRumEvent('booking.confirm.queued', {
      correlationId: job.correlationId,
      slotId: slot.id,
    });
    safeLog('booking.confirm.queued', {
      correlationId: job.correlationId,
      slotId: slot.id,
    });
  }, [idempotencyKey, patientId, slot]);

  const handleRetryQueued = useCallback(() => {
    const job = getOfflineJob(idempotencyKey);
    if (!job) return;
    const updated = updateOfflineJob(job.id, {
      nextAttemptAt: Date.now(),
      lastError: undefined,
    }) ?? job;
    setQueueJob(updated);
    setQueueStatus('processing');
    setRetryCountdown(0);
    recordRumEvent('booking.confirm.retry.manual', {
      correlationId: updated.correlationId,
      attempt: updated.attempt,
    });
    safeLog('booking.confirm.retry.manual', {
      correlationId: updated.correlationId,
      attempt: updated.attempt,
    });
    void processQueuedJob(updated);
  }, [idempotencyKey, processQueuedJob]);

  const handleCancelQueued = useCallback(() => {
    removeOfflineJob(idempotencyKey);
    setQueueJob(null);
    setQueueStatus('idle');
    setRetryCountdown(null);
    clearCountdownTimer();
    recordRumEvent('booking.confirm.retry.cancelled', { correlationId: confirmCorrelationRef.current });
    safeLog('booking.confirm.retry.cancelled', { correlationId: confirmCorrelationRef.current });
  }, [idempotencyKey, clearCountdownTimer]);

  const handleConfirm = async () => {
    if (isSubmitting || queueStatus === 'processing') return;

    if (!isNavigatorOnline()) {
      queueAndNotify();
      return;
    }

    const correlationId = createCorrelationId();
    confirmCorrelationRef.current = correlationId;
    recordRumEvent('booking.confirm.start', {
      correlationId,
      slotId: slot.id,
    });
    safeLog('booking.confirm.start', { correlationId, slotId: slot.id });

    setIsSubmitting(true);
    const stopTimer = startTimer();

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
          signal: controller.signal,
          correlationId,
        }
      );
      const durationMs = stopTimer();
      recordRumEvent('booking.confirm.success', {
        correlationId,
        durationMs,
      });
      safeLog('booking.confirm.success', {
        correlationId,
        durationMs,
        appointmentId: result.appointmentId,
      });
      onSuccess(result);
    } catch (error) {
      const fallbackMessage = intl.formatMessage({ id: 'booking.confirm.error' });
      const candidate = error as BookingApiError | Error;
      const networkLikeError = !('status' in candidate) || candidate.status === 0;
      if (!isNavigatorOnline() || networkLikeError) {
        queueAndNotify();
        return;
      }
      const durationMs = stopTimer();
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
      recordRumEvent('booking.confirm.error', {
        correlationId: confirmCorrelationRef.current,
        durationMs,
      });
      safeLog('booking.confirm.error', {
        correlationId: confirmCorrelationRef.current,
        durationMs,
        message: payload.message,
      });
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
          timezone={timezone}
          isSubmitting={isSubmitting}
          statusMessageId={statusMessageId}
          onBack={onBack}
          onConfirm={handleConfirm}
          titleId={titleId}
          descriptionId={descriptionId}
          queueJob={queueJob}
          queueStatus={queueStatus}
          retryCountdown={retryCountdown}
          onRetryQueued={handleRetryQueued}
          onCancelQueued={handleCancelQueued}
        />
      </div>
    </div>
  );
};

export default ConfirmBooking;
