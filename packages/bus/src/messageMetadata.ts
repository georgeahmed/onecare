export const PARTITION_HEADER = 'x-partition-key';
const CORRELATION_HEADER = 'x-correlation-id';
const TENANT_HEADER = 'x-tenant-id';
const PRACTICE_HEADER = 'x-practice-id';

export function normalizeIdCandidate(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function normalizeCorrelationId(value: unknown): string | undefined {
  return normalizeIdCandidate(value);
}

export function findHeaderInsensitive(
  headers: Record<string, string>,
  name: string,
): { key: string; value: string } | undefined {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) {
      return { key, value };
    }
  }
  return undefined;
}

export function extractCorrelationIdFrom(
  payload: unknown,
  headers: Record<string, string> | undefined,
): string | undefined {
  if (payload && typeof payload === 'object') {
    const candidate = (payload as { correlationId?: unknown }).correlationId;
    const fromPayload = normalizeCorrelationId(candidate);
    if (fromPayload) {
      return fromPayload;
    }
  }
  if (!headers) {
    return undefined;
  }
  const located = findHeaderInsensitive(headers, CORRELATION_HEADER);
  if (located) {
    const normalized = normalizeCorrelationId(located.value);
    if (normalized) {
      return normalized;
    }
  }
  return undefined;
}

export function extractTenantId(
  payload: unknown,
  headers: Record<string, string> | undefined,
): string | undefined {
  if (headers) {
    const tenantHeader = findHeaderInsensitive(headers, TENANT_HEADER);
    if (tenantHeader) {
      const normalized = normalizeIdCandidate(tenantHeader.value);
      if (normalized) return normalized;
    }
    const practiceHeader = findHeaderInsensitive(headers, PRACTICE_HEADER);
    if (practiceHeader) {
      const normalized = normalizeIdCandidate(practiceHeader.value);
      if (normalized) return normalized;
    }
  }
  if (payload && typeof payload === 'object') {
    const candidate = normalizeIdCandidate((payload as { tenantId?: unknown }).tenantId);
    if (candidate) return candidate;
    if ('payload' in payload) {
      const inner = (payload as { payload?: unknown }).payload;
      if (inner && typeof inner === 'object') {
        const preferred = ['tenantId', 'practiceId', 'accountId', 'organisationId'];
        for (const key of preferred) {
          const innerCandidate = normalizeIdCandidate((inner as Record<string, unknown>)[key]);
          if (innerCandidate) return innerCandidate;
        }
      }
    }
  }
  return undefined;
}

export function extractPartitionKey(
  payload: unknown,
  headers: Record<string, string> | undefined,
  topic: string,
): string | undefined {
  if (headers) {
    const explicit = findHeaderInsensitive(headers, PARTITION_HEADER);
    if (explicit) {
      const normalized = normalizeIdCandidate(explicit.value);
      if (normalized) return normalized;
    }
    const tenant = findHeaderInsensitive(headers, TENANT_HEADER);
    if (tenant) {
      const normalized = normalizeIdCandidate(tenant.value);
      if (normalized) return normalized;
    }
    const practice = findHeaderInsensitive(headers, PRACTICE_HEADER);
    if (practice) {
      const normalized = normalizeIdCandidate(practice.value);
      if (normalized) return normalized;
    }
  }
  if (payload && typeof payload === 'object') {
    const direct = normalizeIdCandidate((payload as { partitionKey?: unknown }).partitionKey);
    if (direct) return direct;
    const envelopeCorrelation = normalizeIdCandidate((payload as { correlationId?: unknown }).correlationId);
    if (envelopeCorrelation) return envelopeCorrelation;
    const envelopeId = normalizeIdCandidate((payload as { id?: unknown }).id);
    if (envelopeId) return envelopeId;
    if ('payload' in payload) {
      const inner = (payload as { payload?: unknown }).payload;
      if (inner && typeof inner === 'object') {
        const preferredKeys = ['partitionKey', 'tenantId', 'practiceId', 'patientId', 'entityId', 'id', 'key'];
        for (const key of preferredKeys) {
          const candidate = normalizeIdCandidate((inner as Record<string, unknown>)[key]);
          if (candidate) return candidate;
        }
      }
    }
  }
  const headerCorrelation = headers ? findHeaderInsensitive(headers, CORRELATION_HEADER) : undefined;
  if (headerCorrelation) {
    const normalized = normalizeIdCandidate(headerCorrelation.value);
    if (normalized) return normalized;
  }
  return normalizeIdCandidate(topic);
}
