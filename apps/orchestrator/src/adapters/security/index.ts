import { logger } from '@onecare/observability';
import type { SecurityServices, AuthContext } from '@onecare/security';

function resolveReplayWindowMs(): number {
  const raw = process.env.SECURITY_REPLAY_WINDOW_MS;
  const parsed = typeof raw === 'string' ? Number(raw) : NaN;
  const base = Number.isFinite(parsed) && parsed > 0 ? parsed : 300_000;
  return Math.max(base, 1_000);
}

function normalizeActionScope(action: string, scope?: string[]): boolean {
  if (!scope || scope.length === 0) return false;
  const normalized = scope.map((s) => s.trim().toLowerCase()).filter(Boolean);
  return normalized.includes(action.toLowerCase()) || normalized.includes(`triage:${action}`.toLowerCase());
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
      const now = Date.now();
      gc(now);
      const key = `${reqId}:${header}`;
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
      if (actor.type === 'patient') {
        return Boolean(patientId && patientId === actor.id);
      }
      if (actor.type === 'practitioner') {
        return normalizeActionScope(action, scope);
      }
      if (actor.type === 'system') {
        return true;
      }
      return false;
    },
    async checkConsent(patientId: string, purpose: string, requestedResources: string[]): Promise<boolean> {
      if (!patientId) return false;
      if (purpose !== 'care') return false;
      return requestedResources.length > 0;
    },
  };
}

let activeSecurityServices: SecurityServices = createDefaultSecurityServices();

export function getSecurityServices(): SecurityServices {
  return activeSecurityServices;
}

export function setSecurityServices(services: SecurityServices): void {
  activeSecurityServices = services;
}

export function resetSecurityServices(): void {
  activeSecurityServices = createDefaultSecurityServices();
}
