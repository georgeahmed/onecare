import { useEffect, useMemo, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import type { BookingFilterState, BookingSlot } from '../../lib/booking';
import type { BookingConfirmationError } from './ConfirmBooking';
import { formatDate, formatTime, resolveLocalePreferences } from '../../lib/format';
import { formatFilterModalityLabel } from '../../lib/bookingLabels';

export interface BookingErrorViewProps {
  slot: BookingSlot;
  filters: BookingFilterState;
  error: BookingConfirmationError;
  retryUntil?: number;
  onRetry: () => void;
  onResetSelection: () => void;
  timezone?: string;
}

const RETRY_CODES = new Set(['rate_limited', 'over_capacity']);

const computeRemainingSeconds = (retryUntil?: number): number | null => {
  if (!retryUntil) return null;
  const deltaMs = retryUntil - Date.now();
  if (deltaMs <= 0) return 0;
  return Math.ceil(deltaMs / 1_000);
};

const formatSuggestion = (intl: ReturnType<typeof useIntl>, date: Date, timeZone: string) =>
  intl.formatMessage(
    { id: 'booking.error.conflict.suggestion' },
    {
      date: formatDate(date, { locale: intl.locale, timeZone, dateStyle: 'long' }),
      time: formatTime(date, { locale: intl.locale, timeZone, timeStyle: 'short' }),
    },
  );

const BookingErrorView = ({
  slot,
  filters,
  error,
  retryUntil,
  onRetry,
  onResetSelection,
  timezone,
}: BookingErrorViewProps) => {
  const intl = useIntl();
  const locale = intl.locale;
  const resolvedTimeZone = useMemo(
    () => timezone ?? resolveLocalePreferences(locale).timeZone,
    [timezone, locale],
  );
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(() => computeRemainingSeconds(retryUntil));

  useEffect(() => {
    headingRef.current?.focus();
  }, [error]);

  useEffect(() => {
    if (!retryUntil) {
      setRemainingSeconds(null);
      return;
    }
    setRemainingSeconds(computeRemainingSeconds(retryUntil));
    const interval = setInterval(() => {
      const next = computeRemainingSeconds(retryUntil);
      setRemainingSeconds(next);
      if (next !== null && next <= 0) {
        clearInterval(interval);
      }
    }, 1_000);
    return () => clearInterval(interval);
  }, [retryUntil]);

  const isConflict = error.code === 'conflict';
  const isRetryable = RETRY_CODES.has(error.code ?? '');
  const effectiveTitleId = 'booking-error-title';
  const conflictSuggestions = useMemo(() => {
    if (!isConflict) return [];
    const start = new Date(slot.start);
    const offsets = [-30, 30, 60];
    return offsets
      .map((minutes) => {
        const candidate = new Date(start.getTime() + minutes * 60_000);
        if (minutes < 0 && candidate.getTime() < Date.now()) {
          return null;
        }
        return formatSuggestion(intl, candidate, resolvedTimeZone);
      })
      .filter((value): value is string => Boolean(value));
  }, [intl, isConflict, slot.start, resolvedTimeZone]);

  const filterSummaries = useMemo(() => {
    const items: string[] = [];
    items.push(
      intl.formatMessage(
        { id: 'booking.error.filters.modality' },
        {
          modality: formatFilterModalityLabel(intl, filters.modality)
        }
      )
    );

    if (filters.from) {
      items.push(
        intl.formatMessage(
          { id: 'booking.error.filters.from' },
          {
            date: formatDate(filters.from, { locale, timeZone: resolvedTimeZone, dateStyle: 'medium' }),
          }
        )
      );
    }

    if (filters.to) {
      items.push(
        intl.formatMessage(
          { id: 'booking.error.filters.to' },
          {
            date: formatDate(filters.to, { locale, timeZone: resolvedTimeZone, dateStyle: 'medium' }),
          }
        )
      );
    }

    return items;
  }, [filters, intl, locale, resolvedTimeZone]);

  const primaryActionLabel = isConflict
    ? intl.formatMessage({ id: 'booking.error.action.search' })
    : intl.formatMessage({ id: 'booking.error.action.retry' });
  const secondaryActionLabel = intl.formatMessage({ id: 'booking.error.action.back' });
  const canRetryNow = remainingSeconds === null || remainingSeconds <= 0;

  const title = isConflict
    ? intl.formatMessage({ id: 'booking.error.conflict.title' })
    : isRetryable
    ? intl.formatMessage({ id: 'booking.error.rateLimited.title' })
    : intl.formatMessage({ id: 'booking.error.generic.title' });

  const body = isConflict
    ? intl.formatMessage({ id: 'booking.error.conflict.body' })
    : isRetryable
    ? intl.formatMessage({ id: 'booking.error.rateLimited.body' })
    : intl.formatMessage({ id: 'booking.error.generic.body' });

  const serverMessage = error.message && error.message.trim().length > 0 ? error.message : null;

  return (
    <section aria-labelledby={effectiveTitleId} role="alert">
      <header>
        <h2 id={effectiveTitleId} ref={headingRef} tabIndex={-1}>
          {title}
        </h2>
        <p>{body}</p>
        {serverMessage && !isConflict ? <p>{serverMessage}</p> : null}
      </header>

      <div className="booking-error-detail">
        <h3>{intl.formatMessage({ id: 'booking.error.filters.title' })}</h3>
        <ul>
          {filterSummaries.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </div>

      {isConflict && conflictSuggestions.length > 0 ? (
        <div className="booking-error-suggestions">
          <h3>{intl.formatMessage({ id: 'booking.error.conflict.suggestions' })}</h3>
          <ul>
            {conflictSuggestions.map((suggestion) => (
              <li key={suggestion}>{suggestion}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {isRetryable ? (
        <div className="booking-error-retry" aria-live="polite">
          {remainingSeconds !== null && remainingSeconds > 0 ? (
            <p>{intl.formatMessage({ id: 'booking.error.retryCountdown' }, { seconds: remainingSeconds })}</p>
          ) : (
            <p>{intl.formatMessage({ id: 'booking.error.retryReady' })}</p>
          )}
          <p>{intl.formatMessage({ id: 'booking.error.rateLimited.contact' })}</p>
        </div>
      ) : null}

      {error.correlationId ? (
        <p className="booking-error-correlation">
          {intl.formatMessage({ id: 'booking.error.correlation' })}{' '}
          <code>{error.correlationId}</code>
        </p>
      ) : null}

      <div className="booking-error-actions">
        <button
          type="button"
          onClick={isConflict ? onResetSelection : onRetry}
          disabled={!isConflict && isRetryable && !canRetryNow}
        >
          {primaryActionLabel}
        </button>
        <button type="button" onClick={onResetSelection}>
          {secondaryActionLabel}
        </button>
      </div>
    </section>
  );
};

export default BookingErrorView;
