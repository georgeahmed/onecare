Navigation: [Task Index](../../../docs/TASK_INDEX.md) | [All Tasks Flow](../../all-tasks-flow.md) | [Prev](SRE-02.7.md) | [Next](../SRE-02.9.md)

Task: SRE-02.8 — Metrics pipeline hardening (cardinality limits, relabeling, histograms)

Context
- Prevent metrics explosions and ensure efficient aggregation with sane histograms and relabeling.

Files
- docs/observability/METRICS.md (new)
- infra/monitoring/prometheus.yml (new or extend)

Steps
1) Define cardinality limits for labels; avoid user/IDs; document allowed labels.
2) Choose histogram buckets for latencies and sizes; standardize across services.
3) Add relabeling in Prometheus to drop high-cardinality labels; document guidance for developers.

Implementation Notes
- `docs/observability/METRICS.md` codifies label hygiene, histogram buckets, and dashboard expectations.
- `infra/monitoring/prometheus.yml` provides a hardened scrape config (label dropping, histogram focus) and is wired into docker-compose via the `prometheus` service.

Acceptance Criteria
- Metrics pipeline stable; docs guide label usage and histograms.

Validate
- Inspect scraped metrics; ensure no unbounded labels; review dashboards.

Status Update
- make engineer-done ENGINEER=devops-sre/engineer-02 TASK='SRE-02.8' && make team-status-write
