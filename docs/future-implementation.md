# Future Implementation Notes

Short-term follow-ups discovered while wiring early triage functionality:

- **Duplicate submission handling**  
  - Implement a concrete `handleDuplicate` pipeline for triage: locate the prior task, append the new narrative/attachments, emit an audit event (`audit.event`) and metrics, and optionally notify the frontend.  
  - Decide where the triage workflow is orchestrated (state machine runner, message consumer) so the handler can be injected with access to the bus, FHIR repo, and audit ledger.

- **Feature extraction into Intake state**  
  - Provide the real feature vector (acuity, risk, complexity, time, capacity) before entering `IntakeState`; today the context expects `ctx.features` but nothing populates it.

- **Task enrichment & notifications**  
  - Extend the triage Task creation flow with richer payload (category, owner assignment provenance, attachments) and downstream notifications once provider assignment logic lands.

- **Booking write-back & notifications**  
  - Flesh out `WrittenBackState`/`ConfirmedState` in the booking state machine to persist GP Connect confirmations, emit booking events/notifications, and handle failure paths once downstream contracts are defined.
  - Add retention/cleanup strategy for rejected slots and audit trails (e.g., fairness rejections) once booking telemetry requirements are clarified.

- **Booking search organisation routing**  
  - Replace the temporary `demo-org` fallback with real organisation/location mapping once routing metadata is available from config or FHIR references.

- **GP Connect client HTTP implementation**  
  - Replace the stubbed `GpConnectHttpClient` with a real HTTPS client that supports mTLS/OAuth, propagates correlation IDs, and redacts secrets in logs once upstream connector details are available.

- **Booking runtime wiring**  
  - Ensure the booking service container injects a real `MessageBus` into the state context so `BookedState` can publish `booking.appointment.created` envelopes without tripping the `bus_missing` guard.

- **CPCS HTTP implementation**  
  - Replace the stub dispatcher in `CpcsHttpClient` with a resilient HTTPS client (timeouts, retries, circuit breaker, metrics) and ensure secrets are sourced from secure stores.
  - Generate the CPCS `ServiceRequest` payload from real patient/doc data (FHIR templates, metadata enrichment) and persist referral outcomes/audit trails in the repository once the ports are ready.

- **Billing service integration**  
  - Implement the real billing HTTP workflow (claim payload mapping, response reconciliation, TLS client wiring) and replace stub dispatchers once the external API contract is finalised.

Document owners: backend triage team. Update or prune these items as the surrounding work lands.
