Navigation: [Task Index](../../../docs/TASK_INDEX.md) | [All Tasks Flow](../../all-tasks-flow.md) | [Prev](SRE-02.6.md) | [Next](SRE-02.8.md)

Task: SRE-02.7 — Trace sampling policy (tail-based; error/latency bias)

Context
- Avoid overwhelming backends by sampling traces intelligently; keep error and high-latency traces.

Files
- infra/otel/otel-collector.yaml (extend)
- docs/observability/TRACING.md (new)

Steps
1) Configure tail-based sampling in the collector to keep 100% of error traces and a higher fraction of slow traces while downsampling the rest.
2) Document sampling rates and how to adjust; include examples for different environments.

Implementation Notes
- `infra/otel/otel-collector.yaml` now enables tail-based sampling with error, latency, and probabilistic policies.
- `docs/observability/TRACING.md` documents the rationale, environments knobs, and verification steps.

Acceptance Criteria
- Collector applies sampling; docs explain policy and knobs.

Validate
- Simulate traffic; observe sampling behavior in logs.

Status Update
- make engineer-done ENGINEER=devops-sre/engineer-02 TASK='SRE-02.7' && make team-status-write
