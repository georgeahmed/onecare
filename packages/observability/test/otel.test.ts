import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@opentelemetry/sdk-node', () => {
  const startSpy = vi.fn<[], Promise<void>>();
  class FakeNodeSDK {
    public start = startSpy;
  }
  return {
    NodeSDK: vi.fn(() => new FakeNodeSDK()),
    __mock: { startSpy },
  };
});

describe('initTracing', () => {
  const originalEnv = process.env.OTEL_ENABLED;

  beforeEach(() => {
    vi.resetModules();
    process.env.OTEL_ENABLED = 'true';
    const key = Symbol.for('onecare.observability.initTracing');
    delete (globalThis as Record<string | symbol, unknown>)[key];
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.OTEL_ENABLED;
    } else {
      process.env.OTEL_ENABLED = originalEnv;
    }
  });

  it('awaits NodeSDK.start before resolving', async () => {
    const sdkModule = await import('@opentelemetry/sdk-node');
    const startSpy = sdkModule.__mock.startSpy as ReturnType<typeof vi.fn>;
    startSpy.mockReset();
    let resolveStart!: () => void;
    startSpy.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveStart = resolve;
        }),
    );

    const { initTracing } = await import('../src/otel');

    let resolved = false;
    const initPromise = initTracing('svc').then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(resolved).toBe(false);

    resolveStart();
    await initPromise;
    expect(resolved).toBe(true);
  });

  it('is idempotent when called multiple times', async () => {
    const sdkModule = await import('@opentelemetry/sdk-node');
    const startSpy = sdkModule.__mock.startSpy as ReturnType<typeof vi.fn>;
    startSpy.mockReset();
    startSpy.mockResolvedValue(undefined);

    const { initTracing } = await import('../src/otel');

    const p1 = initTracing('svc');
    const p2 = initTracing('svc');
    await Promise.all([p1, p2]);
    expect(startSpy).toHaveBeenCalledTimes(1);
  });
});
