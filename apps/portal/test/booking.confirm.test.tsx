/// <reference types="vitest/globals" />

import { renderToStaticMarkup } from 'react-dom/server';
import { ConfirmBookingContent } from '../src/components/booking/ConfirmBooking';
import { createBookingIdempotencyKey } from '../src/lib/booking';
import type { BookingSlot } from '../src/lib/booking';
import { I18nProvider } from '../src/i18n';

const demoSlot: BookingSlot = {
  id: 'slot-123',
  start: '2025-01-01T09:00:00.000Z',
  end: '2025-01-01T09:30:00.000Z',
  modality: 'phone',
  location: 'OneCare Health'
};

describe('Booking confirmation', () => {
  it('derives deterministic idempotency keys from slot, patient and time', () => {
    const timestamp = 1_735_680_000_000;
    const first = createBookingIdempotencyKey(demoSlot.id, 'patient-a', timestamp);
    const second = createBookingIdempotencyKey(demoSlot.id, 'patient-a', timestamp);
    const third = createBookingIdempotencyKey(demoSlot.id, 'patient-a', timestamp + 1);

    expect(first).toMatch(/^bk_[a-z0-9]+$/);
    expect(first).toBe(second);
    expect(third).not.toBe(first);
  });

  it('disables confirm action while submitting', () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <ConfirmBookingContent
          slot={demoSlot}
          patientId="patient-a"
          idempotencyKey="bk_test"
          timezone="UTC"
          isSubmitting
          statusMessageId="status"
          onBack={() => undefined}
          onConfirm={() => undefined}
          titleId="booking-confirm-title"
          descriptionId="booking-confirm-description"
        />
      </I18nProvider>
    );

    expect(html).toContain('disabled');
    expect(html).toContain('Confirming appointment');
  });
});
