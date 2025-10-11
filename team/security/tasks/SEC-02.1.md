Navigation: [Task Index](../../../docs/TASK_INDEX.md) | [All Tasks Flow](../../all-tasks-flow.md) | [Prev](SEC-01.2.md) | [Next](SEC-02.10.md)

Task: SEC-02.1 — Threat model & data flow (STRIDE)

Context
- Establish an initial threat model and data flow diagrams to identify risks and mitigations across portal, telephony, orchestrator, ML services, and external deps.

Files
- docs/security/THREAT_MODEL.md (new)
- docs/security/DFD.png (new placeholder)

Steps
1) Create a high-level DFD: actors, ingress points, bus, services, data stores (FHIR/object/feature), and external systems (GP Connect, CPCS).
2) Run STRIDE against components/flows; list threats and mitigations (authn/z, consent, SSRF, mTLS, idempotency, DLQ, privacy minimization).
3) Prioritize findings by risk; open follow-up tasks where needed (link to SRE/Backend tickets).

Acceptance Criteria
- DFD and STRIDE notes published; prioritized mitigations list; cross-links to owners.

Validate
- Team review session; incorporate feedback; store revision date.

Status Update
- make engineer-done ENGINEER=security/engineer-01 TASK='SEC-02.1' && make team-status-write

