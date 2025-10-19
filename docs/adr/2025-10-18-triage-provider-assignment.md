# ADR 2025-10-18 — Triage Provider Assignment

| Status | Accepted |
|--------|----------|
| Date   | 2025-10-18 |

## Context

After triage scoring we optionally recommend or auto-assign a provider. The assignment policy must balance availability, workload, continuity, fairness, and backpressure constraints without embedding PHI in events/logs.

## Decision

1. **Weighted multi-factor ranking**
   - `assignProvider` receives a list of provider candidates with normalised attributes (availability, workload, continuity, resolution rate, distance, fairness).
   - Weighted scoring uses practice-configured weights (`provider_assignment.weights`), with workload/distance inverted to reward spare capacity and proximity.
   - Continuity boost (`continuityProviderId`) adds a small preference when the patient has a historical relationship.

2. **Fairness and backpressure**
   - Providers exceeding the configured fairness share (`provider_assignment.fairness.max_share`) receive a penalty reason (`fairness_floor_hit`).
   - Candidate-specific backpressure flags (`queueDepth`, `rejectUntil`, `capacityScore`) down-rank or temporarily block providers to avoid hot spots.
   - Reasons (`rule:` slugs) accompany the ranking so downstream audit tools can explain assignments.

3. **Consent and queue notifications**
   - Before persisting and publishing recommendations, we consult an optional `AssignmentConsentEvaluator`. Denials generate audit events (`triage.assignment.denied`) and halt processing.
   - Queue notifications and logs use hashed task/patient references only (`safeTaskReference`, `safePatientReference`).

4. **Outputs**
   - Assignment metadata is *not* emitted in `tasks.created`—only stored in the decision context for follow-up services. Downstream systems load richer context via FHIR using the created task ID.

5. **Observability**
   - Metrics: `triage.assignment.selected/rejected`, `triage.assignment.rank_position`.
   - Logs: include `component: 'triage'` and hashed references only.
   - Tests: `apps/triage/test/providerAssign.test.ts` and `apps/triage/test/assigner.backpressure.test.ts` cover ranking, fairness, and backpressure.

## Consequences

- Provider selection remains deterministic for a given input; auditing is enabled through reason codes and hashed IDs.
- Because no provider identifiers are emitted on the bus, consumers that require the final assignee must fetch the Task from FHIR (which contains the owner reference).
- Consent denials may reduce automation and surface in audit streams; operational teams need to resolve underlying consent gaps or escalate.
- Future enhancements (e.g. ML-based routing) can plug into the same scoring interface by supplying enriched candidate attributes; weights remain practice-configurable.
