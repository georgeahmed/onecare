Triage Service
=============

The triage service consumes `triage.input` envelopes from the event bus, scores each submission, deduplicates near-identical narratives, enforces consent, and emits minimal `triage.decision` plus `tasks.created` events. A background scheduler escalates outstanding tasks and publishes `tasks.updated` when SLA thresholds are breached. All payloads and logs are PHI-safe (hashed references only).

## Architecture at a Glance

```
triage.input (TypedEnvelope<TriageInput>)
      │
      ▼
Intake ──► Scored ──► TaskCreated ──► Notified ──► Completed
  │          │             │             │
  │          │             │             └─ queue notifier (optional)
  │          │             └─ publish triage.decision / tasks.created
  │          └─ scoring & consent guardrails
  └─ dedup similarity (patient+window)
```

- **Consumer:** `TriageConsumer` (event-driven; no HTTP ingress). Consumes `Topics.triage.input`.
- **Runtime:** `startTriageRuntime` exposes `/healthz` and `/readyz`, manages graceful shutdown, wires the consumer and SLA scheduler.
- **Scheduler:** `TriageSlaScheduler` escalates priorities and emits `tasks.updated`/audit events when deadlines are breached.
- **Ports:** FHIR repository (create/update Task), bus, optional queue notifier, optional consent evaluator, optional feature store.

Further design rationale is captured in ADRs:

- `docs/adr/2025-10-18-triage-scoring-and-prioritization.md`
- `docs/adr/2025-10-18-triage-dedup-similarity.md`
- `docs/adr/2025-10-18-triage-provider-assignment.md`

## Runtime & Operations

| Endpoint | Description | Notes |
|----------|-------------|-------|
| `GET /healthz` | Liveness probe | Always returns `200 { "ok": true }`. |
| `GET /readyz` | Readiness probe | Returns 200 when the bus is connected, the FHIR repo responds within `TRIAGE_FHIR_PROBE_TIMEOUT_MS`, and `TriageSlaScheduler.getPendingCount()` is below `TRIAGE_READY_MAX_PENDING`. |

Environment knobs:

| Variable | Default | Purpose |
|----------|---------|---------|
| `TRIAGE_PORT` | 7300 | HTTP listener (set `0` for ephemeral in tests). |
| `TRIAGE_READINESS_CACHE_MS` | 1 000 | `/readyz` cache TTL (min 250 ms). |
| `TRIAGE_READY_MAX_PENDING` | 500 | Maximum SLA backlog before readiness flips to 503. |
| `TRIAGE_FHIR_PROBE_TIMEOUT_MS` | 750 | Metadata probe timeout. |
| `TRIAGE_SHUTDOWN_GRACE_MS` | 10 000 | Max graceful shutdown window. |

Graceful shutdown sequence:
1. Mark readiness false.
2. Stop consuming new messages.
3. Drain SLA scheduler and queue notifier work.
4. Close HTTP server (bounded by `TRIAGE_SHUTDOWN_GRACE_MS`).

## Events

### Consumed

Topic: `Topics.triage.input`  
Schema: `schemas/triage/triage-input.json`

```json
{
  "id": "7b7f5d1f-9c47-4ef1-8b16-88a7c77b9647",
  "topic": "triage.input",
  "timestamp": "2025-10-18T12:03:00.000Z",
  "correlationId": "corr-123",
  "payload": {
    "patientId": "patient-123",
    "narrative": "Persistent chest pain with dizziness.",
    "features": {
      "acuity": 0.92,
      "risk": 0.55,
      "time": 0.4
    }
  }
}
```

### Published

Topic: `Topics.triage.decision`  
Schema: `schemas/triage/triage-decision.json` (PHI-safe)

```json
{
  "id": "0ff2e54d-6569-4e82-80d5-7edbc4fc3863",
  "topic": "triage.decision",
  "timestamp": "2025-10-18T12:03:02.000Z",
  "correlationId": "corr-123",
  "payload": {
    "patientId": "patient-123",
    "score": 0.94,
    "priority": "STAT",
    "reasons": ["rule:red_flag:chest_pain", "rule:fallback:delta_exceeded"]
  }
}
```

Topic: `Topics.tasks.created` (`schemas/tasks/task-created.json`)

```json
{
  "id": "fc8d3589-44c9-432e-889e-9f5cd5326abc",
  "topic": "tasks.created",
  "timestamp": "2025-10-18T12:03:02.010Z",
  "correlationId": "corr-123",
  "payload": {
    "taskId": "task-787887",
    "patientId": "patient-123",
    "priority": "STAT"
  }
}
```

Topic: `Topics.tasks.updated` (`schemas/tasks/task-updated.json`) – emitted by the SLA scheduler.

```json
{
  "id": "802b4ea2-565f-4be0-86ce-99e9c2df8a16",
  "topic": "tasks.updated",
  "timestamp": "2025-10-18T12:17:02.010Z",
  "correlationId": "corr-123",
  "payload": {
    "taskId": "task-787887",
    "patientId": "patient-123",
    "priority": "STAT",
    "previousPriority": "URGENT",
    "reason": "sla_escalation",
    "breached": true,
    "updatedAt": "2025-10-18T12:17:02.010Z"
  }
}
```

DLQ: poison messages land on `Topics.broker.deadLetter` using the shared `DlqEvent` contract. Payloads contain correlation ID, error code, envelope ID, and timestamp only.

## Configuration Cheat Sheet

| Key | Location | Description |
|-----|----------|-------------|
| `triage.score_weights` | `config/nhs_gp_defaults.yaml` + practice overrides | Weights applied by `computeTriageScore`. |
| `triage.score_calibration` | same | Linear calibration + clamp bounds. |
| `triage.dedup_window` / `triage.sim_threshold` | same | Sliding window + similarity thresholds for duplicate detection. |
| `triage.priority_tiebreaker` | same | Epsilon/acuity bump when scores are near thresholds. |
| `triage.aging_interval` | same | Scheduler cadence (ISO-8601 duration). |
| `sla_targets.*` | same | Escalation thresholds (ISO-8601 duration). |
| `red_flag_set` | practice-specific | Narrative red flags used by fallback scoring. |
| `triageFallback` | optional override | Enables deterministic scoring fallback (tolerance/time budget). |

## Error Handling & Consent

- FHIR errors get mapped to typed codes (`conflict`, `invalid_fhir`, `upstream_timeout`, …) and surfaced in logs/metrics only with hashed references.
- Consent is checked before provider assignment; denial emits an audit event (`Topics.audit.event`) and short-circuits processing.
- Consumers retry transient failures (backoff + jitter, max 3 attempts) and route non-retryable envelopes to DLQ.

## Observability

- Metrics: `triage.consume.*`, `triage.score.*`, `triage.notify.*`, `triage.sla.*`, `triage.retry`, `triage.dlq`, `triage.pipeline.duration_ms`.
- Logs include `component: 'triage'` and hashed `patientRef` / `taskRef`.
- Tracing: spans around task creation (`triage.task.create`) and queue notifications.

## Local Development

```bash
# Run the runtime with in-memory bus & mock FHIR:
node -e "
  const { startTriageRuntime } = require('./dist/index.js');
  const { MemoryBus } = require('@onecare/bus');
  const bus = new MemoryBus();
  // Minimal FHIR stub
  const fhir = {
    createTask: async () => ({ id: 'task-local', resourceType: 'Task' }),
    updateTask: async () => undefined,
    readResource: async () => ({ resourceType: 'CapabilityStatement' }),
  };
  startTriageRuntime({
    config: require('../../config/nhs_gp_defaults.json'), // use precompiled JSON or load via @onecare/config
    fhirRepository: fhir,
    bus,
    queueNotifier: { notify: async () => undefined },
    ingressIdempotencyStore: {
      exists: async () => false,
      put: async () => undefined,
      reserve: async () => 'reserved',
    },
  });
"
```

Publish a sample envelope:

```bash
node scripts/dev/publish-triage-input.js <<'JSON'
{
  "patientId": "patient-123",
  "narrative": "Shortness of breath, persistent chest pain.",
  "features": {
    "acuity": 0.95,
    "risk": 0.6,
    "time": 0.5
  }
}
JSON
```

## Testing & Benchmarks

- Unit tests: `npm run test -- --run apps/triage/test/*.test.ts`
- Runtime probes: `apps/triage/test/runtime.test.ts`
- Performance guardrails: `apps/triage/test/performance.test.ts`
- Bench harness: `apps/triage/scripts/triage-bench.js`

Re-run benchmarks after significant scoring/dedup changes and update the results above. Ensure p95 stays well within the triage latency SLO (≤ 1.5 s).```
