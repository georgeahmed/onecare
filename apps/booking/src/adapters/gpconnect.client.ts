import { setTimeout as delay } from 'node:timers/promises';

export interface GpConnectClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
}

export interface SearchSlotsParams {
  organisationId: string;
  serviceType?: string;
  startDate?: string;
  endDate?: string;
}

export interface SlotSummary {
  slotId: string;
  start: string;
  end: string;
  organisationId: string;
}

export interface AppointmentRequest {
  slotId: string;
  patientId: string;
  reason: string;
  performerId?: string;
}

export interface AppointmentConfirmation {
  appointmentId: string;
  slotId: string;
  start: string;
  end: string;
}

export class GpConnectClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(options: GpConnectClientOptions) {
    this.baseUrl = options.baseUrl;
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 5_000;
  }

  static fromEnv(): GpConnectClient {
    const baseUrl = process.env.GP_CONNECT_URL?.trim();
    const apiKey = process.env.GP_CONNECT_API_KEY?.trim();
    if (!baseUrl) throw new Error('gp_connect_url_missing');
    if (!apiKey) throw new Error('gp_connect_api_key_missing');
    const timeoutMs = Number(process.env.GP_CONNECT_TIMEOUT_MS ?? '5000');
    return new GpConnectClient({
      baseUrl,
      apiKey,
      timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 5_000,
    });
  }

  async searchSlots(params: SearchSlotsParams): Promise<SlotSummary[]> {
    await delay(5);
    return [
      {
        slotId: 'demo-slot-1',
        start: new Date().toISOString(),
        end: new Date(Date.now() + 15 * 60 * 1_000).toISOString(),
        organisationId: params.organisationId,
      },
    ];
  }

  async createAppointment(request: AppointmentRequest): Promise<AppointmentConfirmation> {
    await delay(5);
    return {
      appointmentId: `appt-${request.slotId}`,
      slotId: request.slotId,
      start: new Date().toISOString(),
      end: new Date(Date.now() + 15 * 60 * 1_000).toISOString(),
    };
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  getTimeoutMs(): number {
    return this.timeoutMs;
  }

  getApiKey(): string {
    return this.apiKey;
  }
}
