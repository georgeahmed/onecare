const defaultPracticeId = process.env.PRACTICE_ID?.trim();
if (!defaultPracticeId) {
  process.env.PRACTICE_ID = 'demo';
}

if (!process.env.PY_SAFETY_GATE_URL) {
  process.env.PY_SAFETY_GATE_URL = 'https://example.com/safety-gate';
}

if (!process.env.NATS_URL) {
  process.env.NATS_URL = 'nats://127.0.0.1:4222';
}

if (!process.env.BUS_IMPL) {
  process.env.BUS_IMPL = 'memory';
}

const originalFetch = globalThis.fetch;

function resolveFhirBase(): string | null {
  const raw = process.env.FHIR_BASE_URL?.trim();
  if (raw && raw.length > 0) return raw;
  if (process.env.NODE_ENV === 'test') {
    return 'http://localhost:9500/fhir';
  }
  return null;
}

const fhirBase = resolveFhirBase();
const fhirOrigin = (() => {
  if (!fhirBase) return null;
  try {
    const parsed = new URL(fhirBase);
    return parsed.origin;
  } catch {
    return null;
  }
})();

if (originalFetch && fhirOrigin) {
  globalThis.fetch = async (
    input: Parameters<typeof originalFetch>[0],
    init?: Parameters<typeof originalFetch>[1]
  ) => {
    const isRequestCtor = typeof Request !== 'undefined';
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : isRequestCtor && input instanceof Request
            ? input.url
            : undefined;
    if (url && url.startsWith(fhirOrigin)) {
      const body = JSON.stringify({
        resourceType: 'Bundle',
        type: 'transaction',
        entry: [],
      });
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/fhir+json' },
      });
    }
    return originalFetch(input, init);
  };
}
