DLQ Runbook (Broker Dead Letter Queue)

Purpose
- Provide a safe and repeatable procedure to inspect, triage, and replay failed messages from `broker.dlq`.

DLQ Event Contract
- Schema: `schemas/common/dlq-event.json` (DlqEvent)
- Fields:
  - `originalTopic`: topic to which the original publish was intended
  - `correlationId`: for tracing the flow
  - `errorCode`/`errorMessage`: summary of failure
  - `payloadRef`: reference or safe context (no PHI)
  - `ts`: ISO timestamp when DLQ entry was produced

Operator Workflow
- Inspect: query broker DLQ subject/stream for recent events.
- Classify: identify transient vs. poison messages using `errorCode` and frequency.
- Remediate:
  - For transient/system issues: resolve dependency, then replay.
  - For poison messages: correct upstream producer or adjust contracts; do not requeue blindly.
- Replay: use a tooling script to republish a DlqEvent’s `payloadRef` (or fetch the original payload) to `originalTopic` with a new `correlationId` suffix (e.g., `:replay`).
  - Example utility: `apps/ics-hub/src/dev/replay.ts` demonstrates a simple replay.
- Verify: monitor metrics/logs for successful handling and absence of duplicates.

Guidelines
- Keep DLQ payloads minimal; prefer references/IDs, not PHI.
- Ensure idempotency keys at consumers to avoid duplicate side effects on replay.
- Alert thresholds: set alerts on DLQ depth, spikes, and repeat offenders by `originalTopic` and `errorCode`.

