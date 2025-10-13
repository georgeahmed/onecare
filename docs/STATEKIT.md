State-Class Pattern (Statekit)

Purpose
- Provide a small, consistent way to model service flows as states and transitions.

Concepts
- State: named, handles an input event in context, yields next state.
- Context: mutable per-request context (ids, FHIR refs, routing decisions).
- Event: typed trigger (ingress message, timer, adapter callback).
- Machine: orchestrates transitions and lifecycle hooks.

Mapping to Algorithm.md
- Orchestrator: Received → Authorized → ConsentChecked → Normalized → Validated → Persisted → Enriched → Routed → Audited.
- Triage: Intake → Scored → TaskCreated → Notified → Completed.
- Booking: Search → Selected → Booked → WrittenBack → Confirmed.
- Pharmacy Router: Classified → Eligible → Referred → OutcomeRecorded.
- Capacity: Telemetry → Forecast → Shaped → Applied.
- Access Gate: HoursChecked → PortalStateEnsured; SafetyGate: Analyzed → Diverted|Proceed.

Notes
- Keep states small and testable; use adapters for I/O.
- Emit metrics and audit in state transitions, not in adapters.

