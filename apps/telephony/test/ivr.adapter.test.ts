import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IvrIngestAdapter, InMemoryAudioStore, type CallRecordingReference } from '../src/adapters/ivr.adapter';
import type { ObjectStore, ObjectStorePutOptions, FhirRepository, FhirBundle, FhirResourceRef } from '@onecare/ports';
import { resetMetrics, getCounterRecords, getHistogramRecords } from '@onecare/observability';

class FakeObjectStore implements ObjectStore {
  public readonly puts: Array<{
    key: string;
    data: Uint8Array;
    contentType: string;
    options?: ObjectStorePutOptions;
  }> = [];

  async put(
    key: string,
    data: ArrayBuffer | Uint8Array,
    contentType: string,
    options?: ObjectStorePutOptions,
  ): Promise<{ url: string }> {
    const buffer = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.puts.push({ key, data: buffer, contentType, options });
    return { url: `https://object-store.local/${key}` };
  }

  async get(): Promise<Uint8Array> {
    throw new Error('not implemented');
  }
}

class FakeFhirRepository implements FhirRepository {
  public readonly documents: Record<string, unknown>[] = [];

  async createDocumentReference(document: unknown): Promise<FhirResourceRef> {
    this.documents.push(document as Record<string, unknown>);
    return { id: `doc-${this.documents.length}`, resourceType: 'DocumentReference' };
  }

  async upsertBundle(_bundle: FhirBundle): Promise<FhirBundle> {
    throw new Error('not implemented');
  }

  async createTask(): Promise<FhirResourceRef> {
    throw new Error('not implemented');
  }

  async createAppointment(): Promise<FhirResourceRef> {
    throw new Error('not implemented');
  }
}

describe('IvrIngestAdapter', () => {
  beforeEach(() => {
    resetMetrics();
  });

  it('uploads audio to object store, applies ttl, and creates document reference', async () => {
    const objectStore = new FakeObjectStore();
    const fhir = new FakeFhirRepository();
    const events = {
      callStarted: vi.fn(),
      audioChunkStored: vi.fn(),
      promptQueued: vi.fn(),
      callCompleted: vi.fn<(callId: string, summary: CallRecordingReference) => Promise<void>>(),
    };

    const adapter = new IvrIngestAdapter({
      store: new InMemoryAudioStore(),
      objectStore,
      fhir,
      audioTtlSeconds: 3600,
      events,
      audioContentType: 'audio/wav',
    });

    const session = await adapter.startCall('call-123', {
      callerId: '+15550000000',
      practiceId: 'practice-1',
      correlationId: 'corr-123',
    });

    await session.onAudioChunk(Buffer.from('audio-data'));
    const result = await session.complete();

    expect(objectStore.puts).toHaveLength(1);
    const putCall = objectStore.puts[0];
    expect(putCall.options?.ttlSeconds).toBe(3600);
    expect(putCall.contentType).toBe('audio/wav');

    expect(fhir.documents).toHaveLength(1);
    const document = fhir.documents[0];
    expect(document.resourceType).toBe('DocumentReference');
    const content = (document.content as Array<Record<string, unknown>>) ?? [];
    expect(content[0]?.attachment).toMatchObject({
      url: result.audioUrl,
      contentType: 'audio/wav',
    });

    expect(result.audioUrl).toBe('https://object-store.local/' + putCall.key);
    expect(events.callCompleted).toHaveBeenCalledWith('call-123', result);

    const chunkMetric = getCounterRecords('telephony.audio.chunks');
    expect(chunkMetric).toHaveLength(1);
    expect(chunkMetric[0].attributes).toMatchObject({ practiceId: 'practice-1' });

    const uploadMetric = getHistogramRecords('telephony.audio.upload_ms');
    expect(uploadMetric.length).toBeGreaterThan(0);
  });

  it('falls back to stub storage when object store missing', async () => {
    const adapter = new IvrIngestAdapter({
      store: new InMemoryAudioStore(),
      events: {
        callStarted: async () => undefined,
        audioChunkStored: async () => undefined,
        promptQueued: async () => undefined,
        callCompleted: async () => undefined,
      },
    });

    const session = await adapter.startCall('call-456', { callerId: '+15550000001' });
    await session.onAudioChunk(Buffer.from('payload'));
    const result = await session.complete();

    expect(result.audioUrl).toBe('memory://call-456');
    expect(result.documentReferenceId).toBeUndefined();
  });

  it('enforces the configured audio spool limit', async () => {
    const adapter = new IvrIngestAdapter({
      store: new InMemoryAudioStore(),
      maxSpoolBytes: 1024,
    });

    const session = await adapter.startCall('call-spool', { callerId: '+15550000002' });
    await session.onAudioChunk(Buffer.alloc(1024, 1));

    await expect(session.onAudioChunk(Buffer.alloc(2, 2))).rejects.toMatchObject({
      code: 'invalid_chunk',
    });
  });
});
