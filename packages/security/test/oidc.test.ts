import { describe, it, expect, vi } from 'vitest';
import { generateKeyPairSync, createSign } from 'node:crypto';
import { OidcClient, OidcVerificationError } from '../src/index';

function exportJwk(publicKey: ReturnType<typeof generateKeyPairSync>['publicKey'], kid: string) {
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown> & { kid?: string };
  jwk.kid = kid;
  jwk.use = jwk.use ?? 'sig';
  jwk.kty = jwk.kty ?? 'RSA';
  jwk.alg = typeof jwk.alg === 'string' ? jwk.alg : 'RS256';
  return jwk;
}

function signJwt(
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'],
  kid: string,
  payload: Record<string, unknown>,
) {
  const header = { alg: 'RS256', typ: 'JWT', kid };
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const headerSegment = encode(header);
  const payloadSegment = encode(payload);
  const signingInput = `${headerSegment}.${payloadSegment}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(privateKey).toString('base64url');
  return `${signingInput}.${signature}`;
}

describe('OidcClient', () => {
  it('verifies a valid token', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = exportJwk(publicKey, 'kid-1');
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ keys: [jwk] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const client = new OidcClient({
      issuer: 'https://oidc.example',
      audience: 'client-123',
      jwksUri: 'https://oidc.example/jwks',
      fetchImpl: fetchMock,
    });
    const now = Math.floor(Date.now() / 1000);
    const token = signJwt(privateKey, 'kid-1', {
      iss: 'https://oidc.example',
      sub: 'user-123',
      aud: 'client-123',
      exp: now + 600,
      nbf: now - 30,
      iat: now - 30,
      scope: 'openid profile',
    });

    const result = await client.verify(token);

    expect(result.subject).toBe('user-123');
    expect(result.scopes).toEqual(['openid', 'profile']);
    expect(result.expiresAt).toBeGreaterThan(result.issuedAt);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects expired tokens', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = exportJwk(publicKey, 'kid-1');
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ keys: [jwk] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const client = new OidcClient({
      issuer: 'https://oidc.example',
      audience: 'client-123',
      jwksUri: 'https://oidc.example/jwks',
      fetchImpl: fetchMock,
    });
    const now = Math.floor(Date.now() / 1000);
    const token = signJwt(privateKey, 'kid-1', {
      iss: 'https://oidc.example',
      sub: 'user-123',
      aud: 'client-123',
      exp: now - 300,
      nbf: now - 120,
      iat: now - 120,
      scope: 'openid',
    });

    const verification = client.verify(token);
    await expect(verification).rejects.toBeInstanceOf(OidcVerificationError);
    await expect(verification).rejects.toMatchObject({ reason: 'token_expired' as const });
  });

  it('accepts tokens within the configured clock skew', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = exportJwk(publicKey, 'kid-1');
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ keys: [jwk] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const client = new OidcClient({
      issuer: 'https://oidc.example',
      audience: 'client-123',
      jwksUri: 'https://oidc.example/jwks',
      fetchImpl: fetchMock,
      clockSkewSeconds: 120,
    });
    const now = Math.floor(Date.now() / 1000);
    const token = signJwt(privateKey, 'kid-1', {
      iss: 'https://oidc.example',
      sub: 'user-123',
      aud: 'client-123',
      exp: now + 600,
      nbf: now + 60,
      iat: now - 30,
      scope: 'openid',
    });

    await expect(client.verify(token)).resolves.toMatchObject({ subject: 'user-123' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refreshes JWKS when a new kid is encountered', async () => {
    const keyPair1 = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const keyPair2 = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk1 = exportJwk(keyPair1.publicKey, 'kid-1');
    const jwk2 = exportJwk(keyPair2.publicKey, 'kid-2');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ keys: [jwk1] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ keys: [jwk2] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

    const client = new OidcClient({
      issuer: 'https://oidc.example',
      audience: 'client-123',
      jwksUri: 'https://oidc.example/jwks',
      fetchImpl: fetchMock,
      cacheMaxAgeMs: 60_000,
    });

    const now = Math.floor(Date.now() / 1000);
    const token1 = signJwt(keyPair1.privateKey, 'kid-1', {
      iss: 'https://oidc.example',
      sub: 'user-1',
      aud: 'client-123',
      exp: now + 600,
      nbf: now - 60,
      iat: now - 60,
    });
    await client.verify(token1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const token2 = signJwt(keyPair2.privateKey, 'kid-2', {
      iss: 'https://oidc.example',
      sub: 'user-2',
      aud: 'client-123',
      exp: now + 600,
      nbf: now - 10,
      iat: now - 10,
    });
    await client.verify(token2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
