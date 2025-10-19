ICS Hub (Cross-Org Broker)
==========================

Purpose
-------
- Cross-organisation referral exchange, automation, and acknowledgements. Accepts upstream referral envelopes, routes to destination providers, and fans out automation/audit outputs.

State Flow
----------
- Core path: Inbound → Validated → Routed → Acked (`apps/ics-hub/src/application/ics.state.ts`).
- Early exits: Invalid, Blocked, and RateLimited short-circuit the flow while releasing backpressure handles and preserving retry metadata.
- `buildIcsMachine()` (`src/application/ics.machine.ts`) wires the state machine together; `runIcsMachine()` advances it until one of the terminal states is reached.

- Key adapters and helpers:
  - `IcsHttpClient` — HTTPS client with endpoint allowlists, bounded retries, rate limiting, and runtime credential rotation via `refreshRouteCredentials()`.
  - `publishWithGuard` — guarded message bus publisher (timeouts, retries, circuit breaker, DLQ fallback).
  - `ProcessingLimiter` — concurrency + queue limiter with retry-after support.
  - `AuditSpool` — buffered audit dispatcher with bounded retries before DLQ.
  - `createSandboxHarness()` — deterministic fixture loader for offline playback (`src/dev/sandbox.ts`).

Routing Policies
----------------
- `InboundState` loads organisation policies from `@onecare/config` and normalises org IDs. Policies define destination endpoints, authentication headers, rate limits, and automation feature flags.
- Token bucket rate limiting enforces per-organisation throughput; when depleted, responses return HTTP 429 with `Retry-After` while logging `ics.routing.rate_limited_total`.
- SSRF guardrails reject non-HTTPS, loopback, or credential-bearing endpoints before invocation.
- Route decisions capture both policy metadata and dynamic overrides (priority, tenancy). They are logged, metered (`ics.routing.decisions_total`), and piped into automation if enabled.
- Fallback routing (`policy: 'fallback'`) keeps the service operating if the policy cache is stale; operators must refresh configuration to restore precise routing (see ADR `2025-10-20-ics-routing.md`).

Acknowledgement Semantics
-------------------------
- Referrals are acknowledged via `IcsClient.sendReferral` with per-route timeouts and retries. Successful acks emit `ics.referral.ack_published` logs and increment `ics.ack.published_total`.
- Ack publishing wraps `publishReferralAck` with idempotency. Keys follow `ics:ack:{orgId}:{referralId}:{envelopeId}` and reuse `IdempotencyStore` to dedupe retries; duplicates add `ics.ack.duplicate_total`.
- Failures fall back to guarded retries and DLQ emission with summarised payload (`Topics.broker.deadLetter`). `ics.ack.failed_total` increments alongside failure logs; audit entries capture rationale for replay.
- Ack latency histograms (`ics.ack.latency_ms`) and structured traces identify slow downstreams. Correlation IDs propagate end-to-end so providers and auditors can reconcile acknowledgements.

Automation Bridge
-----------------
- When policies enable automation, routed referrals hydrate automation events which are evaluated by `automation.rules.ts`. Rules filter on topics/status/tags and emit intents with explicit reasons.
- Intents convert to `TaskCreated` envelopes via `buildAutomationTaskCreations`; debounce windows are honoured so rules can suppress flapping events.
- Automation publishes leverage the same guarded bus adapter, optional audit fan-out (`automation.task.created`), and idempotent keys to avoid duplicate task creation. ADR `2025-10-20-automation-design.md` captures the trigger/debounce strategy.

Backpressure, DLQ, and Reprocessing
-----------------------------------
- `ProcessingLimiter` caps concurrent referrals (`ICS_PROCESSING_MAX_CONCURRENCY`) and queues (size `ICS_PROCESSING_QUEUE_LIMIT`). High-watermarks emit `ics.backpressure.overload_total` and return `Retry-After` headers derived from configuration.
- `AuditSpool` absorbs transient publish failures. It retries up to `ICS_AUDIT_SPOOL_ATTEMPTS` with delay `ICS_AUDIT_SPOOL_DELAY_MS` before DLQ routing, ensuring audit trails are durable without stalling referrals.
- All DLQ events contain correlation IDs, attempt counts, and summarised payload pointers for safe replay. Operators can use `src/dev/replay.ts` to drain DLQs back through the state machine once issues are resolved.

Configuration
-------------
- Processing & Backpressure
  - `ICS_PROCESSING_MAX_CONCURRENCY` (default `16`)
  - `ICS_PROCESSING_QUEUE_LIMIT` (default `64`)
  - `ICS_PROCESSING_HIGH_WATERMARK` (default `32`)
  - `ICS_PROCESSING_RETRY_AFTER` (seconds, default `2`)
- Audit Spool
  - `ICS_AUDIT_SPOOL_MAX` (default `512`)
  - `ICS_AUDIT_SPOOL_ATTEMPTS` (default `5`)
  - `ICS_AUDIT_SPOOL_DELAY_MS` (default `250`)
- Automation
  - `ICS_AUTOMATION_TRIGGERS` or `ICS_AUTOMATION_TRIGGERS_FILE` — JSON ruleset (`automation.rules.ts` normalises the config).
  - `ICS_AUTOMATION_MAX_TASKS`, debounce and audit overrides (see automation ADR for details).
- Client Credentials
  - Route-specific credentials and headers derive from organisation policy configuration (`@onecare/config`); rotation happens via `refreshRouteCredentials()`.

Operational Notes
-----------------
- Metrics: `ics.routing.*`, `ics.ack.*`, `ics.backpressure.*`, and automation counters feed SLO dashboards.
- Replay: `src/dev/sandbox.ts` + deterministic fixtures underpin contract tests and offline debugging (`npm run test -- apps/ics-hub/test`).
- Performance harness `test/ics.perf.test.ts` enforces ≤ 20 ms referral calls and ≤ 15 ms ack latency under load.
- Refer to ADRs `2025-10-20-ics-routing.md` and `2025-10-20-automation-design.md` for rationale, failure modes, and reprocessing playbooks.

Local commands
--------------
```
# Run service unit, adapter, and sandbox tests
npm run test -- apps/ics-hub/test

# Execute only the perf harness
npm run test -- apps/ics-hub/test/ics.perf.test.ts
```
