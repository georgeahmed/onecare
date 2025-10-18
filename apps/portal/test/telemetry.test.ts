/// <reference types="vitest/globals" />

import { afterEach, expect, it, vi } from 'vitest';
import { createCorrelationId, recordRumEvent, safeLog, startTimer } from '../src/lib/telemetry';

const ensureGlobals = () => {
  if (typeof window === 'undefined') {
    (globalThis as unknown as { window: Window }).window = {
      dispatchEvent: () => true,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    } as unknown as Window;
  }
  if (typeof CustomEvent === 'undefined') {
    class Polyfill extends Event {
      detail: unknown;
      constructor(type: string, params?: { detail?: unknown }) {
        super(type);
        this.detail = params?.detail;
      }
    }
    (globalThis as unknown as { CustomEvent: typeof Event }).CustomEvent = Polyfill as unknown as typeof CustomEvent;
  }
};

ensureGlobals();

afterEach(() => {
  vi.restoreAllMocks();
});

it('generates correlation ids', () => {
  const id = createCorrelationId();
  expect(typeof id).toBe('string');
  expect(id.length).toBeGreaterThan(8);
});

it('records rum events via custom event', () => {
  const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
  recordRumEvent('booking.test', { durationMs: 12 });
  expect(dispatchSpy).toHaveBeenCalled();
  const event = dispatchSpy.mock.calls[0][0] as CustomEvent;
  expect(event.detail).toMatchObject({ event: 'booking.test', durationMs: 12 });
});

it('tracks elapsed time', () => {
  const stop = startTimer();
  const duration = stop();
  expect(duration).toBeGreaterThanOrEqual(0);
});

it('logs sanitized data outside production', () => {
  const consoleSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
  safeLog('test', { patientName: 'Alice', token: 'secret', keep: 'value' });
  expect(consoleSpy).toHaveBeenCalled();
  expect(consoleSpy.mock.calls[0][1]).toMatchObject({ patientName: '[redacted]', token: '[redacted]', keep: 'value' });
});
