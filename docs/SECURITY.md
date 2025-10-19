# Security

This repository handles clinical workflows and is expected to protect PHI/PII at all times. Secrets must never be committed to git or shared outside of approved tooling. This document captures the baseline for storing, rotating, and validating secrets across environments.

Related documents:
- `docs/security/THREAT_MODEL.md` — system threat model & STRIDE findings.
- `docs/security/DATA_CLASSIFICATION.md` — data classes, retention, enforcement.
- `docs/security/TLS_POLICY.md` — TLS/mTLS requirements & rotation.
- `docs/security/OIDC_JWT_HARDENING.md` — JWT verification guidance.
- `docs/security/DPIA_TEMPLATE.md`, `docs/security/PRIVACY_CHECKLIST.md` — privacy review artefacts.
- `docs/security/SECRETS_POLICY.md` — detailed secret taxonomy, storage, and rotation SLAs.
- `docs/security/APPLICATION_SECURITY.md` — SAST/DAST pipelines and escalation process.
- `docs/security/CODE_SCANNING.md` — Semgrep/CodeQL ruleset and severity gates.
- `docs/security/VULN_MANAGEMENT.md` — vulnerability intake, severity matrix, and SLAs.
- `docs/security/ACCESS_REVIEWS.md` — quarterly access review procedure.
- `docs/security/INCIDENT_RESPONSE.md` — incident response plan and drill cadence.
- `docs/security/AUDIT_POLICY.md` — mandatory audit events and retention.
- `docs/security/SUPPLY_CHAIN.md` — SBOM, signing, and admission policy.
- `docs/security/EGRESS_SSRF_POLICY.md` — outbound allowlists and SSRF guardrails.
- `docs/security/APP_FUZZING.md` — fuzzing and ZAP testing guidance.
- `docs/security/WAF_POLICY.md` — ingress protections and rate limits.
- `docs/security/DEPENDENCY_POLICY.md` — dependency update automation.
- `docs/security/SECRETS_PREVENTION.md` — git hooks and secret scanning.
- `docs/security/VENDOR_RISK.md` — third-party risk assessments.
- `docs/security/TRAINING.md` — security/privacy training program.
- `docs/security/COMPLIANCE_MAP.md` — control mapping to DSPT/DCB standards.

## Secrets management baseline

### Storage and access

- **Vault** is the source of truth for credentials. Use the shared instance at `https://vault.onecare.local` (dev/staging) and the production endpoint published by infra. Paths follow `kv/{domain}/{service}/...`.
- Secrets are namespaced per environment. Never reuse production credentials in lower environments.
- Do not commit `.env` files. `.env.example` lists required variables; populate local values via `vault kv get` and write them to a private `.env.local`.

| Secret family       | Vault path (dev)                 | Rotation owner       |
|---------------------|----------------------------------|----------------------|
| Messaging (NATS)    | `kv/platform/nats/orchestrator`  | DevOps SRE           |
| FHIR API clients    | `kv/health/fhir/orchestrator`    | Integrations + SRE   |
| OTEL exporter keys  | `kv/observability/otel/collector`| DevOps SRE           |

Access to the above paths is gated by Vault policies and audited. Request access via the security queue and include purpose + duration.

### Rotation policy

- **NATS credentials**: rotate every 30 days and immediately when personnel changes occur. Update `.env.local`, Kubernetes secrets, and CI variables in the same change window.
- **FHIR system tokens & client secrets**: rotate every 60 days or upon upstream notice. Validate that downstream services receive new credentials before revoking the old ones.
- **OTEL exporter API keys / headers**: rotate every 90 days, or sooner if scope changes (new datasets, exporters).
- Maintain dual credentials during rotation where the provider supports it (e.g., generate a new token, deploy, then revoke the old token).
- Record rotation events in the security runbook with timestamp, operator, and affected services.

### Deployment integration

- Kubernetes workloads pull secrets via Vault Agent sidecars. Manifests under `infra/secrets/vault-agent-config.hcl` and the `vault-agent` Kustomize patch illustrate how to mount templated secrets into pods.
- Long-lived Kubernetes secrets are stored as sealed secrets. Example manifests (`infra/secrets/sealedsecret-example.yaml`) show how to encrypt Vault-issued bootstrap tokens before committing to git.
- GitOps flow:
  1. Create or rotate secret in Vault.
  2. Render sealed secret with `kubeseal` (using the environment public key) and commit/update it under `infra/secrets/`.
  3. CI/CD applies the manifest; Vault Agent retrieves the live secret at runtime.
- For local development, use `vault kv get -field=value <path>` to populate `.env.local`. `scripts/ops/vault-login.sh` (planned) will automate short-lived tokens; until then, rely on manual `vault login`.

### Rotation runbook

- The canonical rotation workflow lives in `docs/runbooks/secret-rotation.md`. It covers staging rehearsal, validation, rollback, and audit logging.
- Always rehearse rotations in staging before touching production. Use sealed secrets with short TTL bootstrap tokens to avoid leaking credentials.
- Post-rotation, verify application readiness probes and targeted smoke tests; only after success should the old version be revoked.
- Comprehensive guidance (taxonomy, SLAs, verification) is available in `docs/security/SECRETS_POLICY.md`.

### Developer workflow

1. Copy `.env.example` to `.env.local`; fill placeholders using Vault values. Never commit populated files.
2. Keep secrets in password managers (1Password) when they must be shared temporarily; delete once Vault entries are confirmed.
3. For local automation, prefer `direnv` or project-specific scripts that read from Vault. Avoid storing credentials in shell history; use `read -s` or environment injection helpers.

### Pre-commit & scanning guidance

- Install [`pre-commit`](https://pre-commit.com/) (e.g., `pipx install pre-commit` or `brew install pre-commit`).
- Add the gitleaks hook to `.pre-commit-config.yaml`:

  ```yaml
  repos:
    - repo: https://github.com/gitleaks/gitleaks
      rev: v8.18.1
      hooks:
        - id: gitleaks
          args: ["detect", "--source", ".", "--redact"]
  ```

  After updating the config, run `pre-commit install` to activate the hook.
- Run an ad-hoc scan before opening a PR: `docker run --rm -v "$PWD":/repo gitleaks/gitleaks:latest detect --source /repo --redact`.
- Treat any hit as sensitive until proven otherwise. If you accidentally commit a secret, follow the incident response steps below immediately.

### Incident response for exposed secrets

1. Revoke/rotate the impacted credential via Vault or the upstream provider.
2. Purge the secret from git history following the security team's guidance (BFG or git filter-repo).
3. Notify `#security` with scope, blast radius, and mitigation timeline.
4. Document the incident in the security log and confirm monitoring is updated if necessary.

## Dependency & License Scanning

- CI runs `npm audit --audit-level=high`, `pip-audit`, and Trivy (filesystem) in `.github/workflows/ci.yml`; results are evaluated against `config/security/vuln-policy.json` by `scripts/ci/enforce_security_policy.mjs`. Only vulnerabilities added to the allowlist (with justification + `expires`) are tolerated.
- Use `npx license-checker --json` locally before introducing new packages. The allowlist is maintained in `config/security/license-policy.json` (`MIT`, `Apache-2.0`, `BSD-2-Clause`, `BSD-3-Clause`, `ISC`). Add an exception with expiry if you must ship another license.
- When a scan flags an issue, record it in the security backlog with remediation ETA. Block releases if a critical/high advisory lacks an approved (and non-expired) exception.

## Secret Scanning Pipeline

- Gitleaks runs in CI on every push and fails the job for high-confidence findings. The configuration matches `.pre-commit-config.yaml`.
- Install pre-commit hooks (`pre-commit install`) so local diffs are scanned before committing. Use the `--redact` flag when sharing reports.
- If a false positive appears, add the signature to `.gitleaks.toml` with a justification and expiry date.

## Data Retention & Minimization

### Log & Trace Retention

- Retain application logs, request traces, and OTEL export buffers for **14 days** per environment. This window covers incident forensics while capping PHI/PII exposure.
- Store logs in append-only buckets or volumes (`/var/log/onecare/*`, S3 `onecare-logs-<env>`). Redact PHI in the producer; hash identifiers using SHA-256 with environment-specific salts.
- Nightly housekeeping should gzip daily log partitions (e.g., `YYYY/MM/DD/service.log`) so that archives remain immutable.
- The scheduled GitHub workflow `.github/workflows/backup-nightly.yml` backs up JetStream/config snapshots every six hours and appends JSONL audit records for continuity.
- Purging:
  - Run `scripts/ops/purge-logs.sh --root /var/log/onecare --retention-days 14` in **dry-run** mode during change windows to inspect candidates.
  - When satisfied, rerun with `--apply`. The script bundles aged files into a timestamped tarball under `--archive-dir` (defaults to `./archives/logs`) before deletion. Upload archives to cold storage if required by policy, then remove them within 90 days.
  - Record purge batches (timestamp, operator, archive location) in the environment change log.

### DLQ & Event Backlog Retention

- Dead-letter queues (NATS JetStream `broker.dlq.*`) must stay under **30 days** of history. Older messages represent unresolved PHI references and must be replayed or purged.
- Replay DLQ items promptly using the replay tooling (`apps/ics-hub/src/dev/replay.ts`) and record outcomes.
- After successful replay or declaration as non-actionable, run `scripts/ops/purge-dlq.sh --retention-days 30` to archive JSON payloads older than the window and trim the DLQ stream. The script supports dry-run mode, gzips archived payloads, and logs the highest purged sequence.
- When DLQ entries are exported outside the cluster (S3/object storage) ensure the buckets apply server-side encryption and lifecycle rules to expire artefacts within 30 days.

### Minimization Defaults

- Structured logs must omit raw identifiers; prefer hashed patient IDs (`hashIdentifier`) and redact tokens. Use explicit allowlists for fields captured in logs.
- Metrics should rely on tags/labels that are non-sensitive (service, route, status code) and avoid embedding PHI.
- For replay tooling, store only references (`payloadRef`) rather than raw payloads. When storing payload fragments for debugging, scrub PHI and annotate with `sanitized=true`.
- Document any retention exception (service, reason, expiry) in the security backlog and revisit every quarter.

## Network Security Baseline

### Ingress & Certificates

- TLS termination is managed by cert-manager (see `infra/k8s/cert-manager/*`). Install the namespace + issuers (`namespace.yaml`, `clusterissuer-*.yaml`) before deploying ingress resources.
- Public endpoints use Let's Encrypt (`letsencrypt-prod`/`letsencrypt-staging`), while internal service-to-service certificates are issued from `onecare-internal-ca`.
- Ingress definitions (`infra/k8s/ingress/*.yaml`) must:
  - Reference the appropriate `cert-manager.io/cluster-issuer` annotation.
  - Redirect HTTP → HTTPS and set sensible upstream timeouts.
  - Terminate TLS with certificates rotated every 90 days (automated by cert-manager).
- Validate certificate issuance in each environment (`kubectl describe certificate <name>`), and monitor cert-manager events to catch renewal failures.

### Mutual TLS Between Services

- Internal services consume certificates issued by the internal CA (e.g., `infra/k8s/cert-manager/certificate-booking.yaml`). Mount the resulting secret and configure workloads to require TLS when communicating over the service mesh or direct service endpoints.
- Vault Agent or init containers should populate trust bundles (internal CA chain) under `/etc/onecare/pki/ca.crt`. Services must verify peer certificates against this CA.
- Rotate the internal CA every 6 months; cert-manager reissues leaf certificates automatically when the CA secret is updated.

### Egress Controls & Allowlisting

- Apply the namespace-wide deny-by-default policy (`infra/k8s/networkpolicies/egress-deny.yaml`) and ingress deny (`infra/k8s/networkpolicies/ingress-deny.yaml`). Add workload-specific policies (see `egress-allowlist-example.yaml`) granting only the minimum ports/CIDRs.
- For HTTP clients, enforce SSRF mitigations by validating hostnames and IPs against the allowlist before issuing requests (see `apps/orchestrator/src/index.ts`). Document exceptions with owner + expiry in environment runbooks.
- GP Connect (`packages/ports/src/gp-connect.ts`) continues to enforce HTTPS with TLS verification, optional certificate pinning, and header redaction.
- Policy and procedures are detailed in `docs/security/EGRESS_SSRF_POLICY.md`.

### Monitoring & Auditing

- Collect cert-manager metrics (`certmanager_certificate_expiration_timestamp_seconds`) and alert when expiry < 7 days.
- Network policies should be validated via CI (e.g., `kubectl diff`) and periodically smoke-tested with `kubectl exec` to confirm blocked egress destinations.
- Record ingress/egress exceptions in the security backlog and review quarterly as part of the network hardening checklist.

### Container Hardening

- Python ML services (`services-py/safety_gate_service`, `services-py/scribe_service`) use distroless base images with an isolated virtualenv copied from a slim builder. Containers run as UID/GID `65532` (`nonroot`), with no shell or package manager present.
- Kubernetes workloads mount a tmpfs at `/tmp` and enforce:
  - `runAsNonRoot: true`, `readOnlyRootFilesystem: true`
  - `allowPrivilegeEscalation: false`, `capabilities.drop: ["ALL"]`
  - `seccompProfile: { type: RuntimeDefault }`
- GPU variants retain the same securityContext while tolerating the GPU node taint. Any future capability additions require a documented exception tracked in the security backlog with explicit owner + expiry.
- Health checks and application logs only rely on userland tools bundled in the virtualenv; no root filesystem writes occur outside `/tmp`.

## Supply Chain Security

### Image Signing & Verification

- Build pipeline (`.github/workflows/ci.yml`) signs container images with cosign. Signing keys are sourced from Vault via GitHub secrets (`COSIGN_PRIVATE_KEY` + `COSIGN_PASSWORD`).
- Provenance attestations (SLSA v1) are emitted for each image digest and attached to the registry reference.
- Verification: `cosign verify --key env://COSIGN_PUBLIC_KEY $IMAGE` must succeed before promotion. The CD workflow (`.github/workflows/cd.yml`) runs this check automatically for staging and production deployments.
- Rotate signing keys annually or on incident via the secret rotation runbook (`docs/runbooks/secret-rotation.md`). Store the public key in the security repository for downstream verification (OPA/Gatekeeper, admission controllers).

### SBOM & Vulnerability Scanning

- SBOMs (Node + Python) are generated through `scripts/sbom-generate.sh` (CycloneDX JSON by default) and uploaded as CI artefacts. Checksums accompany each SBOM to detect tampering.
- File-system scans (`trivy fs`, `npm audit`, `pip-audit`, license check) feed into `scripts/ci/enforce_security_policy.mjs`, which enforces severity/expiry thresholds defined in `config/security/*`.
- Container image scans use Trivy against the pushed image tags (critical/high severity, `ignore-unfixed=true`). Failures block promotion.
- Store scan reports (`security-reports`, `image-security-reports`) for at least 30 days to support audit trails.

### Deployment Policy

- Admission controllers or GitOps pipelines must verify cosign signatures and reject unsigned images for production namespaces.
- SBOMs are published with each build; downstream services must reference them for license compliance and vulnerability triage.
- For emergency releases, document any temporary policy exceptions (with expiry) in `config/security/vuln-policy.json` and the incident log.
- See `docs/security/SUPPLY_CHAIN.md` for full supply-chain requirements.

## Application Security Testing

- SAST/DAST pipelines run via `.github/workflows/ci.yml` (Semgrep, CodeQL, OWASP ZAP). Reports are uploaded as artefacts and published to GitHub security.
- False-positive management, alert intake, and ownership are described in `docs/security/APPLICATION_SECURITY.md`.

## Vulnerability Management

- Critical/high findings remediated within 7/14 days respectively; exceptions require formal approval. See `docs/security/VULN_MANAGEMENT.md` for workflow and metrics.

## Access Reviews & RBAC

- Quarterly access reviews cover cloud, Kubernetes, CI/CD, and observability tooling. Process and evidence templates are documented in `docs/security/ACCESS_REVIEWS.md`.

## Incident Response

- Security incidents follow the plan in `docs/security/INCIDENT_RESPONSE.md`, including severity matrix, roles, and drill cadence.

## Audit Logging

- Required audit events, retention, and redaction guidance are detailed in `docs/security/AUDIT_POLICY.md`.

## Secure Coding & Training

- Developers must follow the secure coding guides (`SECURE_CODING_NODE.md`, `SECURE_CODING_PY.md`) and PR checklist (`SECURE_SDLC.md`).
- Security and privacy training requirements are documented in `docs/security/TRAINING.md`; completion records maintained under `docs/security/training-records/`.

## Dependency & Secrets Hygiene

- Dependency automation and review expectations are set in `docs/security/DEPENDENCY_POLICY.md`; updates are managed via Dependabot.
- Secrets prevention hooks and response steps live in `docs/security/SECRETS_PREVENTION.md`.

## Dynamic Testing & WAF

- Security testing guides (`docs/security/APP_FUZZING.md`) explain fuzzing and ZAP usage. Execute regularly in dev/staging.
- Public endpoint protections and rate limits reside in `docs/security/WAF_POLICY.md`; coordinate implementation with SRE.

## Compliance & Vendor Governance

- Compliance mapping against DSPT/DCB 0129/0160 resides in `docs/security/COMPLIANCE_MAP.md` with evidence collection cadence.
- Vendor assessments and remediation tracking live in `docs/security/VENDOR_RISK.md`.

## Broker TLS (NATS)

- All environments must connect to NATS over TLS. Local development uses self-signed certificates generated via `scripts/ops/generate-dev-certs.sh`, which emits a CA bundle plus server/client certificates under `infra/tls/dev/`.
- Docker Compose mounts the certificates into NATS (`/etc/nats/certs/*`) and the Node services (`/etc/onecare/tls/*`) and enforces mutual TLS (`NATS_TLS_ENABLED=1`, `NATS_TLS_REQUIRED=1`).
- Production/staging certificates must be provisioned through the managed secrets pipeline (Vault + sealed secrets). Never reuse the dev CA for shared environments.
- When rotating broker certificates, deploy the new CA + server/client material to staging first, trigger `npm run bus:tls:refresh` (or restart the pods), verify successful reconnect, then promote to production. Update the rotation log with timestamps and operators.

## Pentest Playbook

See [`docs/SECURITY_PENTEST.md`](./SECURITY_PENTEST.md) for the pre-engagement checklist, communication plan, and seeded hardening backlog.
