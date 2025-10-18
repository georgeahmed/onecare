import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAuditEvent, resetAuditLedger, setAuditLedger } from '../src/adapters/audit';
import type { AuditLedger, AuditEvent } from '@onecare/ports';
import { safePatientReference } from '../src/support/privacy';
import { hashIdentifier } from '../src/support/privacy';

describe('audit events', () => {
  afterEach(() => {
    resetAuditLedger();
  });

  it('redacts sensitive detail fields and preserves metadata', () => {
    const event = createAuditEvent('audit.test', {
      correlationId: 'corr-1',
      actorRef: 'system#abcd',
      subjectRef: safePatientReference('patient-123'),
      outcome: 'allow',
      reasonCode: 'ok',
      details: {
        patientId: 'patient-123',
        token: 'secret-value',
        info: 'ok',
      },
    });

    expect(event.type).toBe('audit.test');
    expect(new Date(event.ts).toString()).not.toBe('Invalid Date');
    expect(event.details?.info).toBe('ok');
    expect(event.details?.patientId).toBe('[REDACTED]');
    expect(event.details?.token).toBe('[REDACTED]');
  });

  it('writes sanitized events to the ledger', async () => {
    const writes: AuditEvent[] = [];
    const stubLedger: AuditLedger = {
      write: vi.fn(async (event) => {
        writes.push(event);
      }),
    };
    setAuditLedger(stubLedger, { buffered: false });

    const actorId = 'user-42';
    const actorRef = `user#${hashIdentifier(actorId)}`;
    const subjectRef = safePatientReference('patient-42');
    const event = createAuditEvent('audit.ledger', {
      correlationId: 'corr-123',
      actorRef,
      subjectRef,
      outcome: 'allow',
      reasonCode: 'accepted',
      details: {
        actorId,
        patientId: 'patient-42',
        description: 'done',
      },
    });

    await stubLedger.write(event);

    expect(actorRef.includes(actorId)).toBe(false);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.actorRef).toBe(actorRef);
    expect(writes[0]?.subjectRef).toBe(subjectRef);
    expect(writes[0]?.details?.actorId).toBe('[REDACTED]');
    expect(writes[0]?.details?.patientId).toBe('[REDACTED]');
  });
});
