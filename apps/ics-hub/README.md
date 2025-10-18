ICS Hub (Cross-Org Broker)
==========================

Purpose
-------
- Cross-organisation referral exchange, automation, and acknowledgements.

State Flow
----------
- Inbound → Validated → Routed → Acked (`apps/ics-hub/src/application/ics.state.ts`).

Key adapters
------------
- `IcsHttpClient` – HTTPS client with endpoint allowlists, retries, circuit breaker, rate limiting, and
  runtime credential rotation via `refreshRouteCredentials()`.
- `publishWithGuard` (bus adapter) – guarded publishing with retries, bounded timeouts, and DLQ fallback
  (`apps/ics-hub/src/adapters/bus.adapter.ts`).
- `createSandboxHarness()` – deterministic fixture loader for offline playback (`apps/ics-hub/src/dev/sandbox.ts`).

Recent integration updates
--------------------------
- Endpoints are validated with the same SSRF guardrails as CPCS: HTTPS only, no credentials, and
  private/loopback hosts are rejected.
- Accept headers default to `application/json` for both referral and acknowledgement flows, aligning with
  upstream schema negotiation.
- `refreshRouteCredentials()` lets operators rotate route-specific API keys, TLS bundles, and correlation
  headers without rebuilding the client.
- Performance harnesses (`test/ics.perf.test.ts`) enforce a ≤20 ms average call budget for referrals and
  ≤15 ms for acknowledgements while ensuring latency histograms remain populated.
- Sandbox fixtures (`src/dev/fixtures/*.json`) cover ICS referral requests/acks and CPCS referral outcomes,
  enabling deterministic playback in tests and local tooling.
- Backpressure + audit resiliency: a shared `ProcessingLimiter` caps concurrent message handling (emitting
  `ics.backpressure.*` metrics) while the bounded `AuditSpool` retries audit events before publishing via
  the guarded bus adapter.

Runtime knobs
-------------
- `ICS_PROCESSING_MAX_CONCURRENCY` (default `16`) — permits concurrently processed envelopes.
- `ICS_PROCESSING_QUEUE_LIMIT` (default `64`) — maximum queued requests awaiting a processing slot.
- `ICS_PROCESSING_HIGH_WATERMARK` (default `32`) — queue depth that triggers immediate 429 backpressure.
- `ICS_PROCESSING_RETRY_AFTER` (default `2` seconds) — `Retry-After` header returned when overloaded.
- `ICS_AUDIT_SPOOL_MAX` (default `512`) — bounded audit queue size before events are dropped (drops are metered).
- `ICS_AUDIT_SPOOL_ATTEMPTS` (default `5`) and `ICS_AUDIT_SPOOL_DELAY_MS` (default `250`) — retry tuning for audit publishes.

Local commands
--------------
```
# Run service unit, adapter, and sandbox tests
npm run test -- apps/ics-hub/test

# Execute only the perf harness
npm run test -- apps/ics-hub/test/ics.perf.test.ts
```
