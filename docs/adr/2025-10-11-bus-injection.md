Title: Bus Adapter Injection for Services
Date: 2025-10-11
Status: Accepted

Context
- Services currently use `MemoryBus` for dev flows. We need a production-grade bus (NATS/Kafka) with durable delivery, retries/DLQ, ordering, and observability. We must swap implementations without changing business logic and keep tests deterministic.

Decision
- Define a bus adapter factory that resolves a `MessageBus` implementation from configuration (env and service config). Default to `MemoryBus` in dev; use `NatsBus` in prod.
- Publish/subscribe APIs remain the shared `@onecare/bus` `MessageBus` interface. Envelope typing uses `TypedEnvelope<T>` and `createEnvelope()` from `@onecare/events`.
- Enforce topic allowlist and envelope schema validation at the adapter boundary. Always propagate `correlationId` via headers.

Consequences
- Orchestrator and services construct a `MessageBus` via the factory (injection), enabling easy swap and test doubles.
- Unit tests continue to use `MemoryBus`; adapter parity tests ensure `NatsBus` behaves equivalently (ordering/acks semantics clarified per subject/queue).
- Observability is consistent: publish/consume spans and latency histograms, correlationId in logs, retry/DLQ metrics.
- Security posture improves: adapter centralizes TLS/credentials, subject ACLs, and message size/allowlist policies.

Implementation Notes
- BE-02 implements `NatsBus` with durable subscriptions, ack deadlines, reconnect/backoff, and DLQ routing.
- Services call a small factory `createBusFromEnv()` (or DI) to get the correct implementation based on env/config.
- Docs updated (AGENTS.md, docs/EVENTS.md) to use `TypedEnvelope<T>` and `createEnvelope()`; topic allowlist and schema validation enforced in adapter.

