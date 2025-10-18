import { describe, expect, it, vi } from 'vitest';
import { performance } from 'node:perf_hooks';
vi.mock('ajv/dist/2020', () => ({
  default: class MockAjv2020 {
    compile() {
      return () => true;
    }
  },
}));

vi.mock('ajv-formats', () => ({
  default: () => undefined,
}));

import { NatsBus } from '../src/natsBus';

function createMockJetStream() {
  return {
    publish: async () => ({ seq: 1 }),
  };
}

function createBus() {
  const bus = new NatsBus({});
  // Stub connection
  (bus as any).getJetStream = async () => createMockJetStream();
  return bus;
}

describe('NatsBus microbench', () => {
  it('records publish latency at baseline', async () => {
    const bus = createBus();
    const envelope = {
      id: 'env-perf',
      topic: 'demo.topic',
      timestamp: new Date().toISOString(),
      payload: { ok: true },
    };

    const start = performance.now();
    for (let i = 0; i < 100; i += 1) {
      await bus.publish('demo.topic', { ...envelope, id: `env-${i}` });
    }
    const duration = performance.now() - start;
    const p50 = duration / 100;
    expect(p50).toBeLessThan(2); // <2ms baseline per publish in mock env
  });
});
