/// <reference types="vitest/globals" />

import { describe, expect, it } from 'vitest';
import { buildGoogleCalendarUrl, buildIcsDataUri } from '../src/lib/calendar';

const mockResult = {
  appointmentId: 'appt-123',
  slotId: 'slot-1',
  start: '2025-10-14T09:00:00Z',
  end: '2025-10-14T09:30:00Z',
  correlationId: 'corr-xyz'
};

describe('calendar helpers', () => {
  it('builds google calendar link with encoded params', () => {
    const url = buildGoogleCalendarUrl(mockResult, {
      title: 'Test event',
      description: 'Reference: appt-123'
    });
    expect(url).toContain('https://calendar.google.com/calendar/render');
    expect(url).toContain('action=TEMPLATE');
    expect(url).toContain('text=Test+event');
    expect(url).toContain('Reference%3A+appt-123');
  });

  it('builds data uri for ics download', () => {
    const uri = buildIcsDataUri(mockResult, {
      title: 'Test event',
      description: 'Reference: appt-123'
    });
    expect(uri.startsWith('data:text/calendar;charset=utf-8,')).toBe(true);
    expect(decodeURIComponent(uri.split(',')[1])).toContain('BEGIN:VEVENT');
    expect(decodeURIComponent(uri.split(',')[1])).toContain('SUMMARY:Test event');
  });
});
