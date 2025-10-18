# Completed Tasks — Integrations Engineer 01

- [x] IN-01.2 — Bundle upsert (transaction) with retry/timeout is implemented in the HTTP repository with bounded retries, abort-driven timeouts, and correlation-aware metrics (apps/orchestrator/src/adapters/persistence/fhir.repository.ts:127, apps/orchestrator/src/adapters/persistence/fhir.repository.test.ts:52).
- [x] IN-01.3 — Task/Appointment/DocumentReference create helpers call the FHIR endpoints with consistent instrumentation and retry handling (apps/orchestrator/src/adapters/persistence/fhir.repository.ts:137, apps/orchestrator/src/adapters/persistence/fhir.repository.test.ts:64).
- [x] IN-01.6 — The YAML config loader merges layered files, enforces safety floors/ceilings, and is covered by unit tests (packages/config/src/index.ts:404, packages/config/test/loadConfig.test.ts:95).
- [x] IN-01.7 — `validateProfile` stub and wrapper helpers guard FHIR resources with unit tests verifying the failure modes (packages/ports/src/fhir.ts:63, packages/ports/test/fhir.test.ts:13).
- [x] IN-01.13 — Readiness and health probes now surface FHIR/Object Store/OIDC status with cached dependency checks (apps/orchestrator/src/index.ts:343, apps/orchestrator/test/readiness.test.ts:21).
- [x] IN-01.1 — The HTTP FHIR repository emits PHI-safe request logs, honours Prefer/If-Match headers, and exposes a `readResource` helper for GETs (apps/orchestrator/src/adapters/persistence/fhir.repository.ts:243, apps/orchestrator/src/adapters/persistence/fhir.repository.test.ts:38).
- [x] IN-01.9 — Circuit breaker, retry-after backoff, and jittered retry handling guard FHIR operations with coverage for open/half-open transitions (apps/orchestrator/src/adapters/persistence/fhir.repository.ts:262, apps/orchestrator/src/adapters/persistence/fhir.repository.test.ts:101).
- [x] IN-01.10 — Idempotent operations support conditional requests and treat 409/412 conflicts as safe outcomes, wiring If-Match options through the ports layer (apps/orchestrator/src/adapters/persistence/fhir.repository.ts:356, packages/ports/src/fhir.ts:56, apps/orchestrator/src/adapters/persistence/fhir.repository.test.ts:137).
- [x] IN-01.11 — Added `readResource` with query support and Retry-After aware retries for 429s (apps/orchestrator/src/adapters/persistence/fhir.repository.ts:243, apps/orchestrator/src/adapters/persistence/fhir.repository.test.ts:74).
- [x] IN-01.12 — Request logging now uses the shared redacting logger for all FHIR calls, aligning observability with correlation IDs (apps/orchestrator/src/adapters/persistence/fhir.repository.ts:306, apps/orchestrator/src/adapters/persistence/fhir.repository.test.ts:38).
- [x] IN-01.14 — Responses are validated for `application/fhir+json` with UTF-8 charset before parsing, ensuring bad payloads fail fast (apps/orchestrator/src/adapters/persistence/fhir.repository.ts:320, apps/orchestrator/src/adapters/persistence/fhir.repository.test.ts:108).
- [x] IN-01.16 — Object Store guidance and adapters avoid logging PHI, documenting patterns in `docs/CONVENTIONS.md:55` and relying on structured metrics only (apps/orchestrator/src/adapters/persistence/object-store.client.ts:180).
- [x] IN-01.17 — `/safety-check` latency/throughput baselines recorded and referenced in release readiness (docs/perf/orchestrator-baselines.md:1, docs/RELEASE_READINESS.md:23).
- [x] IN-01.18 — Contract-style coverage added for FHIR circuit breaker and readiness probes (apps/orchestrator/src/adapters/persistence/fhir.repository.test.ts:38, apps/orchestrator/test/readiness.test.ts:1).
- [x] IN-01.19 — Documented hardened FHIR/Object Store/OIDC integration decisions (docs/adr/2025-10-16-fhir-object-store-oidc.md:1).
- [x] IN-01.4 — DocumentReference creation now stages inline/contained Binary payloads via the ObjectStore adapter before linking, with tests covering base64 decoding and contained resources (packages/ports/src/fhir.ts:116, apps/orchestrator/src/adapters/persistence/object-store.client.ts:1, packages/ports/test/fhir.test.ts:74, apps/orchestrator/src/adapters/persistence/object-store.client.test.ts:1).
- [x] IN-01.5 — Consent checks return typed decisions with correlation-aware logging and evidence caching, aligning the contract for deny-by-default flows (apps/orchestrator/src/adapters/security/index.ts:176, apps/orchestrator/test/attachments.test.ts:24, apps/orchestrator/test/securityGate.test.ts:108).
- [x] IN-01.15 — NHS Login OIDC client verifies tokens against rotating JWKS with claim validation, skew tolerance, and dedicated tests (packages/security/src/index.ts:41, packages/security/test/oidc.test.ts:1).


Status: planned
Progress: 0%
