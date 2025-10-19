import { describe, expect, it, vi } from 'vitest';
import { GpConnectHttpClient, type GpConnectTransportResponse, normalizeFingerprint } from '../src/gp-connect';

describe('GpConnectHttpClient', () => {
  it('rejects absolute URLs to prevent SSRF', async () => {
    const client = new GpConnectHttpClient({
      baseUrl: 'https://gp-connect.example',
    });

    await expect(client.request('https://evil.example/path')).rejects.toMatchObject({
      code: 'gp_connect_path_invalid',
    });
  });

  it('blocks hostnames not present in the allowlist', async () => {
    const logs: Array<{ event: string; reason?: string }> = [];
    const client = new GpConnectHttpClient({
      baseUrl: 'https://gp-connect.example',
      onLog: (entry) => logs.push({ event: entry.event, reason: entry.reason }),
    });

    await expect(client.request('//malicious.example/resource')).rejects.toMatchObject({
      code: 'gp_connect_host_blocked',
    });
    expect(logs.some((entry) => entry.event === 'error')).toBe(true);
  });

  it('redacts sensitive headers in log entries', async () => {
    const logs: Array<Record<string, unknown>> = [];
    const client = new GpConnectHttpClient({
      baseUrl: 'https://gp-connect.example',
      onLog: (entry) => logs.push(entry),
      transport: async (_req) => ({
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: Buffer.from('{}'),
        fingerprint: normalizeFingerprint('AA BB'),
      }),
      pinnedFingerprints: ['AABB'],
    });

    await client.request('/health', {
      method: 'GET',
      headers: {
        Authorization: 'Bearer secret',
        'Ssp-Api-Key': 'top-secret',
        'X-Correlation-Id': 'corr-123',
      },
    });

    const requestLog = logs.find((entry) => entry.event === 'request');
    expect(requestLog).toBeDefined();
    expect(requestLog?.headers).toMatchObject({
      authorization: '[redacted]',
      'ssp-api-key': '[redacted]',
      'x-correlation-id': 'corr-123',
    });

    const responseLog = logs.find((entry) => entry.event === 'response');
    expect(responseLog?.headers).toMatchObject({
      'content-type': 'application/json',
    });
  });

  it('enforces certificate pinning when fingerprint mismatches', async () => {
    const client = new GpConnectHttpClient({
      baseUrl: 'https://gp-connect.example',
      pinnedFingerprints: ['AA:BB'],
      transport: async () => ({
        statusCode: 200,
        headers: {},
        body: Buffer.from('ok'),
        fingerprint: normalizeFingerprint('CC DD'),
      }),
    });

    await expect(client.request('/test')).rejects.toMatchObject({
      code: 'gp_connect_cert_mismatch',
    });
  });

  it('accepts responses when fingerprint matches the pin set', async () => {
    const transport = vi.fn(async () => ({
      statusCode: 204,
      headers: {},
      body: Buffer.alloc(0),
      fingerprint: normalizeFingerprint('AB CD'),
    }) satisfies GpConnectTransportResponse);

    const client = new GpConnectHttpClient({
      baseUrl: 'https://gp-connect.example',
      pinnedFingerprints: ['AB:CD'],
      transport,
    });

    const response = await client.request('/status');
    expect(response.statusCode).toBe(204);
    expect(transport).toHaveBeenCalled();
  });

  it('throws when fingerprint is missing despite pin configuration', async () => {
    const client = new GpConnectHttpClient({
      baseUrl: 'https://gp-connect.example',
      pinnedFingerprints: ['AA:BB'],
      transport: async () => ({
        statusCode: 200,
        headers: {},
        body: Buffer.from('ok'),
      }),
    });

    await expect(client.request('/status')).rejects.toMatchObject({
      code: 'gp_connect_cert_missing',
    });
  });

  it('merges default headers and serialises JSON bodies', async () => {
    const transport = vi.fn(async (req) => ({
      statusCode: 201,
      headers: { location: '/resource/1' },
      body: Buffer.from(''),
      fingerprint: normalizeFingerprint('12 34'),
    }) satisfies GpConnectTransportResponse);

    const client = new GpConnectHttpClient({
      baseUrl: 'https://gp-connect.example/api',
      defaultHeaders: {
        'User-Agent': 'gp-client',
      },
      pinnedFingerprints: ['12:34'],
      transport,
    });

    await client.request('appointments', {
      method: 'POST',
      body: { foo: 'bar' },
      headers: { 'X-Correlation-Id': 'corr-001' },
    });

    expect(transport).toHaveBeenCalled();
    const call = transport.mock.calls[0]?.[0];
    expect(call?.url.pathname).toBe('/api/appointments');
    expect(call?.headers).toMatchObject({
      'user-agent': 'gp-client',
      'content-type': 'application/json',
      'x-correlation-id': 'corr-001',
    });
    expect(call?.body?.toString()).toBe('{"foo":"bar"}');
  });

  it('passes timeout overrides to the transport layer', async () => {
    const transport = vi.fn(async (req) => ({
      statusCode: 200,
      headers: {},
      body: Buffer.from(''),
      fingerprint: normalizeFingerprint('AA BB'),
    }) satisfies GpConnectTransportResponse);

    const client = new GpConnectHttpClient({
      baseUrl: 'https://gp-connect.example',
      pinnedFingerprints: ['AA:BB'],
      transport,
    });

    await client.request('/ping', { timeoutMs: 2500 });
    expect(transport).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 2500 }));
  });
});
