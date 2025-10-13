Status: Accepted
Date: 2025-10-12

Context
- We need a durable feature store backend to serve online feature vectors for near-real-time inference and support ad-hoc inspection/debugging.
- Candidate options were Redis (low-latency cache), SQLite (embedded store), and Postgres (managed relational database).
- Requirements: millisecond-level reads (<10 ms at p95), support for atomic upserts and TTL/expiry, ability to run analytical queries for verification, reuse existing SRE expertise, and straightforward integration with Python/TypeScript services.
- Constraints: production traffic < 2k RPS initially, multi-tenant (per-tenant namespaces), encrypted at rest, Goldilocks retention (7–30 days online), minimal net-new infrastructure.

Decision
- Adopt managed Postgres (AWS Aurora PostgreSQL or Cloud SQL equivalent) as the initial feature store backend.
- Justification:
  - Provides ACID semantics and native support for multi-row upserts (`INSERT ... ON CONFLICT`) needed for batch feature ingestion and point updates.
  - Can model features using JSONB columns + generated columns for flexible schemas while maintaining secondary indexes for latency-critical lookups.
  - Built-in TTL via partitioning + scheduled jobs and robust auditing (pgAudit) aligns with PHI governance requirements.
  - Operational alignment: existing platform team already maintains Postgres for transactional workloads; leveraging shared tooling (backups, monitoring, failover) minimizes new SRE overhead.
  - Extensible: enables materialized views for offline validation, and we can introduce Redis later as an L1 cache in front of Postgres if latency or cost warrant it.
- Alternatives:
  - Redis: excellent p99 latency but requires additional persistence guarantees (AOF), limited querying/auditing, higher operational overhead; we will revisit when write QPS approaches >5k or sub-5 ms read SLA is required.
  - SQLite: easiest to embed, but lacks horizontal scalability, limited concurrency, and inadequate for HA requirements.

Consequences
- Positive:
  - Strong consistency and transactional guarantees simplify correctness for feature freshness and backfills.
  - Minimal new infrastructure; leverages existing observability, backups, and encryption policies.
  - SQL tooling eases debugging, ad-hoc analytics, and governance reviews.
- Negative / Risks:
  - Higher read latency compared to in-memory stores; must tune indexes and connection pooling (p95 target 10 ms).
  - Write throughput limited by single writer per partition; will need batching discipline and monitoring.
  - Potential cost increase vs. lightweight cache; mitigate via storage tiering and partition pruning.
- Mitigations:
  - Introduce `pg_partman`-style partitioning by eventDate for manageable retention.
  - Use PgBouncer/pgpool for connection pooling; set connection limits in app configs.
  - Add read replicas if analytics queries contend with online traffic.

Rollout Plan
1. Provision managed Postgres instance (dev/stage/prod) with encryption, automated backups, and logical replication enabled.
2. Define schema:
   - `feature_sets` table (namespace metadata, retention policy).
   - `feature_values` table with columns: `entity_id`, `feature_set_id`, `event_ts`, `feature_payload` (JSONB), indexes on (`feature_set_id`, `entity_id`).
   - Add retention policy via partitioned tables (daily partitions) and scheduled pruning job.
3. Ship infrastructure Terraform module and apply to dev → stage → prod (with approval gates).
4. Update feature ingestion pipeline to use SQL upserts; include retry/backoff with idempotency keys.
5. Instrument metrics (get latency, upsert latency, queue depth) and add dashboards/alerts.
6. Evaluate live traffic after 2 weeks; capture p95 latency and error rate. If latency breach > SLA, prototype Redis cache fronting Postgres (ADR follow-up).

References
- docs/ML_ENV.md (env variables for DB connection secrets).
- Future tasks: MO-02.10 (online store health/readiness), MO-02.14 (load tests).
- AWS Aurora Postgres best practices: https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/AuroraPostgreSQL.BestPractices.html
