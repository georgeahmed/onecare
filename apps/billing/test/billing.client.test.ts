import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BillingHttpClient, BillingClientError } from '../src/adapters/billing.client';
import type { ResolvedConfig, BillingConfig } from '@onecare/config';
import type { BillingClaim } from '@onecare/events';

const claim: BillingClaim = {
  claimId: 'claim-1',
  encounterId: 'enc-1',
  amount: 125.5,
  currency: 'GBP',
};

function buildConfig(): ResolvedConfig {
  const billing: BillingConfig = {
    endpoint: 'https://billing.example/api',
    apiKey: 'secret',
    headers: { 'X-Tenant': 'tenant-1' },
    timeoutMs: 100,
    retry: { attempts: 1, baseDelayMs: 5, maxDelayMs: 10, jitterRatio: 0 },
    circuitBreaker: { failureThreshold: 2, cooldownMs: 1_000 },
    correlationHeader: 'x-corr',
  };
  return { practiceId: 'demo', billing } as unknown as ResolvedConfig;
}

beforeEach(() => {
  vi.useRealTimers();
});

describe('BillingHttpClient', () => {
  it('submits claim with correlation header and TLS config', async () => {
    const dispatcher = vi.fn(async (_claim: BillingClaim, context) => {
      expect(context.headers.Authorization).toBe('Bearer secret');
      expect(context.headers['x-trace']).toBe('trace-123');
      expect(context.headers['x-corr']).toBe('corr-123');
      expect(context.headers.Accept).toBe('application/json');
      expect(context.operation).toBe('claim');
      return {
        claimId: claim.claimId,
        status: 'accepted' as const,
      };
    });
    const client = BillingHttpClient.fromConfig(buildConfig(), {
      headers: { 'x-trace': 'trace-123' },
      submitDispatcher: dispatcher,
    });
    const response = await client.submitClaim(claim, { correlationId: 'corr-123' });
    expect(response.status).toBe('accepted');
    expect(dispatcher).toHaveBeenCalledTimes(1);
  });

  it('gets response via dispatcher', async () => {
    const responseDispatcher = vi.fn(async (id: string, context) => {
      expect(context.headers.Authorization).toBe('Bearer secret');
      expect(context.headers['x-corr']).toBeUndefined();
      expect(context.headers.Accept).toBe('application/json');
      expect(context.operation).toBe('response');
      expect(id).toBe('claim-1');
      return { claimId: id, status: 'pending' as const };
    });
    const client = BillingHttpClient.fromConfig(buildConfig(), { responseDispatcher });
    const response = await client.getResponse('claim-1');
    expect(response.status).toBe('pending');
    expect(responseDispatcher).toHaveBeenCalledTimes(1);
  });

  it('retries on timeout and surfaces timeout error', async () => {
    const dispatcher = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return { claimId: 'claim-1', status: 'accepted' as const };
    });
    const client = BillingHttpClient.fromConfig(buildConfig(), {
      submitDispatcher: dispatcher,
      timeoutMs: 40,
      retry: { attempts: 1, baseDelayMs: 5, maxDelayMs: 10, jitterRatio: 0 },
    });
    await expect(client.submitClaim(claim)).rejects.toMatchObject({ code: 'upstream_timeout' });
    expect(dispatcher).toHaveBeenCalledTimes(2);
  });

  it('maps 5xx errors to upstream_unavailable', async () => {
    const dispatcher = vi.fn(async () => {
      const err = new Error('down') as Error & { status?: number };
      err.status = 503;
      throw err;
    });
    const client = BillingHttpClient.fromConfig(buildConfig(), {
      submitDispatcher: dispatcher,
      retry: { attempts: 0 },
    });
    await expect(client.submitClaim(claim)).rejects.toMatchObject({ code: 'upstream_unavailable' });
    expect(dispatcher).toHaveBeenCalledTimes(1);
  });

  it('opens circuit breaker after repeated failures', async () => {
    const dispatcher = vi.fn(async () => {
      throw new BillingClientError('upstream_unavailable', 'fail');
    });
    const client = BillingHttpClient.fromConfig(buildConfig(), {
      submitDispatcher: dispatcher,
      retry: { attempts: 0 },
      circuitBreaker: { failureThreshold: 2, cooldownMs: 5_000 },
    });
    await expect(client.submitClaim(claim)).rejects.toMatchObject({ code: 'upstream_unavailable' });
    await expect(client.submitClaim(claim)).rejects.toMatchObject({ code: 'upstream_unavailable' });
    await expect(client.submitClaim(claim)).rejects.toMatchObject({ code: 'upstream_unavailable', message: 'Billing circuit breaker open' });
    expect(dispatcher).toHaveBeenCalledTimes(2);
  });
});
