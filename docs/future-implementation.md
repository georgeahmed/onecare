# Future Implementation Notes

Short-term follow-ups discovered while wiring early triage functionality:

- **Duplicate submission handling**  
  - Implement a concrete `handleDuplicate` pipeline for triage: locate the prior task, append the new narrative/attachments, emit an audit event (`audit.event`) and metrics, and optionally notify the frontend.  
  - Decide where the triage workflow is orchestrated (state machine runner, message consumer) so the handler can be injected with access to the bus, FHIR repo, and audit ledger.

- **Feature extraction into Intake state**  
  - Provide the real feature vector (acuity, risk, complexity, time, capacity) before entering `IntakeState`; today the context expects `ctx.features` but nothing populates it.

- **Task enrichment & notifications**  
  - Extend the triage Task creation flow with richer payload (category, owner assignment provenance, attachments) and downstream notifications once provider assignment logic lands.

Document owners: backend triage team. Update or prune these items as the surrounding work lands.
