import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@opentelemetry/sdk-node', () => {
  const startSpy = vi.fn<[], void | Promise<void>>();
  const shutdownSpy = vi.fn<[], Promise<void>>();
  class FakeNodeSDK {
    public start = startSpy;
    public shutdown = shutdownSpy;
  }
  return {
    NodeSDK: vi.fn(() => new FakeNodeSDK()),
    __mock: { startSpy, shutdownSpy },
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
    (sdkModule.NodeSDK as ReturnType<typeof vi.fn>).mockClear();
    startSpy.mockResolvedValue(undefined);

    const { initTracing } = await import('../src/otel');

    const p1 = initTracing('svc');
    const p2 = initTracing('svc');
    await Promise.all([p1, p2]);
    expect(startSpy).toHaveBeenCalledTimes(1);
  });

  it('retries initialization after failure', async () => {
    const sdkModule = await import('@opentelemetry/sdk-node');
    const startSpy = sdkModule.__mock.startSpy as ReturnType<typeof vi.fn>;
    const NodeSDK = sdkModule.NodeSDK as ReturnType<typeof vi.fn>;
    startSpy.mockReset();
    NodeSDK.mockClear();
    startSpy.mockRejectedValueOnce(new Error('boom'));
    startSpy.mockResolvedValue(undefined);

    const { initTracing } = await import('../src/otel');

    await expect(initTracing('svc')).rejects.toThrow('boom');
    await expect(initTracing('svc')).resolves.toBeUndefined();

    expect(startSpy).toHaveBeenCalledTimes(2);
    expect(NodeSDK).toHaveBeenCalledTimes(2);
  });

  it('shuts down the SDK and allows reinitialisation', async () => {
    const sdkModule = await import('@opentelemetry/sdk-node');
    const startSpy = sdkModule.__mock.startSpy as ReturnType<typeof vi.fn>;
    const shutdownSpy = sdkModule.__mock.shutdownSpy as ReturnType<typeof vi.fn>;
    const NodeSDK = sdkModule.NodeSDK as ReturnType<typeof vi.fn>;
    startSpy.mockReset();
    shutdownSpy.mockReset();
    NodeSDK.mockClear();
    startSpy.mockResolvedValue(undefined);
    shutdownSpy.mockResolvedValue(undefined);

    const { initTracing, shutdownTracing } = await import('../src/otel');

    await initTracing('svc');
    await shutdownTracing();

    expect(shutdownSpy).toHaveBeenCalledTimes(1);

    await initTracing('svc');
    expect(startSpy).toHaveBeenCalledTimes(2);
    expect(NodeSDK).toHaveBeenCalledTimes(2);
  });
});
