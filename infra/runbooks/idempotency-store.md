Idempotency Store Runbook (Redis)

Purpose
- Provide a shared, race-safe idempotency mechanism across services to prevent duplicate side-effects.

Design
- API: `reserve(key, ttlSeconds) -> boolean` (atomic), `exists(key)`, `put(key, ttl)` (fallback).
- TTL guidance: default 600s for HTTP; tune per flow. Prefer natural keys (practiceId+patientId+slotId) without PHI content.
- Keys: SHA-256 of canonical subset + actor; never include full narratives or PHI-rich fields.

Provisioning
- Redis cluster or single instance for dev; enforce AUTH; network policies restrict access.
- Namespacing: per-environment prefixes; eviction policy set to avoid data loss under pressure.

Docker Compose (dev)
```yaml
services:
  redis:
    image: redis:7-alpine
    command: ["redis-server", "--requirepass", "${REDIS_PASSWORD:-changeme}"]
    ports:
      - "6379:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 2s
      retries: 10
```

Client env example
```
REDIS_URL=redis://:changeme@localhost:6379
IDEMPOTENCY_TTL_SECONDS=600
```

Client Settings
- Short timeouts; minimal retries; TLS where available.

Validation
- Concurrency tests (N parallel reserves); verify only one `reserved` and others `exists` within TTL.
