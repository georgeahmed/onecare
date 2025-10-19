# 2025-10-20 — Automation Triggers, Debounce, and Idempotency

- Status: Accepted
- Deciders: Automation, ICS Hub, Platform
- Date: 2025-10-20

## Context

Automation ingest currently rides on ICS Hub referral outcomes, emitting follow-up tasks (recalls, repeats, documentation checks). Previous iterations introduced a rules engine, but we needed to document configuration expectations, debouncing, and how idempotency/backpressure apply when firing automation tasks alongside acknowledgements.

## Decision

1. **Config-Driven Rules** — Automation rules load from JSON (`ICS_AUTOMATION_TRIGGERS` or file). Each rule defines conditions (topics, status transitions, tag filters, JSON-path equality) and a task template (priority, owner, patient derivation). Rules are normalised and validated before evaluation; duplicate rule names are ignored to avoid double firing.
2. **Intent Pipeline** — `evaluateAutomationTriggers` produces intents with reason codes, categories, and optional debounce windows. Only valid patient IDs pass through; intents capture contextual metadata for audit.
3. **Task Creation & Idempotency** — Intents convert to `TaskCreated` envelopes via `buildAutomationTaskCreations`, stamping correlation IDs and timestamps. Publishing reuses `publishAutomationTasks`, which applies guarded retries, audit fan-out (`automation.task.created`), and idempotency via per-task keys. Duplicate publishes short-circuit without re-enqueuing tasks.
4. **Debounce & Backpressure** — Each intent may specify `debounceWindowSeconds`; the state machine derives a publish key incorporating rule name, patient, and category so repeated triggers within the window skip execution. Automation publishing honours the same processing limiter as referrals to avoid starving ack flows.
5. **Audit & Observability** — Automation outputs log rule names, categories, debounce decisions, and emit metrics for `automation.tasks.created_total` plus latency histograms. Audit entries include reason/context for compliance and operator replay.
6. **Reconfiguration Safety** — Config reloads happen via environment/file changes; malformed configs fall back to previous valid rules (or empty set) while logging validation errors. This allows safe rule experimentation without redeploying the service.

## Consequences

- Product teams can extend automation by editing JSON rules rather than code, provided they keep names unique and include clear reasons.
- Debounce windows prevent runaway task creation when upstream systems flap; however, operators must monitor metrics to adjust windows when throughput requirements change.
- Idempotency keys require a durable store; environments without one risk duplicate tasks on retries or replays.
- Automation now participates in DLQ/audit flows: if publishing fails, tasks and audit entries land in DLQ for later replay, maintaining traceability.
- Documentation and test fixtures must be updated whenever rule schema changes or new automation categories are introduced.
