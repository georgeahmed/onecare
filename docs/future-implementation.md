# Future Implementation Notes

Short-term follow-ups discovered while wiring early triage functionality:

- **Portal→triage automation hardening**  
  - Promote the new QA harness into CI once the triage worker service is containerised; ensure it runs against NATS + triage app instead of the in-test memory shim.  
  - Extend the scenario coverage to include audit ledger persistence, task idempotency collisions, and DLQ assertions once bus failover paths are ready.

- **Booking automation hardening**  
  - Elevate the booking E2E harness to cover real FHIR write-back and queue notifications once the booking service wiring is complete; ensure conflicts trigger slot refreshes against the integrated GP Connect sandbox.  
  - Capture metrics and DLQ expectations around appointment creation failures so the harness can assert retries, backoff, and audit trails when live adapters replace the in-memory stubs.

- **Duplicate submission handling**  
  - Implement a concrete `handleDuplicate` pipeline for triage: locate the prior task, append the new narrative/attachments, emit an audit event (`audit.event`) and metrics, and optionally notify the frontend.  
  - Decide where the triage workflow is orchestrated (state machine runner, message consumer) so the handler can be injected with access to the bus, FHIR repo, and audit ledger.

- **Feature extraction into Intake state**  
  - Provide the real feature vector (acuity, risk, complexity, time, capacity) before entering `IntakeState`; today the context expects `ctx.features` but nothing populates it.
  - Replace the JSONL writer in `scripts/feature_backfill.js` with the production feature store client once the ingestion/backfill pipelines are provisioned (DE-02.3+).

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

- **Telephony emergency transfer workflow**  
  - Replace the emergency transfer stub with the production handler, wire the prompts into the IVR adapter, and integrate the downstream routing once the call-handling stack is ready.

- **Portal end-to-end QA**  
  - With automated Playwright coverage in place, keep the manual `/safety-check` regression on the checklist and run it once the backend flows stabilise before release.
  - Enable the Playwright scaffold (`PORTAL_E2E_ENABLE=true`) and execute `npm --workspace @onecare/app-portal run test:e2e` against the running orchestrator to validate localized decision and retry flows prior to launch.
- **Booking API parity**  
  - Replace the portal’s in-browser demo booking flow with the production API once endpoints are stable. The confirm step already generates idempotency keys and correlation headers; wire this through the real booking confirmation endpoint and capture the server’s response details (appointment id, correlation id) for audit/logging parity.
  - Manually exercise the booking confirmation UX against real responses (`npm run dev`) by forcing 409/429/503 paths to verify the new copy, countdown timers, and focus management work with live headers.

Document owners: backend triage team. Update or prune these items as the surrounding work lands.
