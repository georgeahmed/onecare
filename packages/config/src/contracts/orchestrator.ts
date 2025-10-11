// AUTO-GENERATED from schemas. DO NOT EDIT.\n

export interface OrchestratorConfig {
  practiceId: string;
  safetyGate?: {
    timeoutMs?: number;
    maxRetries?: number;
    fallback?: "rules" | "none";
    circuitBreaker?: {
      failureThreshold: number;
      openMs: number;
    };
  };
  http?: {
    bodyLimitBytes?: number;
    rateLimit?: {
      perIpRps?: number;
      perIpBurst?: number;
      perTenantRps?: number;
      perTenantBurst?: number;
    };
  };
  idempotency?: {
    ttlSeconds?: number;
  };
  concurrency?: {
    globalMax?: number;
    perState?: {
      [k: string]: number;
    };
  };
  outbound?: {
    allowlistHosts?: string[];
  };
  logging?: {
    redaction?: {
      fields?: string[];
    };
  };
}
