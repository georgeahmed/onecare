import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import SearchSlots from '../components/booking/SearchSlots';
import BookingCalendar from '../components/booking/Calendar';
import ConfirmBooking from '../components/booking/ConfirmBooking';
import BookingErrorView from '../components/booking/BookingErrorView';
import { fetchBookingSlots, type ConfirmBookingResult } from '../lib/api';
import type { BookingFilterState, BookingSlot } from '../lib/booking';
import { createBookingIdempotencyKey, filtersEqual } from '../lib/booking';
import type { BookingConfirmationError } from '../components/booking/ConfirmBooking';
import { getEnhancedAccessConfig } from '../lib/enhancedAccess';
import { getFairnessConfig } from '../lib/fairness';
import { createCorrelationId, recordRumEvent, safeLog, startTimer } from '../lib/telemetry';
import { BookingFlowProvider, useBookingFlow } from '../hooks/useBookingFlow';
import { useLocale } from '../i18n';

interface BookingErrorState {
  slot: BookingSlot;
  filters: BookingFilterState;
  error: BookingConfirmationError;
  retryUntil?: number;
}

const BookingScreen = () => {
  const intl = useIntl();
  const { direction } = useLocale();
  const {
    getCachedSlots,
    putSlots,
    lastConfirmResult,
    setLastConfirmResult,
    clear: clearFlow,
  } = useBookingFlow();

  const [slots, setSlots] = useState<BookingSlot[]>([]);
  const [filters, setFilters] = useState<BookingFilterState>({ modality: 'all' });
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [selectedSlot, setSelectedSlot] = useState<BookingSlot | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null);
  const [selectionTimestamp, setSelectionTimestamp] = useState<number | null>(null);
  const [confirmationResult, setConfirmationResult] = useState<ConfirmBookingResult | null>(lastConfirmResult ?? null);
  const [confirmationError, setConfirmationError] = useState<BookingErrorState | null>(null);
  const patientId = 'demo-patient-001';
  const successStatusId = useId();
  const mainRef = useRef<HTMLElement | null>(null);
  const searchCorrelationRef = useRef<string | null>(null);

  useEffect(() => {
    mainRef.current?.focus();
  }, []);

  const enhancedAccessConfig = useMemo(() => getEnhancedAccessConfig(), []);
  const fairnessConfig = useMemo(() => getFairnessConfig(), []);

  const fairnessNote = useMemo(() => {
    const percentage = Math.round(fairnessConfig.telephoneMinFraction * 100);
    return intl.formatMessage({ id: 'booking.fairness.note' }, { percentage });
  }, [fairnessConfig, intl]);

  const handleFilterChange = useCallback((next: BookingFilterState) => {
    setFilters((previous) => {
      if (filtersEqual(previous, next)) {
        return previous;
      }
      return next;
    });
  }, []);

  useEffect(() => {
    abortRef.current?.abort();

    const controller = new AbortController();
    abortRef.current = controller;
    setIsLoading(true);
    setError(null);

    const correlationId = createCorrelationId();
    searchCorrelationRef.current = correlationId;
    const stopTimer = startTimer();
    recordRumEvent('booking.search.start', {
      correlationId,
      modality: filters.modality,
    });
    safeLog('booking.search.start', { correlationId, filters });

    const cached = getCachedSlots(filters);
    if (cached) {
      setSlots(cached);
      setIsLoading(false);
      recordRumEvent('booking.search.cache.hit', {
        correlationId,
        slotCount: cached.length,
      });
      safeLog('booking.search.cache.hit', { correlationId, slotCount: cached.length });
      return () => {
        controller.abort();
      };
    }

    const queryFilters = {
      modality: filters.modality === 'all' ? undefined : filters.modality,
      from: filters.from,
      to: filters.to,
    };

    fetchBookingSlots(queryFilters, { signal: controller.signal, correlationId })
      .then((results) => {
        setSlots(results);
        putSlots(filters, results);
        const durationMs = stopTimer();
        recordRumEvent('booking.search.success', {
          correlationId,
          durationMs,
          slotCount: results.length,
        });
        safeLog('booking.search.success', { correlationId, slotCount: results.length, durationMs });
      })
      .catch((reason) => {
        if (controller.signal.aborted) return;
        if (reason instanceof Error && reason.name === 'AbortError') return;
        const message = reason instanceof Error ? reason.message : undefined;
        const durationMs = stopTimer();
        const fallback = intl.formatMessage({ id: 'booking.slots.error' });
        const friendly = message && message.trim().length > 0 ? message : fallback;
        recordRumEvent('booking.search.error', {
          correlationId,
          durationMs,
        });
        safeLog('booking.search.error', { correlationId, durationMs, message: friendly });
        setError(friendly);
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setIsLoading(false);
        }
        if (abortRef.current === controller) {
          abortRef.current = null;
        }
      });

    return () => {
      controller.abort();
    };
  }, [filters, getCachedSlots, intl, putSlots]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const clearSelection = () => {
    setSelectedSlot(null);
    setIdempotencyKey(null);
    setSelectionTimestamp(null);
    setConfirmationError(null);
  };

  const resetFlow = () => {
    clearSelection();
    setConfirmationResult(null);
    setLastConfirmResult(null);
  };

  const handleSelectSlot = (slot: BookingSlot) => {
    const timestamp = Date.now();
    setSelectedSlot(slot);
    setSelectionTimestamp(timestamp);
    setIdempotencyKey(createBookingIdempotencyKey(slot.id, patientId, timestamp));
    setConfirmationResult(null);
    setConfirmationError(null);
  };

  const handleConfirmationSuccess = (result: ConfirmBookingResult) => {
    setConfirmationResult(result);
    setLastConfirmResult(result);
    setConfirmationError(null);
  };

  const handleConfirmationError = (errorDetails: BookingConfirmationError) => {
    if (!selectedSlot) return;
    const retryUntil =
      errorDetails.retryAfterSeconds && errorDetails.retryAfterSeconds > 0
        ? Date.now() + errorDetails.retryAfterSeconds * 1_000
        : undefined;
    setConfirmationError({
      slot: selectedSlot,
      filters,
      error: errorDetails,
      retryUntil,
    });
  };

  if (confirmationResult) {
    return (
      <main id="main-content" ref={mainRef} tabIndex={-1} dir={direction}>
        <section role="status" aria-labelledby={successStatusId}>
          <h1 id={successStatusId}>{intl.formatMessage({ id: 'booking.confirm.success.title' })}</h1>
          <p>
            {intl.formatMessage(
              { id: 'booking.confirm.success.body' },
              { appointmentId: confirmationResult.appointmentId },
            )}
          </p>
          {confirmationResult.correlationId ? (
            <p>
              {intl.formatMessage({ id: 'booking.confirm.success.correlation' })}{' '}
              <code>{confirmationResult.correlationId}</code>
            </p>
          ) : null}
          <button type="button" onClick={resetFlow}>
            {intl.formatMessage({ id: 'booking.confirm.success.cta' })}
          </button>
        </section>
      </main>
    );
  }

  if (confirmationError && selectedSlot) {
    return (
      <main id="main-content" ref={mainRef} tabIndex={-1} dir={direction}>
        <BookingErrorView
          slot={confirmationError.slot}
          filters={confirmationError.filters}
          error={confirmationError.error}
          retryUntil={confirmationError.retryUntil}
          onRetry={() => setConfirmationError(null)}
          onResetSelection={clearSelection}
        />
      </main>
    );
  }

  if (selectedSlot && idempotencyKey) {
    return (
      <main id="main-content" ref={mainRef} tabIndex={-1} dir={direction}>
        <ConfirmBooking
          slot={selectedSlot}
          patientId={patientId}
          idempotencyKey={idempotencyKey}
          onBack={clearSelection}
          onSuccess={handleConfirmationSuccess}
          onError={handleConfirmationError}
        />
        {selectionTimestamp ? (
          <p className="booking-selection-timestamp">
            {intl.formatMessage(
              { id: 'booking.confirm.selectionTimestamp' },
              { timestamp: intl.formatDate(new Date(selectionTimestamp), { dateStyle: 'medium', timeStyle: 'short' }) },
            )}
          </p>
        ) : null}
      </main>
    );
  }

  return (
    <main id="main-content" ref={mainRef} tabIndex={-1} dir={direction}>
      <header>
        <h1>{intl.formatMessage({ id: 'booking.section.title' })}</h1>
      </header>
      <BookingCalendar
        slots={slots}
        timezone={enhancedAccessConfig.timezone}
        windows={enhancedAccessConfig.windows}
        onSelectSlot={handleSelectSlot}
        selectedSlotId={selectedSlot?.id ?? null}
      />
      <SearchSlots
        slots={slots}
        isLoading={isLoading}
        error={error}
        onFilterChange={handleFilterChange}
        selectedSlotId={selectedSlot?.id ?? null}
        onSelect={handleSelectSlot}
        fairnessNote={fairnessNote}
      />
    </main>
  );
};

const BookingPage = () => (
  <BookingFlowProvider>
    <BookingScreen />
  </BookingFlowProvider>
);

export default BookingPage;
