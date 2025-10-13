import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
import { logger } from '@onecare/observability';
import type { SecurityServices, AuthContext } from '@onecare/security';

function resolveReplayWindowMs(): number {
  const raw = process.env.SECURITY_REPLAY_WINDOW_MS;
  const parsed = typeof raw === 'string' ? Number(raw) : NaN;
  const base = Number.isFinite(parsed) && parsed > 0 ? parsed : 300_000;
  return Math.max(base, 1_000);
}

type ScopeSet = Set<string>;

function normalizeScopes(scope?: string[]): ScopeSet {
  if (!scope || scope.length === 0) return new Set();
  return new Set(scope.map((s) => s.trim().toLowerCase()).filter(Boolean));
}

function hasRequiredScope(scopes: ScopeSet, action: string, prefixes: string[]): boolean {
  if (scopes.size === 0) return false;
  const normalizedAction = action.trim().toLowerCase();
  if (!normalizedAction) return false;
  if (scopes.has(normalizedAction)) return true;
  for (const prefix of prefixes) {
    const candidate = `${prefix}:${normalizedAction}`;
    if (scopes.has(candidate)) return true;
    const wildcard = `${prefix}:*`;
    if (scopes.has(wildcard)) return true;
  }
  if (scopes.has('*')) return true;
  return false;
}

function systemAllowlist(): Set<string> {
  const raw = process.env.SECURITY_SYSTEM_ALLOWLIST;
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
  );
}

interface ConsentEntry {
  purpose: string;
  resources: string[];
  reference: string;
  expiresAt?: string;
  grantedAt?: string;
  revoked?: boolean;
  scopes?: string[];
}

type ConsentCache = Record<string, ConsentEntry[]>;

export interface ConsentEvidence {
  reference: string;
  purpose: string;
  resources: string[];
  expiresAt?: string;
  grantedAt?: string;
  scopes?: string[];
}

const consentEvidenceCache = new Map<string, ConsentEvidence>();

function consentCacheKey(patientId: string, purpose: string): string {
  return `${patientId}::${purpose}`;
}

function loadConsentCache(): ConsentCache {
  const raw = process.env.CONSENT_CACHE;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return parsed as ConsentCache;
    }
  } catch (error) {
    logger.warn('failed to parse CONSENT_CACHE', {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  return {};
}

function normaliseResource(resource: string): string {
  return resource.trim().toLowerCase();
}

function hashIdentifier(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

export function getConsentEvidence(patientId: string, purpose: string): ConsentEvidence | null {
  const key = consentCacheKey(patientId, purpose);
  return consentEvidenceCache.get(key) ?? null;
}

export function setConsentEvidenceForTest(patientId: string, purpose: string, evidence: ConsentEvidence): void {
  consentEvidenceCache.set(consentCacheKey(patientId, purpose), evidence);
}

function createDefaultSecurityServices(): SecurityServices {
  const seenRequests = new Map<string, number>();
  const replayWindowMs = resolveReplayWindowMs();

  function gc(now: number): void {
    for (const [key, expiry] of seenRequests.entries()) {
      if (Number.isFinite(expiry) && expiry <= now) {
        seenRequests.delete(key);
      }
    }
  }

  return {
    async verifySignatureAndReplayGuard(authHeader: string | undefined, requestId: string): Promise<boolean> {
      const header = (authHeader || '').trim();
      const reqId = (requestId || '').trim();
      if (!header || !reqId) {
        return false;
      }
      const secret = resolveSharedSecret();
      if (!secret) {
        logger.warn('zero-trust signature rejected', { requestId: reqId, reason: 'secret_missing' });
        return false;
      }
      const token = extractBearerToken(header);
      if (!token) {
        logger.warn('zero-trust signature rejected', { requestId: reqId, reason: 'invalid_header' });
        return false;
      }
      if (!verifySignature(token, reqId, secret)) {
        logger.warn('zero-trust signature rejected', { requestId: reqId, reason: 'mismatch' });
        return false;
      }
      const now = Date.now();
      gc(now);
      const key = reqId;
      if (seenRequests.has(key)) {
        logger.warn('zero-trust replay guard blocked duplicate request', { requestId: reqId });
        return false;
      }
      seenRequests.set(key, now + replayWindowMs);
      if (seenRequests.size > 1024) {
        gc(now);
      }
      return true;
    },
    async authorize(actor: AuthContext['actor'], action: string, patientId?: string, scope?: string[]): Promise<boolean> {
      if (!actor?.id) return false;
      const scopes = normalizeScopes(scope);
      const normalizedAction = action.trim().toLowerCase();
      if (!normalizedAction) return false;
      if (actor.type === 'patient') {
        if (!patientId || patientId !== actor.id) return false;
        return hasRequiredScope(scopes, normalizedAction, ['patient', 'triage']);
      }
      if (actor.type === 'practitioner') {
        return hasRequiredScope(scopes, normalizedAction, ['practitioner', 'triage']);
      }
      if (actor.type === 'system') {
        const allow = systemAllowlist();
        if (allow.size > 0 && !allow.has(actor.id)) {
          logger.warn('system actor denied by allowlist', {
            actorIdHash: hashIdentifier(actor.id),
            action: normalizedAction,
          });
          return false;
        }
        return hasRequiredScope(scopes, normalizedAction, ['system']);
      }
      return false;
    },
    async checkConsent(patientId: string, purpose: string, requestedResources: string[]): Promise<boolean> {
      const normalizedPurpose = purpose.trim().toLowerCase();
      const key = consentCacheKey(patientId, normalizedPurpose);
      consentEvidenceCache.delete(key);
      if (!patientId || !normalizedPurpose || requestedResources.length === 0) {
        return false;
      }
      const consentCache = loadConsentCache();
      const entries = consentCache[patientId];
      if (!Array.isArray(entries) || entries.length === 0) {
        logger.warn('consent check denied - no entries', {
          patientIdHash: hashIdentifier(patientId),
          purpose: normalizedPurpose,
        });
        return false;
      }
      const now = Date.now();
      const requiredResources = requestedResources.map(normaliseResource);
      for (const entry of entries) {
        if (!entry || typeof entry !== 'object') continue;
        if (entry.revoked === true) continue;
        if (typeof entry.purpose !== 'string') continue;
        if (entry.purpose.trim().toLowerCase() !== normalizedPurpose) continue;
        const resources = Array.isArray(entry.resources)
          ? entry.resources.map(normaliseResource).filter(Boolean)
          : [];
        if (resources.length === 0) continue;
        if (!requiredResources.every((res) => resources.includes(res))) continue;
        if (entry.expiresAt) {
          const expires = Date.parse(entry.expiresAt);
          if (Number.isFinite(expires) && expires <= now) continue;
        }
        if (!entry.reference || typeof entry.reference !== 'string') continue;
        const evidence: ConsentEvidence = {
          reference: entry.reference,
          purpose: normalizedPurpose,
          resources: entry.resources ?? [],
          expiresAt: entry.expiresAt,
          grantedAt: entry.grantedAt,
          scopes: Array.isArray(entry.scopes) ? entry.scopes : undefined,
        };
        consentEvidenceCache.set(key, evidence);
        return true;
      }
      logger.warn('consent check denied - no matching consent', {
        patientIdHash: hashIdentifier(patientId),
        purpose: normalizedPurpose,
        requestedResources: requiredResources,
      });
      return false;
    },
  };
}

function resolveSharedSecret(): string | null {
  const secret = process.env.SECURITY_SHARED_SECRET;
  if (!secret) return null;
  const trimmed = secret.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function extractBearerToken(header: string): string | null {
  const parts = header.split(/\s+/).filter(Boolean);
  if (parts.length !== 2) return null;
  if (parts[0].toLowerCase() !== 'bearer') return null;
  return parts[1];
}

function verifySignature(token: string, payload: string, secret: string): boolean {
  const expected = createHmac('sha256', secret).update(payload).digest('base64url');
  let providedBuf: Buffer;
  let expectedBuf: Buffer;
  try {
    providedBuf = Buffer.from(token, 'base64url');
    expectedBuf = Buffer.from(expected, 'base64url');
  } catch {
    return false;
  }
  if (providedBuf.length !== expectedBuf.length) {
    return false;
  }
  try {
    return timingSafeEqual(providedBuf, expectedBuf);
  } catch {
    return false;
  }
}

let activeSecurityServices: SecurityServices = createDefaultSecurityServices();

export function getSecurityServices(): SecurityServices {
  return activeSecurityServices;
}

export function setSecurityServices(services: SecurityServices): void {
  activeSecurityServices = services;
}

export function resetSecurityServices(): void {
  consentEvidenceCache.clear();
  activeSecurityServices = createDefaultSecurityServices();
}
