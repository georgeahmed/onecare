import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GpConnectClient } from '../src/adapters/gpconnect.client';

const envBackup = { ...process.env };

describe('GpConnectClient', () => {
  beforeEach(() => {
    process.env.GP_CONNECT_URL = 'https://gp-connect.example';
    process.env.GP_CONNECT_API_KEY = 'demo-key';
    process.env.GP_CONNECT_TIMEOUT_MS = '4000';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...envBackup };
  });

  it('creates client from environment variables', () => {
    const client = GpConnectClient.fromEnv();
    expect(client.getBaseUrl()).toBe('https://gp-connect.example');
    expect(client.getTimeoutMs()).toBe(4_000);
    expect(client.getApiKey()).toBe('demo-key');
  });

  it('searchSlots returns stubbed slot summary', async () => {
    const client = GpConnectClient.fromEnv();
    const slots = await client.searchSlots({ organisationId: 'org-1' });
    expect(slots).toHaveLength(1);
    expect(slots[0].organisationId).toBe('org-1');
  });

  it('createAppointment returns confirmation stub', async () => {
    const client = GpConnectClient.fromEnv();
    const confirmation = await client.createAppointment({
      slotId: 'slot-1',
      patientId: 'patient-1',
      reason: 'Check-up',
    });
    expect(confirmation.appointmentId).toBe('appt-slot-1');
    expect(confirmation.slotId).toBe('slot-1');
  });
});
