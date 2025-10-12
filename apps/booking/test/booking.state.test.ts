import { describe, it, expect, vi } from 'vitest';
import type { AppointmentRequest, AppointmentConfirmation, SlotSummary } from '../src/adapters/gpconnect.client';
import { GpConnectClient } from '../src/adapters/gpconnect.client';
import {
  BookingContext,
  SearchState,
  SelectedState,
  BookedState,
} from '../src/application/booking.state';

function buildClient(slots: SlotSummary[], executor: (req: AppointmentRequest) => Promise<AppointmentConfirmation>) {
  return new GpConnectClient({
    baseUrl: 'https://gp-connect.example',
    apiKey: 'key',
    appointmentExecutor: executor,
  });
}

describe('Booking state machine integration', () => {
  it('searches, selects, and books with retry-aware client', async () => {
    const slots: SlotSummary[] = [
      {
        slotId: 'slot-123',
        start: '2025-10-12T10:00:00Z',
        end: '2025-10-12T10:10:00Z',
        organisationId: 'org-1',
        serviceType: 'GP',
      },
    ];

    let attempts = 0;
    const executor = vi.fn(async (request: AppointmentRequest) => {
      attempts += 1;
      if (attempts === 1) {
        const error = new Error('conflict');
        (error as { status: number }).status = 409;
        throw error;
      }
      return {
        appointmentId: `appt-${request.slotId}`,
        slotId: request.slotId,
        start: '2025-10-12T10:00:00Z',
        end: '2025-10-12T10:10:00Z',
      };
    });

    const searchClient = new GpConnectClient({
      baseUrl: 'https://gp-connect.example',
      apiKey: 'key',
      appointmentExecutor: executor,
    });
    const searchStub = vi.spyOn(searchClient, 'searchSlots').mockResolvedValue(slots);
    const ctx: BookingContext = {
      id: 'booking-ctx',
      client: searchClient,
      patientId: 'patient-1',
      searchParams: { organisationId: 'org-1', serviceType: 'GP' },
    };

    const search = new SearchState();
    const nextAfterSearch = await search.handle(ctx, { type: 'booking.search' });
    expect(nextAfterSearch).toBe('Selected');
    expect(searchStub).toHaveBeenCalledWith({ organisationId: 'org-1', serviceType: 'GP' });
    expect(ctx.slots?.[0].id).toBe('slot-123');

    const select = new SelectedState();
    const nextAfterSelect = await select.handle(ctx, { type: 'booking.select' });
    expect(nextAfterSelect).toBe('Booked');
    expect(ctx.selectedSlot?.id).toBe('slot-123');

    const book = new BookedState();
    const nextAfterBook = await book.handle(ctx, { type: 'booking.book' });
    expect(nextAfterBook).toBe('WrittenBack');
    expect(ctx.appointmentConfirmation?.appointmentId).toBe('appt-slot-123');
    expect(executor).toHaveBeenCalledTimes(2);
  });
});
