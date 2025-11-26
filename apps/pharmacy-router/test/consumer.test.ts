import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MemoryBus } from '@onecare/bus';
import { createEnvelope, Topics, type PharmacyOutcome, type PharmacyReferral } from '@onecare/events';
import { PharmacyRouterConsumer } from '../src/adapters/consumer';
import type { PharmacyReferralRequest } from '../src';
import type { PharmacyRouterResult } from '../src/application/router';
import { ContractValidationError } from '../src/adapters/contracts';
import { CpcsClientError } from '../src/adapters/cpcs.client';

function createReferralEnvelope(overrides: Partial<PharmacyReferral> = {}) {
  const payload: PharmacyReferral = {
    patientId: 'patient-1',
    condition: 'UTI',
    pharmacyOrg: 'pharmacy/demo',
    patientAgeYears: 32,
    patientSex: 'female',
    severity: 'mild',
    exclusionFlags: ['pregnant'],
    slot: {
      start: '2025-01-08T09:00:00.000Z',
      end: '2025-01-08T09:15:00.000Z',
      locationOdsCode: 'ODS1',
      reference: 'slot-1',
    },
  };
  return createEnvelope(Topics.pharmacy.referral, { ...payload, ...overrides }, 'corr-pharmacy-test');
}

describe('PharmacyRouterConsumer', () => {
  let bus: MemoryBus;
  const correlationHeaders = { 'x-correlation-id': 'corr-pharmacy-test' };

  beforeEach(() => {
    bus = new MemoryBus();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('processes valid referrals and publishes outcome', async () => {
    const outcomes: unknown[] = [];
    await bus.subscribe(Topics.pharmacy.outcome, async (msg) => {
      outcomes.push(msg.payload);
    });

    const processor = vi.fn(async (request: PharmacyReferralRequest): Promise<PharmacyRouterResult> => {
      const outcome: PharmacyOutcome = {
        serviceRequestId: 'sr-1',
        organisationId: request.organisationId,
        status: 'accepted',
        referralReference: 'cpcs-sr-1',
        recordedAt: new Date().toISOString(),
      };
      return {
        state: 'OutcomeRecorded',
        context: {
          outcomePayload: outcome,
          referralPayload: {
            patientId: request.patientId,
            condition: request.document.conditionCode,
            pharmacyOrg: request.organisationId,
          },
        } as unknown as PharmacyRouterResult['context'],
      };
    });

    const consumer = new PharmacyRouterConsumer({ bus, processor });
    await consumer.start();
    await bus.publish(Topics.pharmacy.referral, createReferralEnvelope(), correlationHeaders);
    await consumer.stop();

    expect(processor).toHaveBeenCalledTimes(1);
    expect(outcomes).toHaveLength(1);
    const diagnostics = consumer.getDiagnostics();
    expect(diagnostics.processed).toBe(1);
    expect(diagnostics.dlq).toBe(0);
  });

  it('routes validation failures to the DLQ', async () => {
    const dlq: unknown[] = [];
    await bus.subscribe(Topics.broker.deadLetter, async (msg) => {
      dlq.push(msg.payload);
    });

    const processor = vi.fn();
    const consumer = new PharmacyRouterConsumer({ bus, processor });
    await consumer.start();
    const invalidEnvelope = createEnvelope(Topics.pharmacy.referral, {
      condition: 'UTI',
      pharmacyOrg: 'pharmacy/demo',
    }, 'corr-pharmacy-test');
    await bus.publish(Topics.pharmacy.referral, invalidEnvelope, correlationHeaders);
    await consumer.stop();

    expect(processor).not.toHaveBeenCalled();
    expect(dlq).toHaveLength(1);
    const diagnostics = consumer.getDiagnostics();
    expect(diagnostics.dlq).toBe(1);
  });

  it('publishes to DLQ on non-retryable processor errors', async () => {
    const dlq: unknown[] = [];
    await bus.subscribe(Topics.broker.deadLetter, async (msg) => dlq.push(msg.payload));

    const processor = vi.fn(async () => {
      throw new ContractValidationError('https://onecare/schemas/pharmacy/pharmacy-outcome.json', [], 'invalid_contract');
    });
    const consumer = new PharmacyRouterConsumer({ bus, processor, maxAttempts: 3 });

    await consumer.start();
    await bus.publish(Topics.pharmacy.referral, createReferralEnvelope(), correlationHeaders);
    await consumer.stop();

    expect(processor).toHaveBeenCalledTimes(1);
    expect(dlq).toHaveLength(1);
    const diagnostics = consumer.getDiagnostics();
    expect(diagnostics.dlq).toBe(1);
    expect(diagnostics.retried).toBe(0);
  });

  it('retries transient errors before DLQ', async () => {
    vi.useFakeTimers();
    const dlq: unknown[] = [];
    await bus.subscribe(Topics.broker.deadLetter, async (msg) => dlq.push(msg.payload));

    const processor = vi
      .fn<[], Promise<PharmacyRouterResult>>()
      .mockRejectedValueOnce(new CpcsClientError('upstream_timeout', 'timeout'))
      .mockRejectedValueOnce(new CpcsClientError('upstream_unavailable', 'down'))
      .mockRejectedValue(new CpcsClientError('upstream_timeout', 'timeout'));

    const consumer = new PharmacyRouterConsumer({
      bus,
      processor,
      maxAttempts: 2,
      retryBaseDelayMs: 10,
      retryMaxDelayMs: 20,
    });

    await consumer.start();
    const publishPromise = bus.publish(Topics.pharmacy.referral, createReferralEnvelope(), correlationHeaders);
    await vi.runAllTimersAsync();
    await publishPromise;
    await consumer.stop();

    expect(processor).toHaveBeenCalledTimes(2);
    expect(dlq).toHaveLength(1);
    const diagnostics = consumer.getDiagnostics();
    expect(diagnostics.dlq).toBe(1);
    expect(diagnostics.retried).toBeGreaterThanOrEqual(1);
  });
});
