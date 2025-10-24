import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { logger, redact } from '../../packages/observability/src/logger';
import { safePatientReference } from '../../apps/orchestrator/src/support/privacy';

describe('Privacy and redaction safeguards', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('scrubs PHI/PII from structured logs', () => {
    logger.info('triage submission received', {
      component: 'triage',
      email: 'alice@example.com',
      patientId: 'patient-123',
      token: 'secret-token-456',
      correlationId: 'corr-redaction',
      notes: 'Call back at 07700 900123',
    });

    expect(consoleSpy).toHaveBeenCalled();
    const raw = consoleSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(raw);

    expect(parsed.email).toBe('[REDACTED]');
    expect(parsed.patientId).toBe('[REDACTED]');
    expect(parsed.token).toBe('[REDACTED]');
    expect(parsed.notes).toBe('[REDACTED]');
    expect(parsed.correlationId).toBe('corr-redaction');
    expect(raw).not.toMatch(/alice@example.com/i);
    expect(raw).not.toMatch(/secret-token-456/);
    expect(raw).not.toMatch(/07700\s?900123/);
  });

  it('redacts nested secrets and identifiers in payloads', () => {
    const payload = {
      patient: {
        nhsNumber: '123-45-6789',
        phone: '+44 7700 900456',
        name: 'Test Person',
        notes: 'Contact me at patient@example.com',
      },
      headers: {
        Authorization: 'Bearer secretvalue',
        'x-correlation-id': 'corr-safe',
      },
    };

    const cleaned = redact(payload);
    expect(cleaned.patient).toBeDefined();
    const patient = cleaned.patient as Record<string, unknown>;
    expect(patient.nhsNumber).toBe('[REDACTED]');
    expect(patient.phone).toBe('[REDACTED]');
    expect(patient.notes).toBe('Contact me at [REDACTED]');
    expect((cleaned.headers as Record<string, unknown>).Authorization).toBe('[REDACTED]');
    expect((cleaned.headers as Record<string, unknown>)['x-correlation-id']).toBe('corr-safe');
  });

  it('hashes patient identifiers before reuse', () => {
    const hashed = safePatientReference('patient-456');
    expect(hashed).toBeTruthy();
    expect(hashed).not.toBe('patient-456');
    const repeat = safePatientReference('patient-456');
    expect(repeat).toBe(hashed);
    expect(safePatientReference(null)).toBeNull();
  });
});
