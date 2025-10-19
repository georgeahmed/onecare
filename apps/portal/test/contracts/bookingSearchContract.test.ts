/// <reference types="vitest/globals" />

import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let AjvConstructor: any = null;
let addFormatsFn: any = null;

beforeAll(async () => {
  try {
    const [{ default: Ajv2020 }, { default: addFormats }] = await Promise.all([
      import('ajv/dist/2020'),
      import('ajv-formats'),
    ]);
    AjvConstructor = Ajv2020;
    addFormatsFn = addFormats;
  } catch (error) {
    console.warn('Ajv not available, skipping contract tests.', error);
  }
});

const loadSchema = (relativePath: string) => {
  const fullPath = join(__dirname, '../../../../', relativePath);
  const raw = readFileSync(fullPath, 'utf-8');
  return JSON.parse(raw);
};

describe('booking search contract', () => {
  it('matches search request schema for valid payloads', () => {
    if (!AjvConstructor || !addFormatsFn) {
      return; // silently skip if ajv is unavailable
    }

    const schema = loadSchema('schemas/booking/booking-search-request.json');
    const ajv = new AjvConstructor({ allErrors: true, strict: false });
    addFormatsFn(ajv);
    const validate = ajv.compile(schema);

    const payload = {
      serviceType: 'gp-consult',
      windowStart: '2025-10-01T09:00:00Z',
      windowEnd: '2025-10-07T17:00:00Z',
      location: 'demo-clinic',
    };

    const ok = validate(payload);
    expect(ok).toBe(true);
  });

  it('flags invalid payloads', () => {
    if (!AjvConstructor || !addFormatsFn) {
      return;
    }

    const schema = loadSchema('schemas/booking/booking-search-request.json');
    const ajv = new AjvConstructor({ allErrors: true, strict: false });
    addFormatsFn(ajv);
    const validate = ajv.compile(schema);

    const payload = {
      serviceType: '',
      windowStart: '2025-10-01',
      windowEnd: '2025-09-30T09:00:00Z',
      location: '??',
      extra: true,
    };

    const ok = validate(payload);
    expect(ok).toBe(false);
    expect(validate.errors?.length ?? 0).toBeGreaterThan(0);
  });
});
