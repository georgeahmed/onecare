import type { ConfirmBookingResult } from './api';

const formatDateForCalendar = (iso: string): string => {
  const date = new Date(iso);
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(
    date.getUTCDate()
  ).padStart(2, '0')}T${String(date.getUTCHours()).padStart(2, '0')}${String(
    date.getUTCMinutes()
  ).padStart(2, '0')}${String(date.getUTCSeconds()).padStart(2, '0')}Z`;
};

const MAX_ICS_LINE_LENGTH = 75;

const escapeIcsText = (value: string): string =>
  value
    .replace(/\\/g, '\\\\')
    .replace(/\r?\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');

const foldIcsLine = (line: string): string => {
  if (line.length <= MAX_ICS_LINE_LENGTH) {
    return line;
  }
  const segments: string[] = [];
  let remaining = line;
  while (remaining.length > MAX_ICS_LINE_LENGTH) {
    segments.push(remaining.slice(0, MAX_ICS_LINE_LENGTH));
    remaining = remaining.slice(MAX_ICS_LINE_LENGTH);
  }
  segments.push(remaining);
  return segments.join('\r\n ');
};

const foldIcsLines = (lines: string[]): string[] => lines.map((line) => foldIcsLine(line));

interface CalendarEventOptions {
  title: string;
  description?: string;
  location?: string;
}

export const buildGoogleCalendarUrl = (
  result: ConfirmBookingResult,
  options: CalendarEventOptions
): string => {
  const start = formatDateForCalendar(result.start);
  const end = formatDateForCalendar(result.end);
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: options.title,
    dates: `${start}/${end}`
  });
  if (options.description) {
    params.set('details', options.description);
  }
  if (options.location) {
    params.set('location', options.location);
  }
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
};

export const buildIcsDataUri = (
  result: ConfirmBookingResult,
  options: CalendarEventOptions
): string => {
  const dtStamp = formatDateForCalendar(new Date().toISOString());
  const start = formatDateForCalendar(result.start);
  const end = formatDateForCalendar(result.end);
  const uid = `${result.appointmentId}@vecells`;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Vecells//Portal//EN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${dtStamp}`,
    `DTSTART:${start}`,
    `DTEND:${end}`,
    `SUMMARY:${escapeIcsText(options.title)}`
  ];
  if (options.description) {
    lines.push(`DESCRIPTION:${escapeIcsText(options.description)}`);
  }
  if (options.location) {
    lines.push(`LOCATION:${escapeIcsText(options.location)}`);
  }
  lines.push('END:VEVENT', 'END:VCALENDAR');
  const payload = `${foldIcsLines(lines).join('\r\n')}\r\n`;
  return `data:text/calendar;charset=utf-8,${encodeURIComponent(payload)}`;
};
