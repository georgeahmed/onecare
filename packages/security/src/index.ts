import { createHash, createPublicKey, createVerify, type KeyObject } from 'node:crypto';

export interface AuthContext {
  actor: { type: 'patient' | 'practitioner' | 'system'; id: string };
  scope?: string[];
}

export type ConsentDecisionReason =
  | 'granted'
  | 'not_found'
  | 'revoked'
  | 'expired'
  | 'invalid_request'
  | 'scope_mismatch';

export interface ConsentEvidence {
  reference: string;
  purpose: string;
  resources: string[];
  expiresAt?: string;
  grantedAt?: string;
  scopes?: string[];
}

export interface ConsentDecision {
  allowed: boolean;
  reason: ConsentDecisionReason;
  evidence?: ConsentEvidence;
}

export interface ConsentCheckOptions {
  correlationId?: string;
}

export interface SecurityServices {
  verifySignatureAndReplayGuard(authHeader: string | undefined, requestId: string): Promise<boolean>;
  authorize(actor: AuthContext['actor'], action: string, patientId?: string, scope?: string[]): Promise<boolean>;
  checkConsent(
    patientId: string,
    purpose: string,
    requestedResources: string[],
    options?: ConsentCheckOptions,
  ): Promise<ConsentDecision>;
}

export interface OidcClientOptions {
  issuer: string;
  audience: string | string[];
  jwksUri: string;
  httpTimeoutMs?: number;
  cacheMaxAgeMs?: number;
  clockSkewSeconds?: number;
  fetchImpl?: typeof fetch;
}

export interface OidcVerificationResult {
  subject: string;
  scopes: string[];
  expiresAt: number;
  issuedAt: number;
  notBefore?: number;
  claims: Record<string, unknown>;
}

export type OidcErrorReason =
  | 'token_malformed'
  | 'jwks_fetch_failed'
  | 'jwks_invalid'
  | 'unsupported_algorithm'
  | 'signature_invalid'
  | 'claim_invalid'
  | 'token_expired'
  | 'token_not_yet_valid';

export class OidcVerificationError extends Error {
  constructor(message: string, public readonly reason: OidcErrorReason, public readonly cause?: unknown) {
    super(message);
    this.name = 'OidcVerificationError';
  }
}

interface JwtHeader {
  alg: string;
  kid?: string;
  [key: string]: unknown;
}

interface JwtPayload extends Record<string, unknown> {
  iss?: string;
  sub?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  iat?: number;
  scope?: string | string[];
  scp?: string[];
}

interface CachedKey {
  key: KeyObject;
  alg: string;
}

const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_CACHE_MAX_MS = 5 * 60_000;
const DEFAULT_CLOCK_SKEW_MS = 60_000;

function base64UrlDecode(segment: string): Buffer {
  const normalized = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  return Buffer.from(padded, 'base64');
}

function parseJwt(token: string): { header: JwtHeader; payload: JwtPayload; signingInput: string; signature: Buffer } {
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw new OidcVerificationError('JWT must have three segments', 'token_malformed');
  }
  try {
    const header = JSON.parse(base64UrlDecode(parts[0]).toString('utf8')) as JwtHeader;
    const payload = JSON.parse(base64UrlDecode(parts[1]).toString('utf8')) as JwtPayload;
    const signature = base64UrlDecode(parts[2]);
    return { header, payload, signingInput: `${parts[0]}.${parts[1]}`, signature };
  } catch (error) {
    throw new OidcVerificationError('Failed to decode JWT', 'token_malformed', error);
  }
}

function toAudienceSet(audience: string | string[]): Set<string> {
  const list = Array.isArray(audience) ? audience : [audience];
  return new Set(list.map((entry) => entry.trim()).filter(Boolean));
}

function mapAlgorithm(alg: string): { nodeAlgorithm: string } {
  switch (alg) {
    case 'RS256':
      return { nodeAlgorithm: 'RSA-SHA256' };
    case 'RS384':
      return { nodeAlgorithm: 'RSA-SHA384' };
    case 'RS512':
      return { nodeAlgorithm: 'RSA-SHA512' };
    default:
      throw new OidcVerificationError(`Unsupported JWT alg ${alg}`, 'unsupported_algorithm');
  }
}

function extractScopes(payload: JwtPayload): string[] {
  if (Array.isArray(payload.scp)) {
    return payload.scp.map((entry) => entry.trim()).filter(Boolean);
  }
  const source = payload.scope;
  if (!source) return [];
  if (Array.isArray(source)) {
    return source.map((entry) => String(entry).trim()).filter(Boolean);
  }
  if (typeof source === 'string') {
    return source
      .split(/\s+/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return [];
}

function pickSafeClaims(payload: JwtPayload): Record<string, unknown> {
  const allowedKeys = ['iss', 'aud', 'azp', 'acr', 'amr', 'client_id', 'purpose'];
  const safe: Record<string, unknown> = {};
  for (const key of allowedKeys) {
    if (payload[key] !== undefined) {
      safe[key] = payload[key];
    }
  }
  return safe;
}

export class OidcClient {
  private readonly jwksUri: string;
  private readonly issuer: string;
  private readonly audience: Set<string>;
  private readonly fetchImpl: typeof fetch;
  private readonly httpTimeoutMs: number;
  private readonly cacheMaxAgeMs: number;
  private readonly clockSkewMs: number;

  private keys: Map<string, CachedKey> = new Map();
  private lastFetchedAt = 0;
  private inflight?: Promise<void>;

  constructor(options: OidcClientOptions) {
    if (!options?.issuer) {
      throw new Error('OidcClient requires issuer');
    }
    if (!options?.jwksUri) {
      throw new Error('OidcClient requires jwksUri');
    }
    this.issuer = options.issuer.trim();
    this.jwksUri = options.jwksUri.trim();
    this.audience = toAudienceSet(options.audience);
    this.fetchImpl = options.fetchImpl?.bind(globalThis) ?? globalThis.fetch.bind(globalThis);
    this.httpTimeoutMs = Number.isFinite(options.httpTimeoutMs) ? Math.max(200, options.httpTimeoutMs!) : DEFAULT_TIMEOUT_MS;
    this.cacheMaxAgeMs = Number.isFinite(options.cacheMaxAgeMs) ? Math.max(1_000, options.cacheMaxAgeMs!) : DEFAULT_CACHE_MAX_MS;
    const skewSeconds = Number.isFinite(options.clockSkewSeconds)
      ? Math.max(0, options.clockSkewSeconds!)
      : DEFAULT_CLOCK_SKEW_MS / 1_000;
    this.clockSkewMs = skewSeconds * 1_000;
  }

  async verify(token: string): Promise<OidcVerificationResult> {
    const { header, payload, signingInput, signature } = parseJwt(token);
    if (typeof header.alg !== 'string') {
      throw new OidcVerificationError('JWT missing alg header', 'token_malformed');
    }
    const algInfo = mapAlgorithm(header.alg);
    const key = await this.getKey(header);
    const verifier = createVerify(algInfo.nodeAlgorithm);
    verifier.update(signingInput);
    verifier.end();
    const valid = verifier.verify(key.key, signature);
    if (!valid) {
      throw new OidcVerificationError('JWT signature invalid', 'signature_invalid');
    }
    this.validateClaims(payload);
    const scopes = extractScopes(payload);
    const nowMs = Date.now();
    const notBefore = typeof payload.nbf === 'number' ? payload.nbf * 1_000 : undefined;
    const issuedAt = typeof payload.iat === 'number' ? payload.iat * 1_000 : nowMs;
    const expiresAt = typeof payload.exp === 'number' ? payload.exp * 1_000 : nowMs;
    return {
      subject: String(payload.sub),
      scopes,
      expiresAt,
      issuedAt,
      notBefore,
      claims: pickSafeClaims(payload),
    };
  }

  async healthCheck(): Promise<void> {
    await this.refreshJwks(true);
  }

  private async getKey(header: JwtHeader): Promise<CachedKey> {
    const kid = typeof header.kid === 'string' ? header.kid : undefined;
    if (!kid) {
      throw new OidcVerificationError('JWT missing kid header', 'token_malformed');
    }
    const cached = this.keys.get(kid);
    if (cached) {
      return cached;
    }
    await this.refreshJwks(true);
    const refreshed = this.keys.get(kid);
    if (!refreshed) {
      throw new OidcVerificationError('JWKS did not contain required kid', 'jwks_invalid');
    }
    return refreshed;
  }

  private validateClaims(payload: JwtPayload): void {
    if (typeof payload.iss !== 'string' || payload.iss.trim() !== this.issuer) {
      throw new OidcVerificationError('Issuer mismatch', 'claim_invalid');
    }
    if (typeof payload.sub !== 'string' || payload.sub.trim().length === 0) {
      throw new OidcVerificationError('Subject missing', 'claim_invalid');
    }
    const audiences = Array.isArray(payload.aud) ? payload.aud.map(String) : [String(payload.aud ?? '')];
    const normalizedAud = audiences.map((entry) => entry.trim()).filter(Boolean);
    if (normalizedAud.length === 0) {
      throw new OidcVerificationError('Audience missing', 'claim_invalid');
    }
    const hitsAudience = normalizedAud.some((aud) => this.audience.has(aud));
    if (!hitsAudience) {
      throw new OidcVerificationError('Audience mismatch', 'claim_invalid');
    }
    const nowMs = Date.now();
    if (typeof payload.exp === 'number') {
      const expiryMs = payload.exp * 1_000;
      if (expiryMs + this.clockSkewMs <= nowMs) {
        throw new OidcVerificationError('Token expired', 'token_expired');
      }
    } else {
      throw new OidcVerificationError('exp claim missing', 'claim_invalid');
    }
    if (typeof payload.nbf === 'number') {
      const notBeforeMs = payload.nbf * 1_000;
      if (notBeforeMs - this.clockSkewMs > nowMs) {
        throw new OidcVerificationError('Token not yet valid', 'token_not_yet_valid');
      }
    }
    if (typeof payload.iat === 'number') {
      const issuedMs = payload.iat * 1_000;
      if (issuedMs - this.clockSkewMs > nowMs) {
        throw new OidcVerificationError('iat in the future', 'claim_invalid');
      }
    }
  }

  private async refreshJwks(force = false): Promise<void> {
    const now = Date.now();
    if (!force && now - this.lastFetchedAt < this.cacheMaxAgeMs && this.keys.size > 0) {
      return;
    }
    if (this.inflight) {
      await this.inflight;
      return;
    }
    this.inflight = this.fetchJwks();
    try {
      await this.inflight;
    } finally {
      this.inflight = undefined;
    }
  }

  private async fetchJwks(): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.httpTimeoutMs);
    try {
      const response = await this.fetchImpl(this.jwksUri, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new OidcVerificationError(`JWKS fetch failed with ${response.status}`, 'jwks_fetch_failed');
      }
      const body = await response.json();
      if (!body || typeof body !== 'object' || !Array.isArray((body as { keys?: unknown }).keys)) {
        throw new OidcVerificationError('JWKS payload invalid', 'jwks_invalid');
      }
      const next = new Map<string, CachedKey>();
      for (const entry of (body as { keys: Array<Record<string, unknown>> }).keys) {
        if (!entry || typeof entry !== 'object') continue;
        const kid = typeof entry.kid === 'string' ? entry.kid : undefined;
        if (!kid) continue;
        try {
          const key = createPublicKey({ key: entry, format: 'jwk' });
          const alg = typeof entry.alg === 'string' ? entry.alg : 'RS256';
          next.set(kid, { key, alg });
        } catch (error) {
          throw new OidcVerificationError('Failed to import JWKS key', 'jwks_invalid', error);
        }
      }
      if (next.size === 0) {
        throw new OidcVerificationError('JWKS contained no usable keys', 'jwks_invalid');
      }
      this.keys = next;
      this.lastFetchedAt = Date.now();
    } catch (error) {
      if (error instanceof OidcVerificationError) {
        throw error;
      }
      throw new OidcVerificationError('Failed to fetch JWKS', 'jwks_fetch_failed', error);
    } finally {
      clearTimeout(timer);
    }
  }
}

export function hashIdentifier(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}
