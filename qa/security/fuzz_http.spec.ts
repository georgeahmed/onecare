import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { faker } from '@faker-js/faker';
import http from 'node:http';

/**
 * Basic HTTP fuzz harness that sends mutated payloads to local services and
 * asserts that responses are handled safely (status code + JSON envelope without stack traces).
 *
 * Requires dev stack running (docker compose up) so endpoints respond locally.
 * Opt-in via RUN_SECURITY_TESTS=1 to avoid failing on default unit test runs.
 */

const TARGETS: Array<{ name: string; method: 'POST'; url: string; bodyFactory: () => Record<string, unknown> }> = [
  {
    name: 'orchestrator safety-check',
    method: 'POST',
    url: 'http://localhost:3001/safety-check',
    bodyFactory: () => ({
      practiceId: 'demo',
      channel: 'web',
      narrative: faker.lorem.paragraphs(2),
      patient: {
        id: faker.string.uuid(),
        birthDate: faker.date.birthdate({ max: 80, mode: 'age' }).toISOString(),
      },
    }),
  },
];

function postJson(url: string, payload: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const request = http.request(
      url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(chunk as Buffer));
        response.on('end', () => {
          const merged = Buffer.concat(chunks).toString('utf8');
          resolve({ status: response.statusCode ?? 0, body: merged });
        });
      },
    );
    request.on('error', reject);
    request.write(body);
    request.end();
  });
}

function mutatePayload(base: Record<string, unknown>): fc.Arbitrary<Record<string, unknown>> {
  return fc.record(
    Object.fromEntries(
      Object.entries(base).map(([key, value]) => {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          return [
            key,
            fc.oneof(fc.constant(value), mutatePayload(value as Record<string, unknown>)),
          ];
        }
        if (typeof value === 'string') {
          return [key, fc.oneof(fc.string(), fc.constantFrom(value.toUpperCase(), value.repeat(3)))];
        }
        if (typeof value === 'number') {
          return [key, fc.oneof(fc.integer({ min: -1_000_000, max: 1_000_000 }), fc.double())];
        }
        return [key, fc.anything()];
      }),
    ),
    { withDeletedKeys: true },
  );
}

const SHOULD_RUN =
  process.env.RUN_SECURITY_TESTS === '1' || process.env.RUN_SECURITY_TESTS?.toLowerCase() === 'true';

if (!SHOULD_RUN) {
  // eslint-disable-next-line no-console
  console.warn('Skipping HTTP fuzzing harness (set RUN_SECURITY_TESTS=1 to enable).');
}

const describeFuzz = SHOULD_RUN ? describe : describe.skip;

describeFuzz('HTTP fuzzing harness', () => {
  TARGETS.forEach((target) => {
    it.concurrent(
      `${target.name} handles mutated payloads safely`,
      async () => {
        await fc.assert(
          fc.asyncProperty(mutatePayload(target.bodyFactory()), async (mutatedPayload) => {
            const { status, body } = await postJson(target.url, mutatedPayload);
            expect([200, 400, 422, 429, 503]).toContain(status);
            expect(body).not.toMatch(/ReferenceError|SyntaxError|TypeError|Stacktrace/i);
          }),
          { numRuns: 25 },
        );
      },
      60_000,
    );
  });
});
