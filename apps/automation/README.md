Automation Service
==================

Purpose
-------
- Drive follow-up actions (recalls, repeats, documentation reviews, custom workflows) based on referral/task signals.
- Sits alongside ICS Hub: ICS raises automation trigger events, this service evaluates rules and publishes downstream tasks/audit events.

Runtime Architecture
--------------------
- Ingress: `Topics.ics.automationTrigger` (typed envelope mirroring `AutomationTriggerEvent` in `apps/ics-hub/src/application/automation.rules.ts`). ICS Hub currently invokes the same evaluation pipeline inline; this service will host it independently when decoupled.
- Processing steps:
  1. Validate the trigger envelope (schema: `schemas/automation/automation-trigger.json`, TODO when promoted to standalone service).
  2. Load automation rules from configuration (`ICS_AUTOMATION_TRIGGERS` env string or `ICS_AUTOMATION_TRIGGERS_FILE`).
  3. Evaluate rules via `evaluateAutomationTriggers` → generate intents with reasons, context, and optional debounce windows.
  4. Convert intents to `TaskCreated` payloads using `buildAutomationTaskCreations`, stamping correlation IDs and timestamps.
  5. Publish created tasks on `Topics.tasks.created`, mirror audit events on `Topics.audit.event`, and emit metrics.
- Outbound: guarded bus publisher (timeouts, retries, DLQ fallback) identical to `apps/ics-hub/src/adapters/bus.adapter.ts`.

Configuration
-------------
- `ICS_AUTOMATION_TRIGGERS` / `ICS_AUTOMATION_TRIGGERS_FILE` — JSON document describing rules, reasons, debounce, and templates.
- `AUTOMATION_MAX_CONCURRENCY` — worker pool size (defaults to `8` when service splits out).
- `AUTOMATION_DEBOUNCE_STORE_URL` — backing store for debounce/idempotency keys (Redis or equivalent).
- `AUTOMATION_TASK_PUBLISH_TIMEOUT_MS`, `AUTOMATION_TASK_PUBLISH_RETRIES`, `AUTOMATION_TASK_PUBLISH_BACKOFF_MS` — bus guard knobs.
- `AUTOMATION_AUDIT_EVENT_TYPE` — audit type string (defaults to `automation.task.created`).

Debounce & Idempotency
----------------------
- Keys combine rule name, patient fingerprint, category, and correlation ID. Execution occurs inside `executeWithIdempotency` so duplicate triggers short-circuit.
- Debounce windows (seconds) per rule ensure noisy upstream systems do not flood downstream task queues.
- A dedicated debounce store retains expiry timestamps; entries expire automatically to allow future triggers once windows lapse.

Observability & Operations
--------------------------
- Metrics: `automation.tasks.created_total`, `automation.tasks.debounced_total`, `automation.publish.error_total`, `automation.publish.dlq_total`, and latency histograms (`automation.evaluate.latency_ms`, `automation.publish.latency_ms`).
- Logs capture rule name, reason, debounce decision, and correlation IDs. Audit events record the same metadata for compliance.
- DLQ payloads summarise the original trigger + failure reason and can be replayed via the shared replay tooling (`apps/ics-hub/src/dev/replay.ts` today).
- Readiness gating: service fails readiness if trigger config fails validation or debounce store becomes unavailable.

Local Workflow
--------------
```
# Install dependencies (shared workspace)
npm install

# Run automation-focused tests (ICS Hub currently hosts them)
npm run test -- apps/ics-hub/test/automation.state.test.ts
```

References
----------
- ADR `docs/adr/2025-10-20-automation-design.md` — rules engine decisions, debounce, idempotency.
- ADR `docs/adr/2025-10-20-ics-routing.md` — how automation integrates with ICS routing/acks.
- Source of truth: `apps/ics-hub/src/application/automation.rules.ts` (shared until standalone service extraction).
