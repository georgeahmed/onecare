Title: Message Bus Selection & Delivery Semantics
Date: 2025-10-18
Status: Accepted

Context
- We need a production bus that can fan out orchestrator events with durable retention, replay support, and predictable latency.
- Kafka offers partitioned throughput but carries higher operational overhead (ZooKeeper-less mode still requires brokers, schema registry, and external ACL tooling) and increases cold-start cost for our Node services.
- NATS JetStream provides lightweight deployment, native Go client compatibility for Python/Node via nkeys/creds, deterministic subject wildcards, and streaming (ack, replay, DLQ) with lower infra footprint.
- Existing services already rely on `@onecare/bus` and the MemoryBus. We must guarantee at-least-once semantics in prod while retaining parity with tests and avoiding double-processing via idempotency.

Decision
- Standardize on NATS JetStream as the production bus for orchestrator and related services.
- Operate with at-least-once delivery: consumers must ack each message; retries use exponential backoff with bounded attempts before DLQ handoff.
- Enforce per-topic ordering within a partition by deriving `partitionKey` from business identifiers (e.g., `correlationId`, `patientId`, or tenant). Subjects fan out as `<topic>.p{0..N-1}` and queue subscriptions consume with a single durable (`<topic>-orchestrator`).
- Derive partition keys from tenant/practice headers when present so that workloads stay isolated by tenant; per-tenant quotas (token buckets) ensure noisy neighbours cannot starve shared capacity.
- Enforce message size policy at the adapter: payloads above the JetStream limit trigger compression (gzip JSON) before publish; if still too large we reject with `message_size_limit_exceeded` and record `bus_msg_too_large_total` for SRE visibility.
- Guard every publish with `createEnvelope()` and idempotency metadata (`id`, `correlationId`, `partitionKey`). Consumers combine the envelope id with an `IdempotencyStore` (`executeWithIdempotency`) to discard duplicates.
- Keep MemoryBus as the default dev/test implementation; maintain contract parity tests that replay scenarios (ordering, dedupe, DLQ) against both adapters.

Consequences
- Services must continue to populate deterministic envelope ids and correlation IDs; missing metadata causes guard rejections.
- Partition selection is explicit: adding a new route or topic requires defining a stable partition key strategy and updating tests to confirm ordering.
- Orchestrator, triage, and downstream handlers must treat payload processing as idempotent — persistent writes should use idempotency keys or natural keys to avoid double inserts.
- DLQ processing hinges on the metadata we include (deliveries, partition key, message id); runbooks and tooling (e.g., `scripts/dlq-requeue.js`) rely on this shape.
- We avoid Kafka operational overhead, but accept NATS limits (e.g., single subject ordering per partition; eventual consistency when resharding). Scaling throughput entails increasing `partitionCount` and spinning additional queue workers.
