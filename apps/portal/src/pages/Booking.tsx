import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import SearchSlots from '../components/booking/SearchSlots';
import ConfirmBooking from '../components/booking/ConfirmBooking';
import BookingErrorView from '../components/booking/BookingErrorView';
import { fetchBookingSlots, type ConfirmBookingResult } from '../lib/api';
import type { BookingFilterState, BookingSlot } from '../lib/booking';
import { createBookingIdempotencyKey, filtersEqual } from '../lib/booking';
import type { BookingConfirmationError } from '../components/booking/ConfirmBooking';

interface BookingErrorState {
  slot: BookingSlot;
  filters: BookingFilterState;
  error: BookingConfirmationError;
  retryUntil?: number;
}

const BookingPage = () => {
  const intl = useIntl();
  const [slots, setSlots] = useState<BookingSlot[]>([]);
  const [filters, setFilters] = useState<BookingFilterState>({ modality: 'all' });
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [selectedSlot, setSelectedSlot] = useState<BookingSlot | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null);
  const [selectionTimestamp, setSelectionTimestamp] = useState<number | null>(null);
  const [confirmationResult, setConfirmationResult] = useState<ConfirmBookingResult | null>(null);
  const [confirmationError, setConfirmationError] = useState<BookingErrorState | null>(null);
  const patientId = 'demo-patient-001';
  const successStatusId = useId();

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

    const queryFilters = {
      modality: filters.modality === 'all' ? undefined : filters.modality,
      from: filters.from,
      to: filters.to
    };

    fetchBookingSlots(queryFilters, { signal: controller.signal })
      .then((results) => {
        setSlots(results);
      })
      .catch((reason) => {
        if (controller.signal.aborted) return;
        if (reason instanceof Error && reason.name === 'AbortError') return;
        const message = reason instanceof Error ? reason.message : undefined;
        setError(message && message.trim().length > 0 ? message : intl.formatMessage({ id: 'booking.slots.error' }));
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
  }, [filters, intl]);

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
      retryUntil
    });
  };

  if (confirmationResult) {
    return (
      <main>
        <section role="status" aria-labelledby={successStatusId}>
          <h1 id={successStatusId}>{intl.formatMessage({ id: 'booking.confirm.success.title' })}</h1>
          <p>
            {intl.formatMessage({ id: 'booking.confirm.success.body' }, { appointmentId: confirmationResult.appointmentId })}
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
      <main>
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
      <main>
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
              { timestamp: intl.formatDate(new Date(selectionTimestamp), { dateStyle: 'medium', timeStyle: 'short' }) }
            )}
          </p>
        ) : null}
      </main>
    );
  }

  return (
    <main>
      <header>
        <h1>{intl.formatMessage({ id: 'booking.section.title' })}</h1>
      </header>
      <SearchSlots
        slots={slots}
        isLoading={isLoading}
        error={error}
        onFilterChange={handleFilterChange}
        selectedSlotId={selectedSlot?.id ?? null}
        onSelect={handleSelectSlot}
      />
    </main>
  );
};

export default BookingPage;
