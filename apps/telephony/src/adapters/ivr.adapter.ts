import { createHash } from 'node:crypto';

export interface CallMetadata {
  callerId: string;
  correlationId?: string;
  practiceId?: string;
  dialedNumber?: string;
  attributes?: Record<string, string>;
}

export interface StoredAudioChunk {
  sequence: number;
  size: number;
  receivedAt: number;
  checksum: string;
  data: Buffer;
}

export interface StoredCall {
  metadata: CallMetadata;
  startedAt: number;
  chunks: StoredAudioChunk[];
}

export type Clock = () => number;

export interface AudioStore {
  init(callId: string, metadata: CallMetadata, startedAt: number): Promise<void>;
  append(callId: string, chunk: Buffer, sequence: number, receivedAt: number): Promise<StoredAudioChunk>;
  get(callId: string): StoredCall | undefined;
}

export interface IngestEventPublisher {
  callStarted(callId: string, metadata: CallMetadata): Promise<void> | void;
  audioChunkStored(callId: string, chunk: StoredAudioChunk): Promise<void> | void;
}

export interface IvrCallSession {
  onAudioChunk(buffer: Buffer): Promise<void>;
}

export interface IvrAdapter {
  startCall(callId: string, metadata: CallMetadata): Promise<IvrCallSession>;
}

export interface IvrIngestAdapterOptions {
  store?: AudioStore;
  events?: IngestEventPublisher;
  clock?: Clock;
}

export type IvrIngestErrorCode =
  | 'call_id_required'
  | 'caller_id_required'
  | 'call_already_started'
  | 'call_not_initialized'
  | 'invalid_chunk';

export class IvrIngestAdapterError extends Error {
  constructor(public readonly code: IvrIngestErrorCode, message: string) {
    super(message);
    this.name = 'IvrIngestAdapterError';
  }
}

const noopPublisher: IngestEventPublisher = {
  // Future pipeline integrations hook in here; keep side effects isolated.
  callStarted: async () => undefined,
  audioChunkStored: async () => undefined,
};

const now: Clock = () => Date.now();

export class InMemoryAudioStore implements AudioStore {
  private readonly calls = new Map<string, StoredCall>();

  async init(callId: string, metadata: CallMetadata, startedAt: number): Promise<void> {
    if (this.calls.has(callId)) {
      throw new IvrIngestAdapterError('call_already_started', `call ${callId} already initialized`);
    }
    this.calls.set(callId, {
      metadata: { ...metadata },
      startedAt,
      chunks: [],
    });
  }

  async append(callId: string, chunk: Buffer, sequence: number, receivedAt: number): Promise<StoredAudioChunk> {
    const call = this.calls.get(callId);
    if (!call) {
      throw new IvrIngestAdapterError('call_not_initialized', `call ${callId} not initialized`);
    }

    const checksum = createHash('sha256').update(chunk).digest('hex');
    const stored: StoredAudioChunk = {
      sequence,
      size: chunk.byteLength,
      receivedAt,
      checksum,
      data: Buffer.from(chunk),
    };
    call.chunks.push(stored);
    return stored;
  }

  get(callId: string): StoredCall | undefined {
    const call = this.calls.get(callId);
    if (!call) return undefined;
    return {
      metadata: { ...call.metadata },
      startedAt: call.startedAt,
      chunks: call.chunks.map((chunk) => ({
        sequence: chunk.sequence,
        size: chunk.size,
        receivedAt: chunk.receivedAt,
        checksum: chunk.checksum,
        data: Buffer.from(chunk.data),
      })),
    };
  }
}

class DefaultCallSession implements IvrCallSession {
  private sequence = 0;

  constructor(
    private readonly callId: string,
    private readonly store: AudioStore,
    private readonly events: IngestEventPublisher,
    private readonly clock: Clock,
  ) {}

  async onAudioChunk(buffer: Buffer): Promise<void> {
    if (!Buffer.isBuffer(buffer)) {
      throw new IvrIngestAdapterError('invalid_chunk', 'audio chunk must be a Buffer');
    }
    if (buffer.length === 0) {
      return;
    }

    const stored = await this.store.append(this.callId, buffer, this.sequence, this.clock());
    this.sequence += 1;
    await Promise.resolve(this.events.audioChunkStored(this.callId, stored));
  }
}

export class IvrIngestAdapter implements IvrAdapter {
  private readonly store: AudioStore;
  private readonly events: IngestEventPublisher;
  private readonly clock: Clock;

  constructor(options?: IvrIngestAdapterOptions) {
    this.store = options?.store ?? new InMemoryAudioStore();
    this.events = options?.events ?? noopPublisher;
    this.clock = options?.clock ?? now;
  }

  async startCall(callId: string, metadata: CallMetadata): Promise<IvrCallSession> {
    const normalizedCallId = callId?.trim();
    if (!normalizedCallId) {
      throw new IvrIngestAdapterError('call_id_required', 'callId is required');
    }
    const callerId = metadata?.callerId?.trim();
    if (!callerId) {
      throw new IvrIngestAdapterError('caller_id_required', 'callerId is required');
    }
    const sanitizedMetadata: CallMetadata = {
      ...metadata,
      callerId,
    };
    const startedAt = this.clock();
    await this.store.init(normalizedCallId, sanitizedMetadata, startedAt);
    await Promise.resolve(this.events.callStarted(normalizedCallId, sanitizedMetadata));
    return new DefaultCallSession(normalizedCallId, this.store, this.events, this.clock);
  }
}

