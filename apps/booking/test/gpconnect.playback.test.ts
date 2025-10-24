import { beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { MemoryBus } from '@onecare/bus';
import type { Subscription } from '@onecare/bus';
import type { TypedEnvelope, AppointmentCreated } from '@onecare/events';
import { Topics } from '@onecare/events';
import { StateMachine } from '@onecare/statekit';
import {
  BookedState,
  ConfirmedState,
  SearchState,
  SelectedState,
  WrittenBackState,
  type BookingContext,
  type BookingEvent,
} from '../src/application/booking.state';
import { InMemoryQueueNotifier } from '@onecare/ports';
import type { IdempotencyStore } from '@onecare/ports';
import { setCorrelationId, resetMetrics } from '@onecare/observability';
import {
  GpConnectHttpClient,
  type AppointmentRequest,
  type AppointmentRef,
  type SearchSlotsParams,
  type Slot,
} from '../src/adapters/gpconnect.client';

interface PlaybackResponse<TBody = unknown> {
  status: number;
  headers: Record<string, string>;
  body: TBody;
}

interface PlaybackCall {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

interface PlaybackOptions {
  fixturesDir: string;
  search: Record<string, string[]>;
  create: Record<string, string[]>;
}

interface PlaybackRouteOverrides {
  search?: Record<string, string[]>;
  create?: Record<string, string[]>;
}

class GpConnectPlaybackTransport {
  private readonly fixturesDir: string;
  private readonly searchRoutes: Map<string, string[]>;
  private readonly createRoutes: Map<string, string[]>;
  readonly calls: PlaybackCall[] = [];

  constructor(options: PlaybackOptions) {
    this.fixturesDir = options.fixturesDir;
    this.searchRoutes = new Map<string, string[]>(
      Object.entries(options.search).map(([key, value]) => [key, [...value]]),
    );
    this.createRoutes = new Map<string, string[]>(
      Object.entries(options.create).map(([key, value]) => [key, [...value]]),
    );
  }

  async searchSlots(context: {
    url: URL;
    method: 'GET';
    headers: Record<string, string>;
    body?: SearchSlotsParams;
    signal: AbortSignal;
  }): Promise<PlaybackResponse<Slot[]>> {
    this.calls.push({
      method: 'GET',
      url: context.url.toString(),
      headers: { ...context.headers },
      body: context.body,
    });
    const key = this.buildSearchKey(context.url);
    const response = this.dequeue(this.searchRoutes, key);
    if (!response) {
      throw new Error(`No playback search fixture for key: ${key}`);
    }
    return response as PlaybackResponse<Slot[]>;
  }

  async createAppointment(context: {
    url: URL;
    method: 'POST';
    headers: Record<string, string>;
    body?: AppointmentRequest;
    signal: AbortSignal;
  }): Promise<PlaybackResponse<AppointmentRef>> {
    this.calls.push({
      method: 'POST',
      url: context.url.toString(),
      headers: { ...context.headers },
      body: context.body,
    });
    const key = this.buildCreateKey(context.body);
    const response = this.dequeue(this.createRoutes, key);
    if (!response) {
      throw new Error(`No playback create fixture for key: ${key}`);
    }
    if (response.status >= 400) {
      const error = new Error(`gpconnect_playback_${response.status}`);
      (error as { status?: number }).status = response.status;
      (error as { response?: unknown }).response = response.body;
      (error as { headers?: Record<string, string> }).headers = response.headers;
      throw error;
    }
    return response as PlaybackResponse<AppointmentRef>;
  }

  private dequeue(source: Map<string, string[]>, key: string): PlaybackResponse | null {
    const entries = source.get(key);
    if (!entries || entries.length === 0) {
      return null;
    }
    const next = entries.shift()!;
    source.set(key, entries);
    const path = join(this.fixturesDir, next);
    const raw = readFileSync(path, 'utf8');
    return JSON.parse(raw) as PlaybackResponse;
  }

  private buildSearchKey(url: URL): string {
    const actor = url.searchParams.get('schedule.actor') ?? 'unknown';
    const serviceType = url.searchParams.get('service-type') ?? 'any';
    return `GET /Slot actor=${actor.toLowerCase()} service=${serviceType.toLowerCase()}`;
  }

  private buildCreateKey(body?: AppointmentRequest): string {
    const slotId = body?.slotId ?? 'unknown-slot';
    return `POST /Appointment slot=${slotId}`;
  }
}

const FIXTURES_DIR = join(process.cwd(), 'fixtures/gpconnect');

function createPlaybackTransport(overrides: PlaybackRouteOverrides = {}): GpConnectPlaybackTransport {
  const searchRoutes: Record<string, string[]> = {
    'GET /Slot actor=org-200 service=gp': ['search-org-200-page1.json', 'search-org-200-page2.json'],
    ...(overrides.search ?? {}),
  };
  const createRoutes: Record<string, string[]> = {
    'POST /Appointment slot=slot-200-1': ['create-slot-200-1.json'],
    'POST /Appointment slot=slot-409': ['create-slot-409-conflict.json', 'create-slot-409-success.json'],
    ...(overrides.create ?? {}),
  };
  return new GpConnectPlaybackTransport({
    fixturesDir: FIXTURES_DIR,
    search: searchRoutes,
    create: createRoutes,
  });
}

function createClient(playback: GpConnectPlaybackTransport): GpConnectHttpClient {
  let traceCounter = 0;
  return new GpConnectHttpClient({
    baseUrl: 'https://gpconnect.playback.test',
    apiKey: 'playback-key',
    timeoutMs: 500,
    traceIdFactory: () => `trace-${++traceCounter}`,
    httpClient: playback as unknown as {
      searchSlots: GpConnectPlaybackTransport['searchSlots'];
      createAppointment: GpConnectPlaybackTransport['createAppointment'];
    },
  });
}

function createIdempotencyStore(): IdempotencyStore {
  const keys = new Map<string, number>();
  return {
    exists: async (key: string) => keys.has(key),
    put: async (key: string, ttlSeconds: number) => {
      keys.set(key, ttlSeconds);
    },
    reserve: async (key: string, ttlSeconds: number) => {
      if (keys.has(key)) return 'exists';
      keys.set(key, ttlSeconds);
      return 'reserved';
    },
    delete: async (key: string) => {
      keys.delete(key);
    },
  };
}

function buildMachine(ctx: BookingContext): StateMachine<BookingContext, BookingEvent> {
  const search = new SearchState();
  const selected = new SelectedState();
  const booked = new BookedState();
  const written = new WrittenBackState();
  const confirmed = new ConfirmedState();

  const machine = new StateMachine<BookingContext, BookingEvent>(search, ctx);
  machine.register(search);
  machine.register(selected);
  machine.register(booked);
  machine.register(written);
  machine.register(confirmed);
  return machine;
}

describe('GpConnect playback harness', () => {
  beforeEach(() => {
    resetMetrics();
    setCorrelationId(undefined);
  });

  it('returns deterministic slot mapping from fixtures', async () => {
    const playback = createPlaybackTransport();
    const client = createClient(playback);
    setCorrelationId('corr-search');
    const slots = await client.searchSlots({
      organisationId: 'org-200',
      serviceType: 'GP',
      startDate: '2025-10-20T08:00:00Z',
      endDate: '2025-10-20T12:00:00Z',
    });

    expect(slots).toHaveLength(2);
    expect(slots[0]).toMatchObject({
      slotId: 'slot-200-1',
      start: '2025-10-20T09:00:00Z',
      end: '2025-10-20T09:15:00Z',
      organisationId: 'org-200',
      serviceType: 'GP',
    });
    expect(slots[1]?.slotId).toBe('slot-409');
    expect(playback.calls.filter((call) => call.method === 'GET')).toHaveLength(1);
  });

  it('executes booking flow end-to-end and enforces idempotency', async () => {
    const playback = createPlaybackTransport();
    const client = createClient(playback);
    const bus = new MemoryBus();
    const delivered: TypedEnvelope<AppointmentCreated>[] = [];
    const subscription = await bus.subscribe<TypedEnvelope<AppointmentCreated>>(
      Topics.booking.appointmentCreated,
      async (message) => {
        delivered.push(message.payload);
      },
    );
    const queueNotifier = new InMemoryQueueNotifier();
    const auditEvents: Array<{ type: string; payload: Record<string, unknown> }> = [];

    const ctx: BookingContext = {
      id: 'booking-playback',
      client,
      bus,
      queueNotifier,
      auditPublisher: {
        emit: async (event) => {
          auditEvents.push(event);
        },
      },
      searchParams: {
        location: 'org-200',
        serviceType: 'GP',
        windowStart: '2025-10-20T08:00:00Z',
        windowEnd: '2025-10-20T12:00:00Z',
      },
      patientId: 'patient-123',
      narrative: 'Routine check',
      correlationId: 'corr-playback',
      idempotencyStore: createIdempotencyStore(),
      queueName: 'booking.notifications',
    };

    try {
      const machine = buildMachine(ctx);
      await machine.start();

      await machine.dispatch({ type: 'booking.search' });
      expect(ctx.slots).toHaveLength(2);

      await machine.dispatch({ type: 'booking.select', payload: { slotId: 'slot-200-1' } });
      expect(ctx.selectedSlot?.id).toBe('slot-200-1');

      await machine.dispatch({ type: 'booking.book' });

      expect(machine.state).toBe('WrittenBack');
      expect(ctx.lastBookingStatus).toBe('executed');
      expect(queueNotifier.deliveries).toHaveLength(1);
      expect(auditEvents).toHaveLength(1);
      expect(delivered).toHaveLength(1);
      expect(delivered[0]?.topic).toBe(Topics.booking.appointmentCreated);
      expect(delivered[0]?.payload.appointmentId).toBe('appt-200-1');
      expect(delivered[0]?.payload.location).toBe('org-200');

      const booked = new BookedState();
      await booked.handle(ctx, { type: 'booking.book' });
      expect(ctx.lastBookingStatus).toBe('duplicate');
      const createCalls = playback.calls.filter(
        (call) => call.method === 'POST' && (call.body as AppointmentRequest | undefined)?.slotId === 'slot-200-1',
      );
      expect(createCalls).toHaveLength(1);
    } finally {
      await subscription.unsubscribe();
    }
  });

  it('surfaces conflict after retries and refreshes slots', async () => {
    const playback = createPlaybackTransport({
      create: {
        'POST /Appointment slot=slot-409': ['create-slot-409-conflict.json', 'create-slot-409-conflict.json'],
      },
    });
    const client = createClient(playback);
    const bus = new MemoryBus();
    const delivered: TypedEnvelope<AppointmentCreated>[] = [];
    const subscription: Subscription = await bus.subscribe<TypedEnvelope<AppointmentCreated>>(
      Topics.booking.appointmentCreated,
      async (message) => {
        delivered.push(message.payload);
      },
    );
    const ctx: BookingContext = {
      id: 'booking-conflict',
      client,
      bus,
      queueNotifier: new InMemoryQueueNotifier(),
      auditPublisher: {
        emit: async () => undefined,
      },
      searchParams: {
        location: 'org-200',
        serviceType: 'GP',
        windowStart: '2025-10-20T08:00:00Z',
        windowEnd: '2025-10-20T12:00:00Z',
      },
      patientId: 'patient-456',
      narrative: 'Follow-up',
      correlationId: 'corr-conflict',
      idempotencyStore: createIdempotencyStore(),
    };

    try {
      const machine = buildMachine(ctx);
      await machine.start();

      await machine.dispatch({ type: 'booking.search' });
      expect(ctx.slots?.map((slot) => slot.id)).toContain('slot-409');

      await machine.dispatch({ type: 'booking.select', payload: { slotId: 'slot-409' } });
      await expect(machine.dispatch({ type: 'booking.book' })).rejects.toMatchObject({
        code: 'booking.create.conflict',
      });

      expect(ctx.lastBookingStatus).toBeUndefined();
      expect(delivered).toHaveLength(0);

      const searchCalls = playback.calls.filter((call) => call.method === 'GET');
      const createCalls = playback.calls.filter(
        (call) => call.method === 'POST' && (call.body as AppointmentRequest | undefined)?.slotId === 'slot-409',
      );
      expect(searchCalls).toHaveLength(2);
      expect(createCalls).toHaveLength(2);
      expect(ctx.slots?.map((slot) => slot.id)).not.toContain('slot-409');
    } finally {
      await subscription.unsubscribe();
    }
  });
});
