import { describe, it, expect } from 'vitest';
import {
  validateBookingSearchRequest,
  validateBookingSearchResponse,
  validateAppointmentCreatedEvent,
} from '../../src/application/contracts';

describe('booking contracts', () => {
  it('accepts valid booking search request', () => {
    const result = validateBookingSearchRequest({
      serviceType: 'GP',
      windowStart: '2025-10-13T10:00:00Z',
      windowEnd: '2025-10-13T12:00:00Z',
      location: 'org-123',
    });
    expect(result.ok).toBe(true);
  });

  it('rejects search request without location', () => {
    const result = validateBookingSearchRequest({
      serviceType: 'GP',
      windowStart: '2025-10-13T10:00:00Z',
      windowEnd: '2025-10-13T12:00:00Z',
    } as unknown);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const paths = result.errors.map((error) => error.path);
      expect(paths).toContain('/location');
    }
  });

  it('accepts booking search response with rejected slots', () => {
    const result = validateBookingSearchResponse({
      slots: [
        {
          id: 'slot-1',
          start: '2025-10-13T10:00:00Z',
          end: '2025-10-13T10:15:00Z',
          organisationId: 'org-123',
          serviceType: 'GP',
        },
      ],
      rejectedSlots: [
        {
          slot: {
            id: 'slot-2',
            start: '2025-10-13T11:00:00Z',
            end: '2025-10-13T11:15:00Z',
            organisationId: 'org-999',
          },
          reasons: ['outside_window'],
        },
      ],
    });
    expect(result.ok).toBe(true);
  });

  it('accepts appointment.created payload', () => {
    const result = validateAppointmentCreatedEvent({
      appointmentId: 'appt-123',
      patientId: 'patient-456',
      start: '2025-10-13T10:00:00Z',
      end: '2025-10-13T10:15:00Z',
      location: 'org-123',
    });
    expect(result.ok).toBe(true);
  });
});
