Title: Bus Partitioning Strategy & Hot-Key Mitigation
Date: 2025-10-18
Status: Accepted

Context
- Our NATS deployment uses JetStream subjects with optional partition suffixes (`<topic>.p{0..N-1}`) to balance ordering guarantees and throughput.
- Tenants generate uneven traffic (clinical hubs vs. pilot sites), so we must pick partition keys that preserve in-order processing per patient/tenant while avoiding hot subjects.
- We already hash partition keys in `NatsBus` and enforce per-tenant quotas; operators also need visibility into uneven distribution and hot keys.

Decision
- Partition keys derive from, in order: explicit `x-partition-key` header, tenant/practice identifiers, envelope `partitionKey`, `correlationId`, then `id`. Handlers receive the resolved `partitionKey` and may log it for debugging.
- Subjects are published as `<topic>.p{partition}`, where `partitionIndexFor(hash(key) % partitionCount)` chooses the suffix. Queue groups subscribe to `<topic>.>` so all partitions fan into the same consumer pool while preserving per-key ordering.
- Hot key detection: record `bus.partition.hot_key` counters keyed by partition, tenant, and topic whenever occupancy exceeds a configurable threshold (based on observed rate vs. average). Metrics feed dashboards to highlight skew.
- Provide docs and tests guaranteeing: (a) messages with the same key remain ordered, (b) keys distribute fairly over partitions, (c) missing keys fall back to subject `.p0` for deterministic behaviour.
- Operators can mitigate hot keys by increasing `NATS_PARTITIONS`, adjusting quota overrides, or deploying tenant-specific workers.
- Telemetry: `bus.partition.hot_key` fires when per-key throughput crosses `NATS_PARTITION_HOT_KEY_RATE_TPS` within `NATS_PARTITION_HOT_KEY_WINDOW_MS`. Dashboards pair this with per-tenant throughput to highlight skew.

Consequences
- Envelope producers must continue to populate `partitionKey` or headers; otherwise traffic fans into `.p0`. Tests enforce this fallback.
- Observability dashboards surface `bus.partition.hot_key` for capacity planning; alerts fire when an individual partition carries >X% of topic traffic.
- Increasing partition count requires coordinated redeploy (JetStream handles subject wildcards); existing metrics track distribution so we can evaluate the impact.
