/// <reference types="vitest/globals" />

import { renderToStaticMarkup } from 'react-dom/server';
import BookingErrorView from '../src/components/booking/BookingErrorView';
import type { BookingSlot, BookingFilterState } from '../src/lib/booking';
import type { BookingConfirmationError } from '../src/components/booking/ConfirmBooking';
import { I18nProvider } from '../src/i18n';

const demoSlot: BookingSlot = {
  id: 'slot-conflict',
  start: '2025-01-01T09:00:00.000Z',
  end: '2025-01-01T09:30:00.000Z',
  modality: 'in_person',
  location: 'Demo Practice'
};

const baseFilters: BookingFilterState = { modality: 'phone' };

describe('BookingErrorView', () => {
  it('renders conflict guidance with suggestions and actions', () => {
    const error: BookingConfirmationError = {
      code: 'conflict',
      message: 'Slot already taken'
    };

    const html = renderToStaticMarkup(
      <I18nProvider>
        <BookingErrorView
          slot={demoSlot}
          filters={baseFilters}
          error={error}
          onRetry={() => undefined}
          onResetSelection={() => undefined}
        />
      </I18nProvider>
    );

    expect(html).toContain('That slot was just booked');
    expect(html).toContain('Nearby times you could try');
    expect(html).toContain('Find another time');
    expect(html).toContain('Back to all slots');
  });

  it('shows retry countdown for rate limited errors', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
    const error: BookingConfirmationError = {
      code: 'rate_limited',
      message: 'Too many requests',
      retryAfterSeconds: 5
    };

    const html = renderToStaticMarkup(
      <I18nProvider>
        <BookingErrorView
          slot={demoSlot}
          filters={baseFilters}
          error={error}
          retryUntil={Date.now() + 5_000}
          onRetry={() => undefined}
          onResetSelection={() => undefined}
        />
      </I18nProvider>
    );

    expect(html).toContain('Try again in 5 seconds');
    vi.useRealTimers();
  });
});

