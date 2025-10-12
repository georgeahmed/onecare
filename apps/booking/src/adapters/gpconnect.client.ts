import { setTimeout as delay } from 'node:timers/promises';

export interface GpConnectClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  appointmentExecutor?: AppointmentExecutor;
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
  serviceType?: string;
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

export interface SlotView {
  id: string;
  start: string;
  end: string;
  organisationId: string;
  serviceType?: string;
}

export type AppointmentExecutor = (request: AppointmentRequest) => Promise<AppointmentConfirmation>;

export type GpConnectErrorCode = 'conflict' | 'unavailable' | 'unknown';

export class GpConnectClientError extends Error {
  constructor(public readonly code: GpConnectErrorCode, message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'GpConnectClientError';
  }
}

export class GpConnectClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly appointmentExecutor?: AppointmentExecutor;

  constructor(options: GpConnectClientOptions) {
    this.baseUrl = options.baseUrl;
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.appointmentExecutor = options.appointmentExecutor;
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
        serviceType: params.serviceType,
      },
    ];
  }

  async createAppointment(request: AppointmentRequest): Promise<AppointmentConfirmation> {
    const executor = this.appointmentExecutor ?? defaultAppointmentExecutor;
    let attempt = 0;
    let lastError: unknown;

    while (attempt < 2) {
      try {
        return await executor(request);
      } catch (error) {
        lastError = error;
        const conflict = isConflictError(error);
        if (conflict && attempt === 0) {
          const backoffMs = Math.min(200, Math.max(50, this.timeoutMs * 0.05));
          await delay(backoffMs + Math.random() * 25);
          attempt += 1;
          continue;
        }
        throw mapToClientError(error);
      }
    }

    throw mapToClientError(lastError);
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

export function mapSlotsToView(slots: SlotSummary[]): SlotView[] {
  if (!Array.isArray(slots) || slots.length === 0) return [];
  return slots.map((slot) => ({
    id: slot.slotId,
    start: slot.start,
    end: slot.end,
    organisationId: slot.organisationId,
    serviceType: slot.serviceType,
  }));
}

async function defaultAppointmentExecutor(request: AppointmentRequest): Promise<AppointmentConfirmation> {
  await delay(5);
  return {
    appointmentId: `appt-${request.slotId}`,
    slotId: request.slotId,
    start: new Date().toISOString(),
    end: new Date(Date.now() + 15 * 60 * 1_000).toISOString(),
  };
}

function isConflictError(error: unknown): boolean {
  if (!error) return false;
  if (typeof error === 'object') {
    const status = (error as { status?: number }).status;
    if (status === 409) return true;
    const code = (error as { code?: string }).code;
    if (code?.toLowerCase() === 'conflict') return true;
  }
  if (typeof error === 'string') {
    return error.toLowerCase().includes('conflict');
  }
  return false;
}

function mapToClientError(error: unknown): GpConnectClientError {
  if (isConflictError(error)) {
    return new GpConnectClientError('conflict', 'Appointment slot already booked', error);
  }
  if (typeof error === 'object' && error) {
    const status = (error as { status?: number }).status ?? (error as { response?: { status?: number } }).response?.status;
    if (status && status >= 500) {
      return new GpConnectClientError('unavailable', 'GP Connect service unavailable', error);
    }
  }
  return new GpConnectClientError('unknown', 'GP Connect request failed', error);
}
