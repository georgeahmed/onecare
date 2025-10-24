import { createHmac } from 'node:crypto';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';

import { hashIdentifier, setHashIdentifierSecretForTest } from '../src';

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_SECRET = process.env.IDENTIFIER_HASH_SECRET;
const ORIGINAL_LEGACY = process.env.ONECARE_HASH_SECRET;

function computeHash(value: string, secret: Buffer | string): string {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

beforeEach(() => {
  setHashIdentifierSecretForTest(null);
  if (ORIGINAL_SECRET === undefined) {
    delete process.env.IDENTIFIER_HASH_SECRET;
  } else {
    process.env.IDENTIFIER_HASH_SECRET = ORIGINAL_SECRET;
  }
  if (ORIGINAL_LEGACY === undefined) {
    delete process.env.ONECARE_HASH_SECRET;
  } else {
    process.env.ONECARE_HASH_SECRET = ORIGINAL_LEGACY;
  }
  if (ORIGINAL_NODE_ENV === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  }
});

afterEach(() => {
  setHashIdentifierSecretForTest(null);
  if (ORIGINAL_SECRET === undefined) {
    delete process.env.IDENTIFIER_HASH_SECRET;
  } else {
    process.env.IDENTIFIER_HASH_SECRET = ORIGINAL_SECRET;
  }
  if (ORIGINAL_LEGACY === undefined) {
    delete process.env.ONECARE_HASH_SECRET;
  } else {
    process.env.ONECARE_HASH_SECRET = ORIGINAL_LEGACY;
  }
  if (ORIGINAL_NODE_ENV === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  }
});

describe('hashIdentifier', () => {
  it('uses configured secret when provided', () => {
    const secret = 'test-secret';
    process.env.IDENTIFIER_HASH_SECRET = secret;
    setHashIdentifierSecretForTest(null);

    const value = 'patient-123';
    const hashed = hashIdentifier(value);

    expect(hashed).toBe(computeHash(value, secret));
  });

  it('supports base64 encoded secrets', () => {
    const secretBuffer = Buffer.from('binary-secret-value');
    process.env.IDENTIFIER_HASH_SECRET = `base64:${secretBuffer.toString('base64')}`;
    setHashIdentifierSecretForTest(null);

    const value = 'actor-456';
    const hashed = hashIdentifier(value);

    expect(hashed).toBe(computeHash(value, secretBuffer));
  });

  it('falls back to a deterministic dev secret outside production', () => {
    delete process.env.IDENTIFIER_HASH_SECRET;
    delete process.env.ONECARE_HASH_SECRET;
    process.env.NODE_ENV = 'test';
    setHashIdentifierSecretForTest(null);

    const value = 'patient-789';
    const hashed = hashIdentifier(value);

    expect(hashed).toBe(computeHash(value, 'onecare-dev-default-secret'));
  });

  it('throws when secret is missing in production', () => {
    delete process.env.IDENTIFIER_HASH_SECRET;
    delete process.env.ONECARE_HASH_SECRET;
    process.env.NODE_ENV = 'production';
    setHashIdentifierSecretForTest(null);

    expect(() => hashIdentifier('patient-000')).toThrow(/IDENTIFIER_HASH_SECRET/);
  });

  it('treats NODE_ENV case-insensitively when enforcing production secrets', () => {
    delete process.env.IDENTIFIER_HASH_SECRET;
    delete process.env.ONECARE_HASH_SECRET;
    process.env.NODE_ENV = 'Production';
    setHashIdentifierSecretForTest(null);

    expect(() => hashIdentifier('patient-111')).toThrow(/IDENTIFIER_HASH_SECRET/);
  });

  it('rejects malformed base64 secrets', () => {
    process.env.IDENTIFIER_HASH_SECRET = 'base64:not-base64';
    setHashIdentifierSecretForTest(null);

    expect(() => hashIdentifier('patient-222')).toThrow(/base64 encoding invalid/);
  });

  it('rejects malformed hex secrets', () => {
    process.env.IDENTIFIER_HASH_SECRET = 'hex:ABC';
    setHashIdentifierSecretForTest(null);

    expect(() => hashIdentifier('patient-333')).toThrow(/hex encoding invalid/);
  });
});
