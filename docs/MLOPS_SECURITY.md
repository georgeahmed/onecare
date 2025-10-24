## MLOps Secrets Management & Rotation

This document outlines how ML services consume, store, and rotate secrets such as model signing keys, API tokens, and cosign credentials.

### Secrets Source of Truth

- **Vault** (preferred): Kubernetes auth + Vault Agent Injector template the required secrets (API tokens, cosign private key, feature-log key) into the pod as files under `/var/run/secrets/onecare/`.
- **Cloud KMS** fallback: when Vault is unavailable, reference KMS-encrypted secrets via sealed secrets / ExternalSecrets. Document exceptions in the security backlog.
- No secrets are baked into container images. Dockerfiles use distroless bases and read configuration from environment variables or mounted volumes at runtime.

### Consumption Pattern

1. Define the secret spec in Vault (`secret/mlops/<service>/<name>`). Include owner, rotation cadence, and contact.
2. Inject via Vault Agent sidecar with a template that writes to `/var/run/secrets/onecare/<name>`.
3. Services read the secret on startup using the `SECURITY_BUNDLE_PATH` (for bundles) or dedicated env vars.
4. Secrets that must be exposed as environment variables (e.g., `COSIGN_PRIVATE_KEY`) are projected via `envFrom` with `secretRef` – the secret must be created by the Vault sync controller.

### Rotation Playbook

1. Stage rotation in non-production:
   - Generate new secret material (e.g., `cosign key generate --kms ...`).
   - Update Vault with the new value and set `rotation_in_progress=true` metadata.
   - Restart the staging deployment and verify `/ready` and `/metrics` stay healthy.
2. Promote to production:
   - Repeat the update; monitor latency/error alerts for 15 minutes.
   - Once verified, remove `rotation_in_progress` and revoke the previous version.
3. Document the rotation in `docs/runbooks/secret-rotation.md` with date, operator, and justification.

### Taxonomy & Owners

| Secret | Scope | Owner | Rotation | Notes |
| --- | --- | --- | --- | --- |
| `cosign-private-key` | Image signing | Security | 180 days | Stored in Vault + KMS backup |
| `feature-log-api-key` | Feature logging | ML Ops | 90 days | Propagated to orchestrator |
| `safety-gate-shadow-token` | Shadow endpoints | ML Ops | 90 days | Used for `/metrics/golden` |
| `ml-registry-token` | Model registry pull | ML Engineering | 180 days | Required for artifact fetch |

Update the table when adding new secrets to maintain ownership clarity.

### Validation

- Rotation tests run quarterly: update staging secrets, restart workloads, and confirm no downtime.
- CI enforces that secrets are referenced via `envFrom`/Vault templates (see `scripts/ci/check_platform_checklists.sh`).
- Alerts monitor secrets near expiry (Vault lease TTL, cosign key metadata). Configure PagerDuty notifications at T-14 days.
