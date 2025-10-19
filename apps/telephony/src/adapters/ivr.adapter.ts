import { createHash } from 'node:crypto';
import { loadConfig } from '@onecare/config';
import { createCounter, createHistogram, logger } from '@onecare/observability';
import { createDocumentReferenceResource, type FhirRepository, type ObjectStore } from '@onecare/ports';
import { registerPromptHandler, unregisterPromptHandler } from './ivr.prompts';

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
  prompts: StoredPrompt[];
}

export interface StoredPrompt {
  text: string;
  queuedAt: number;
}

export type Clock = () => number;

export interface AudioStore {
  init(callId: string, metadata: CallMetadata, startedAt: number): Promise<void>;
  append(callId: string, chunk: Buffer, sequence: number, receivedAt: number): Promise<StoredAudioChunk>;
  get(callId: string): StoredCall | undefined;
  recordPrompt(callId: string, prompt: string, queuedAt: number): Promise<StoredPrompt>;
  delete(callId: string): Promise<void>;
}

export interface IngestEventPublisher {
  callStarted(callId: string, metadata: CallMetadata): Promise<void> | void;
  audioChunkStored(callId: string, chunk: StoredAudioChunk): Promise<void> | void;
  promptQueued?(callId: string, prompt: StoredPrompt): Promise<void> | void;
  callCompleted?(callId: string, summary: CallRecordingReference): Promise<void> | void;
}

export interface CallRecordingReference {
  audioKey: string;
  audioUrl: string;
  contentType: string;
  documentReferenceId?: string;
}

export interface IvrCallSession {
  onAudioChunk(buffer: Buffer): Promise<void>;
  queuePrompt(prompt: string): Promise<void>;
  complete(): Promise<CallRecordingReference>;
}

export interface IvrAdapter {
  startCall(callId: string, metadata: CallMetadata): Promise<IvrCallSession>;
}

export interface IvrIngestAdapterOptions {
  store?: AudioStore;
  events?: IngestEventPublisher;
  clock?: Clock;
  objectStore?: ObjectStore;
  fhir?: FhirRepository;
  audioTtlSeconds?: number;
  audioContentType?: string;
  maxSpoolBytes?: number;
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
  promptQueued: async () => undefined,
  callCompleted: async () => undefined,
};

const now: Clock = () => Date.now();

const audioChunkCounter = createCounter('telephony.audio.chunks');
const audioBytesCounter = createCounter('telephony.audio.bytes');
const audioUploadHistogram = createHistogram('telephony.audio.upload_ms');

const DEFAULT_AUDIO_CONTENT_TYPE = 'audio/wav';
const DEFAULT_AUDIO_TTL_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_MAX_AUDIO_SPOOL_BYTES = 50 * 1024 * 1024;

function sanitizeKeySegment(segment: string | undefined, fallback: string): string {
  const base = segment && segment.trim().length > 0 ? segment.trim() : fallback;
  return base
    .toLowerCase()
    .replace(/[^a-z0-9/_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/\/{2,}/g, '/')
    .replace(/^-|-$/g, '');
}

function coercePatientReference(patientId: string | undefined): string | undefined {
  if (!patientId) return undefined;
  const trimmed = patientId.trim();
  if (!trimmed) return undefined;
  if (/^[A-Za-z]+\/.+/.test(trimmed)) return trimmed;
  return `Patient/${trimmed}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }
  return parsed;
}

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
      prompts: [],
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
      prompts: call.prompts.map((prompt) => ({ ...prompt })),
    };
  }

  async recordPrompt(callId: string, prompt: string, queuedAt: number): Promise<StoredPrompt> {
    const call = this.calls.get(callId);
    if (!call) {
      throw new IvrIngestAdapterError('call_not_initialized', `call ${callId} not initialized`);
    }
    const stored: StoredPrompt = {
      text: prompt,
      queuedAt,
    };
    call.prompts.push(stored);
    return stored;
  }

  async delete(callId: string): Promise<void> {
    this.calls.delete(callId);
  }
}

class DefaultCallSession implements IvrCallSession {
  private sequence = 0;
  private completed = false;
  private totalBytes = 0;

  constructor(
    private readonly callId: string,
    private readonly metadata: CallMetadata,
    private readonly store: AudioStore,
    private readonly events: IngestEventPublisher,
    private readonly clock: Clock,
    private readonly finalize: (callId: string) => Promise<CallRecordingReference>,
    private readonly maxSpoolBytes: number,
  ) {}

  async onAudioChunk(buffer: Buffer): Promise<void> {
    if (this.completed) {
      throw new IvrIngestAdapterError('call_not_initialized', `call ${this.callId} already completed`);
    }
    if (!Buffer.isBuffer(buffer)) {
      throw new IvrIngestAdapterError('invalid_chunk', 'audio chunk must be a Buffer');
    }
    if (buffer.length === 0) {
      return;
    }

    const projectedTotal = this.totalBytes + buffer.byteLength;
    if (projectedTotal > this.maxSpoolBytes) {
      logger.error('telephony.audio.spool.limit_exceeded', {
        callId: this.callId,
        practiceId: this.metadata.practiceId ?? 'unknown',
        limitBytes: this.maxSpoolBytes,
        attemptedBytes: projectedTotal,
      });
      this.completed = true;
      await this.store.delete?.(this.callId).catch(() => undefined);
      throw new IvrIngestAdapterError('invalid_chunk', 'audio spool limit exceeded');
    }

    const stored = await this.store.append(this.callId, buffer, this.sequence, this.clock());
    this.totalBytes = projectedTotal;
    this.sequence += 1;
    const practiceId = this.metadata.practiceId ?? 'unknown';
    audioChunkCounter.add(1, { practiceId });
    audioBytesCounter.add(buffer.byteLength, { practiceId });
    await Promise.resolve(this.events.audioChunkStored(this.callId, stored));
  }

  async queuePrompt(prompt: string): Promise<void> {
    if (this.completed) {
      return;
    }
    const sanitized = prompt?.trim();
    if (!sanitized) return;
    const stored = await this.store.recordPrompt(this.callId, sanitized, this.clock());
    await Promise.resolve(this.events.promptQueued?.(this.callId, stored));
  }

  async complete(): Promise<CallRecordingReference> {
    if (this.completed) {
      throw new IvrIngestAdapterError('call_not_initialized', `call ${this.callId} already completed`);
    }
    this.completed = true;
    unregisterPromptHandler(this.callId);
    return this.finalize(this.callId);
  }
}

export class IvrIngestAdapter implements IvrAdapter {
  private readonly store: AudioStore;
  private readonly events: IngestEventPublisher;
  private readonly clock: Clock;
  private readonly objectStore?: ObjectStore;
  private readonly fhir?: FhirRepository;
  private readonly explicitAudioTtlSeconds?: number;
  private readonly audioContentType: string;
  private readonly envAudioTtlSeconds?: number;
  private readonly maxSpoolBytes: number;

  constructor(options?: IvrIngestAdapterOptions) {
    this.store = options?.store ?? new InMemoryAudioStore();
    this.events = options?.events ?? noopPublisher;
    this.clock = options?.clock ?? now;
    this.objectStore = options?.objectStore;
    this.fhir = options?.fhir;
    this.explicitAudioTtlSeconds = options?.audioTtlSeconds;
    this.audioContentType = options?.audioContentType?.trim() || DEFAULT_AUDIO_CONTENT_TYPE;
    this.envAudioTtlSeconds = parsePositiveInt(process.env.TELEPHONY_AUDIO_TTL_SECONDS);
    const envSpoolLimit = parsePositiveInt(process.env.TELEPHONY_AUDIO_SPOOL_LIMIT_BYTES);
    this.maxSpoolBytes = Math.max(
      1,
      options?.maxSpoolBytes ?? (envSpoolLimit && Number.isFinite(envSpoolLimit) ? envSpoolLimit : DEFAULT_MAX_AUDIO_SPOOL_BYTES),
    );
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
    const session = new DefaultCallSession(
      normalizedCallId,
      sanitizedMetadata,
      this.store,
      this.events,
      this.clock,
      (id) => this.finalizeCall(id),
      this.maxSpoolBytes,
    );
    registerPromptHandler(normalizedCallId, (prompt) => session.queuePrompt(prompt));
    return session;
  }

  private async finalizeCall(callId: string): Promise<CallRecordingReference> {
    const call = this.store.get(callId);
    if (!call) {
      throw new IvrIngestAdapterError('call_not_initialized', `call ${callId} not initialized`);
    }

    const practiceId = call.metadata.practiceId ?? 'unknown';
    const totalBytes = call.chunks.reduce((acc, chunk) => acc + chunk.data.byteLength, 0);
    const sortedChunks = [...call.chunks].sort((a, b) => a.sequence - b.sequence);
    const combined = Buffer.concat(sortedChunks.map((chunk) => chunk.data));
    const startedAtIso = new Date(call.startedAt).toISOString().replace(/[:.]/g, '-');
    const key = `telephony/audio/${sanitizeKeySegment(practiceId, 'unknown')}/${sanitizeKeySegment(
      callId,
      'call',
    )}/${startedAtIso}.raw`;

    let audioUrl = `memory://${callId}`;
    const contentType = this.audioContentType;
    const ttlSeconds = this.resolveAudioTtl(call.metadata.practiceId);

    if (this.objectStore) {
      const uploadStart = this.clock();
      const { url } = await this.objectStore.put(key, combined, contentType, {
        ttlSeconds,
      });
      const durationMs = this.clock() - uploadStart;
      audioUrl = url;
      audioUploadHistogram.record(durationMs, { practiceId });
      logger.info('telephony.audio.uploaded', {
        callId,
        practiceId,
        key,
        bytes: totalBytes,
        durationMs,
      });
      if (ttlSeconds) {
        logger.info('telephony.audio.retention.applied', {
          callId,
          practiceId,
          ttlSeconds,
        });
        logger.info('telephony.audio.cleanup.defer', {
          callId,
          practiceId,
          ttlSeconds,
          strategy: 'object_store_ttl',
        });
      } else {
        logger.info('telephony.audio.cleanup.defer', {
          callId,
          practiceId,
          note: 'no TTL configured; rely on offline spooler cleanup',
        });
      }
    } else {
      logger.warn('telephony.audio.object_store_missing', {
        callId,
        practiceId,
      });
    }

    let documentReferenceId: string | undefined;
    if (this.fhir) {
      try {
        const document = this.buildDocumentReference(callId, call, audioUrl, contentType);
        const ref = await createDocumentReferenceResource(this.fhir, document);
        documentReferenceId = ref?.id;
        logger.info('telephony.audio.document_reference.created', {
          callId,
          practiceId,
          documentReferenceId,
        });
      } catch (error) {
        logger.warn('telephony.audio.document_reference.failed', {
          callId,
          practiceId,
          reason: error instanceof Error ? error.message : 'unknown_error',
        });
      }
    }

    await this.store.delete(callId);
    const summary: CallRecordingReference = {
      audioKey: key,
      audioUrl,
      contentType,
      documentReferenceId,
    };
    await Promise.resolve(this.events.callCompleted?.(callId, summary));
    return summary;
  }

  private resolveAudioTtl(practiceId: string | undefined): number | undefined {
    if (typeof this.explicitAudioTtlSeconds === 'number' && this.explicitAudioTtlSeconds > 0) {
      return this.explicitAudioTtlSeconds;
    }
    if (typeof this.envAudioTtlSeconds === 'number' && this.envAudioTtlSeconds > 0) {
      return this.envAudioTtlSeconds;
    }
    const resolvedPractice = practiceId?.trim() || undefined;
    try {
      const config = loadConfig(resolvedPractice ?? 'nhs_gp_defaults');
      const telephonyConfig = isRecord((config as Record<string, unknown>).telephony)
        ? ((config as Record<string, unknown>).telephony as Record<string, unknown>)
        : undefined;
      const audioConfig = telephonyConfig && isRecord(telephonyConfig.audio) ? telephonyConfig.audio : undefined;
      if (audioConfig) {
        const retentionSeconds = typeof audioConfig.retention_seconds === 'number' ? audioConfig.retention_seconds : undefined;
        if (Number.isFinite(retentionSeconds) && retentionSeconds! > 0) {
          return Math.floor(retentionSeconds!);
        }
        const retentionDays =
          typeof audioConfig.retention_days === 'number' ? audioConfig.retention_days : parsePositiveInt(audioConfig.retention_days as string | undefined);
        if (Number.isFinite(retentionDays) && retentionDays! > 0) {
          return Math.floor(retentionDays! * 24 * 60 * 60);
        }
      }
    } catch (error) {
      logger.warn('telephony.audio.retention.config_unavailable', {
        practiceId,
        reason: error instanceof Error ? error.message : 'unknown_error',
      });
    }
    return DEFAULT_AUDIO_TTL_SECONDS;
  }

  private buildDocumentReference(
    callId: string,
    call: StoredCall,
    audioUrl: string,
    contentType: string,
  ): Record<string, unknown> {
    const nowIso = new Date(this.clock()).toISOString();
    const patientId =
      call.metadata.attributes?.patientId ??
      call.metadata.attributes?.patient_id ??
      call.metadata.attributes?.patient ??
      undefined;
    const subjectReference = coercePatientReference(patientId);
    return {
      resourceType: 'DocumentReference',
      status: 'current',
      date: nowIso,
      description: 'Telephony call recording',
      identifier: [
        {
          system: 'https://onecare.example/telephony/call',
          value: callId,
        },
      ],
      ...(subjectReference ? { subject: { reference: subjectReference } } : {}),
      content: [
        {
          attachment: {
            contentType,
            url: audioUrl,
            title: 'Telephony call recording',
          },
        },
      ],
    };
  }
}
