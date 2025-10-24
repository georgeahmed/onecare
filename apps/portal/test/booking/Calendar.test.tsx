/// <reference types="vitest/globals" />

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Calendar from '../../src/components/booking/Calendar';
import type { BookingSlot } from '../../src/lib/booking';
import { I18nProvider } from '../../src/i18n';
import { Fragment } from 'react';

const enhancedWindows = [
  {
    name: 'weekdays_evening',
    days: [1, 2, 3, 4, 5],
    startMinutes: 18 * 60,
    endMinutes: 20 * 60,
  },
  {
    name: 'saturday',
    days: [6],
    startMinutes: 9 * 60,
    endMinutes: 12 * 60,
  },
];

const sampleSlots: BookingSlot[] = [
  {
    id: 'slot-001',
    start: '2025-10-13T18:30:00Z',
    end: '2025-10-13T19:00:00Z',
    modality: 'phone',
    location: 'Clinic A',
  },
  {
    id: 'slot-002',
    start: '2025-10-14T19:00:00Z',
    end: '2025-10-14T19:30:00Z',
    modality: 'in_person',
    location: 'Clinic B',
  },
];

describe('BookingCalendar', () => {
  it('renders enhanced access legend and windows', () => {
    const markup = renderToStaticMarkup(
      createElement(
        I18nProvider,
        null,
        createElement(Calendar, {
          slots: [],
          timezone: 'Europe/London',
          windows: enhancedWindows,
        }),
      ),
    );

    expect(markup).toContain('Enhanced access calendar');
    expect(markup).toContain('Enhanced access window');
  });

  it('highlights windows and slots with accessible markers', () => {
    const markup = renderToStaticMarkup(
      createElement(
        I18nProvider,
        null,
        createElement(Calendar, {
          slots: sampleSlots,
          timezone: 'Europe/London',
          windows: enhancedWindows,
          selectedSlotId: 'slot-001',
        }),
      ),
    );

    expect(markup).toContain('booking-calendar__cell--window');
    expect(markup).toContain('booking-calendar__cell--has-slot');
    expect(markup).toContain('booking-calendar__cell--selected');
    expect(markup).toContain('booking-calendar__cell-slot-indicator');
  });

  it('aligns the displayed week with the earliest slot date when input is unsorted', () => {
    const unsortedSlots: BookingSlot[] = [
      {
        id: 'slot-late',
        start: '2025-10-20T18:30:00Z',
        end: '2025-10-20T19:00:00Z',
        modality: 'phone',
        location: 'Clinic Later',
      },
      {
        id: 'slot-early',
        start: '2025-10-13T18:30:00Z',
        end: '2025-10-13T19:00:00Z',
        modality: 'in_person',
        location: 'Clinic Earlier',
      },
    ];

    const markup = renderToStaticMarkup(
      createElement(
        I18nProvider,
        null,
        createElement(Calendar, {
          slots: unsortedSlots,
          timezone: 'Europe/London',
          windows: enhancedWindows,
        }),
      ),
    );

    const findIndex = (variants: string[]) => {
      for (const variant of variants) {
        const index = markup.indexOf(variant);
        if (index >= 0) return index;
      }
      return -1;
    };

    const earlyIndex = findIndex(['Oct 13', '13 Oct']);
    const lateIndex = findIndex(['Oct 20', '20 Oct']);

    expect(earlyIndex).toBeGreaterThanOrEqual(0);
    expect(lateIndex).toBe(-1);
  });

  it('generates unique labelling IDs per instance', () => {
    const markup = renderToStaticMarkup(
      createElement(
        I18nProvider,
        null,
        createElement(
          Fragment,
          null,
          createElement(Calendar, {
            slots: sampleSlots,
            timezone: 'Europe/London',
            windows: enhancedWindows,
          }),
          createElement(Calendar, {
            slots: sampleSlots,
            timezone: 'Europe/London',
            windows: enhancedWindows,
          }),
        ),
      ),
    );

    const labelledIds = Array.from(markup.matchAll(/aria-labelledby="([^"]+)"/g)).map((match) => match[1]);
    expect(labelledIds.length).toBeGreaterThanOrEqual(2);
    expect(new Set(labelledIds).size).toBe(labelledIds.length);

    const describedIds = Array.from(markup.matchAll(/aria-describedby="([^"]+)"/g)).map((match) => match[1]);
    expect(describedIds.length).toBeGreaterThanOrEqual(2);
    expect(new Set(describedIds).size).toBe(describedIds.length);
  });
});
