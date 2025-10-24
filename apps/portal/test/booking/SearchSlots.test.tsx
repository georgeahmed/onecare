/// <reference types="vitest/globals" />

import { createElement } from 'react';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import SearchSlots from '../../src/components/booking/SearchSlots';
import type { BookingSlot } from '../../src/lib/booking';
import { I18nProvider } from '../../src/i18n';

const renderWithIntl = (element: ReactNode) =>
  renderToStaticMarkup(createElement(I18nProvider, null, element));

const slots: BookingSlot[] = [
  {
    id: 'slot-1',
    start: '2025-10-14T09:00:00Z',
    end: '2025-10-14T09:30:00Z',
    modality: 'phone',
    location: 'Remote',
  },
  {
    id: 'slot-2',
    start: '2025-10-15T14:00:00Z',
    end: '2025-10-15T14:30:00Z',
    modality: 'in_person',
    location: 'Clinic A',
  },
];

describe('SearchSlots component', () => {
  it('renders accessible slot buttons', () => {
    const html = renderWithIntl(createElement(SearchSlots, { slots }));

    expect(html).toContain('Phone consultation');
    expect(html).toContain('In-person visit');
    expect(html).toContain('Remote');
    expect(html).toContain('Clinic A');
    expect(html).toContain('Available booking slots');
  });

  it('renders skeleton placeholders when loading', () => {
    const html = renderWithIntl(createElement(SearchSlots, { slots: [], isLoading: true }));

    expect(html).toContain('booking-slot skeleton');
  });

  it('renders empty state guidance when no slots match filter', () => {
    const html = renderWithIntl(createElement(SearchSlots, { slots: [], isLoading: false }));

    expect(html).toContain('No appointment slots match your filters yet.');
    expect(html).toContain('Try adjusting your filters or request a callback so we can follow up as soon as possible.');
  });

  it('renders supplied error message', () => {
    const html = renderWithIntl(createElement(SearchSlots, { slots: [], error: 'Network down' }));

    expect(html).toContain('Network down');
  });

  it('marks the selected slot', () => {
    const html = renderWithIntl(
      createElement(SearchSlots, { slots, selectedSlotId: 'slot-2' })
    );

    expect(html).toContain('aria-selected="true"');
  });

  it('shows fairness note when provided', () => {
    const html = renderWithIntl(
      createElement(SearchSlots, {
        slots,
        fairnessNote: 'We reserve at least 15% of appointments for phone consultations.',
      })
    );

    expect(html).toContain('Fair access');
    expect(html).toContain('15% of appointments');
  });

  it('virtualizes rendering for large slot lists', () => {
    const manySlots: BookingSlot[] = Array.from({ length: 60 }, (_, index) => ({
      id: `slot-${index}`,
      start: `2025-10-14T09:${(index % 60).toString().padStart(2, '0')}:00Z`,
      end: `2025-10-14T09:${((index + 1) % 60).toString().padStart(2, '0')}:00Z`,
      modality: index % 2 === 0 ? 'phone' : 'in_person',
      location: `Clinic ${index}`,
    }));

    const html = renderWithIntl(createElement(SearchSlots, { slots: manySlots }));

    expect(html).toContain('booking-slots--virtualized');
    expect(html).toContain('booking-slot-spacer');
  });
});
