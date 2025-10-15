Navigation: [Task Index](../../../docs/TASK_INDEX.md) | [All Tasks Flow](../../all-tasks-flow.md) | [Prev](SRE-02.4.md) | [Next](../SRE-02.6.md)

Task: SRE-02.5 — Node OTEL init + correlation context

Context
- Initialize Node OTEL SDK (or stub) and propagate correlation IDs across services.

Files
- packages/observability/src/otel.ts
- apps/orchestrator/src/index.ts

Steps
1) Expand otel.ts to expose initTracing(serviceName) and context helpers.
2) Call initTracing('orchestrator') at startup; ensure setCorrelationId hooks context.
3) Document env vars for OTEL exporter endpoints.

Acceptance Criteria
- Typecheck passes; logs show spans/correlation id when enabled.

Validate
- npm run build && npm run typecheck

Status Update
- make engineer-done ENGINEER=devops-sre/engineer-02 TASK='SRE-02.5' && make team-status-write
