# Authorization Matrix (SEC-01.2)

## Purpose
This document maps ONECARE subject types to the actions and resources they can exercise. It captures the minimum viable authorization (AuthZ) policy, highlights consent dependencies, and lists audit obligations so services can implement consistent checks and evidence trails.

## Scope
- Applies to every service and adapter in this repository.
- Covers human subjects (patients, practitioners) and non-human actors (system/service accounts).
- Applies to HTTP endpoints, background jobs, and event-driven handlers.

## Subject Types
- **Patient** – authenticated citizen accessing the portal or telephony intake on their own behalf or with proxy authority recorded in FHIR `Consent`.
- **Practitioner** – authenticated clinical staff (GP, ANP, pharmacist) or care coordinator acting with role-based permissions gated by practice policy.
- **System** – automation or integration accounts (e.g., ICS hub, external booking, ML services) operating under scoped API keys or mutual TLS identities.

## Actions
- **Submit** – originate a new payload into the platform (intake form, referral, document upload).
- **Read** – retrieve persisted data (FHIR resources, task status, audit extracts).
- **Write** – mutate existing data (update encounter tasks, add clinical note, approve scribe output).
- **Route** – direct a payload to a downstream queue/topic or third-party endpoint.

## High-Level Matrix

| Subject \\ Action | Submit | Read | Write | Route | Consent Notes | Audit Expectations |
| --- | --- | --- | --- | --- | --- | --- |
| Patient | Intake narratives, attachments, symptom updates. No downstream routing. | Own submissions, clinician responses, released documents. | Restricted to retracting/annotating own submissions before triage lock; cannot alter clinical notes. | Not permitted. | Require `Consent.provision` for proxy submissions; emergency override requires explicit reason code. | Log submission ID, channel, consent reference, correlation ID. Capture any edits with before/after snapshot. |
| Practitioner | Tasks, triage outcomes, referrals, appointment offers. | All patient data within assigned panel/practice. | Update triage outcomes, add notes, issue bookings, approve scribe drafts. | Route to care pathways (e.g., pharmacy first, secondary care). | Must reference practice policy + patient consent for sensitive domains (mental health, safeguarding); log manual overrides. | Record user ID, role, scope, affected resources, reason code for route/write. Attach correlation IDs for downstream messages. |
| System | Safety gate verdicts, auto-generated follow-ups, integration payloads. | Least-privilege read scopes (e.g., safety gate requires intake context only). | Write limited to automation targets (e.g., update task status, enrich metadata). | Route only to whitelisted topics per integration contract. | Operate under data processing agreements; require explicit consent mapping in config per integration. | Emit machine identity, scope, client cert fingerprint (if mTLS). Record success/failure and retries for idempotency evidence. |

## Resource-Level Permissions

### Intake & Triage (`ingest.*`, `triage.*`)

| Resource | Patient | Practitioner | System |
| --- | --- | --- | --- |
| `TriageSubmission` | Submit new cases within core + OOH policy; read status; edit symptom narrative until `triage.lockedAt`; no routing. | Read all submissions for assigned practice; write triage decisions and priority; route to next queue (`triage.routed`). | Submit safety gate annotations; write risk scores; route red-flag cases to `triage.emergency` when thresholds met. |
| `Attachment` (`DocumentReference/Binary`) | Upload during submission (virus scanned); read own attachments. | Read attachments tied to assigned case; write clinician annotations; may flag for deletion -> handled by retention policy. | Tag metadata (e.g., OCR results); no direct patient-visible edits. |

Consent: Patient must accept terms per submission; proxy requires `Consent.performer`. Emergency override (clinician forcing triage lock) must record justification.  
Audit: Capture submit channel, device fingerprint (if available), correlation ID, and any risk score changes with model version.

### Clinical Records (`Encounter`, `Observation`, `CarePlan`, `Task`)

| Resource | Patient | Practitioner | System |
| --- | --- | --- | --- |
| `Encounter` / `Task` | Read status once clinician marks `shared=true`; no write/route. | Submit encounter summaries, update tasks, route to follow-up queues. | Update task metadata (e.g., SLA timer) inside configured scope; route escalation when timers breach. |
| `Observation` / `CarePlan` | Read clinician-approved entries; cannot edit. | Write new observations derived from triage; attach care plans; route to external partners via governed integrations. | Write derived metrics (e.g., acuity score) scoped to automation project; read limited fields required for model inference. |

Consent: Sharing with patient requires `Consent.provision.type=permit`. External routing demands integration-specific consent flagged in config.  
Audit: Clinician writes must log reason, origin service, and link to patient request. Automation writes require model/version identifiers and confidence scores.

### Scheduling & Referrals (`booking.*`, `referral.*`)

| Resource | Patient | Practitioner | System |
| --- | --- | --- | --- |
| `AppointmentRequest` | Submit preferred slots; read booking status; cannot directly write final booking. | Write confirmed bookings, modify slot assignments, route to PCN/GP Connect connectors. | Sync slot availability from external systems; route cancellations/updates downstream. |
| `ReferralRequest` | Submit pharmacy preferences if enabled; otherwise view status only. | Create and route official referrals; update status. | Push referral acknowledgements from external systems; enforce status transitions. |

Consent: Appointment sharing defaults to implied consent; referrals to third parties require explicit consent capture and ability to revoke.  
Audit: Record slot identifiers, practitioner ID approving booking, external system IDs, and correlation IDs for each routed referral message.

### Communications & Notifications (`communication.*`)

| Resource | Patient | Practitioner | System |
| --- | --- | --- | --- |
| `Communication` thread | Submit replies to clinician prompts; read entire thread; cannot delete. | Initiate threads, mark as read/unread, route to team inboxes. | Generate automated reminders; route notifications to SMS/email providers (subject to contract). |

Consent: Opt-in required for SMS/email per patient preference; maintain unsubscribe ledger.  
Audit: Log content metadata (not body), delivery outcome, correlation IDs, and notification provider response codes.

## Consent Requirements
- Maintain FHIR `Consent` resources per patient with purpose-of-use scopes (`care`, `pharmacy-first`, `analytics-lite`). Services must enforce granular checks before reading or routing sensitive data.
- Proxy access requires `Consent.performer` linking the proxy to the patient; revoke access within 24 hours of consent withdrawal.
- Emergency overrides (break-glass) demand double acknowledgement, justification text, and generate high-priority audit events routed to `audit.breakglass`.
- Integration/system accounts must map to contractual consent artifacts (e.g., DPA, DPIA references) stored in `config/privacy/*.yaml`; deployments should fail if mapping is missing.

## Audit Expectations
- Emit structured `AuditEvent` entries for every privileged `write` or `route`, containing subject, action, resource reference, timestamp, correlation ID, and success/failure outcome.
- Store audit logs in WORM storage with retention ≥ policy (`config/privacy.retention_days`), with hourly replication checks.
- Surface tamper-evident hashes for external regulators; hash should include payload fingerprint, actor identity, and consent reference.
- Alert on anomalous patterns (e.g., practitioner reading >50 patient records/hour) via `analytics.audit-signal`.
- Ensure idempotency keys are logged for system-originated writes/routes to prove retry safety.

## Implementation Checklist
- Enforce least-privilege scopes in `@onecare/authz` middleware or adapter configuration.
- Propagate `x-correlation-id` across services and include in audit entries.
- Validate consent before reading sensitive resources or emitting outbound routes.
- Keep this matrix in sync with `infra/event-bus/subjects-acls.md` and service-specific README files.

## Review Cadence
- Security engineering owns this document.
- Review quarterly or when a new subject type, action, or integration is introduced.

