# Secrets Management & Rotation Policy

Last updated: 2025-10-18  
Owners: Security (policy), DevOps SRE (operations), Team Leads (application secrets)

## Scope

This policy covers all credentials used by OneCare systems, including API keys, database credentials, certificates, tokens, and encryption keys across development, staging, and production environments.

## Classification & Storage

| Secret Type | Examples | Storage | Notes |
|-------------|----------|---------|-------|
| **Application tokens** | GP Connect API keys, ICS partner credentials, third-party webhook secrets | Vault KV (`kv/<domain>/<service>/*`) | Issued per environment; inherit Vault ACLs. |
| **Infrastructure credentials** | NATS creds, Redis passwords, Kubernetes service tokens | Vault; sealed secrets for bootstrap | Never stored in git; sealed secrets encrypted with cluster key. |
| **Certificates & Keys** | TLS certs, mTLS client certs, signing keys (cosign) | Vault PKI / cert-manager; Hashicorp Vault; KMS where available | Private keys never leave secure store; rotation automated via cert-manager where possible. |
| **Encryption keys** | Object store SSE keys, feature-store encryption keys | Cloud KMS (GCP/AWS/Azure) | Access controlled via IAM roles. |

### Retrieval & Injection

- Workloads obtain secrets via Vault Agent sidecars or Kubernetes Secrets generated from Vault (see `infra/secrets/`).
- Local development uses short-lived Vault tokens; `.env.local` files must not be committed.
- CI secrets stored in GitHub Actions secrets, fed from Vault via automation.

## Rotation SLAs

| Secret Type | Standard Rotation | Emergency Rotation | Owner |
|-------------|-------------------|--------------------|-------|
| Application API keys | Every 90 days | Within 24 hours of compromise | Service team lead |
| Infrastructure credentials (NATS, Redis) | Every 60 days | Immediate | DevOps SRE |
| TLS server certificates | 30 days (automated via cert-manager) | Immediate | DevOps SRE |
| mTLS client certificates | 30 days (automated) | Immediate | DevOps SRE / Integrations |
| Signing keys (cosign) | 180 days; dual-key overlap 14 days | Immediate (revoke old key) | Security |
| Encryption keys (KMS) | 365 days (automatic rotation) | Triggered per incident | Security / Platform |

Rotation SLAs are tracked via the security backlog and surfaced on the compliance dashboard.

## Rotation Procedure

1. **Plan:** Create change ticket with scope, environment, owners, and fallback plan.
2. **Issue new secret:** Generate/store in Vault or appropriate KMS. For certificates, cert-manager handles issuance.
3. **Deploy:** Update consuming services using Helm/Kustomize; ensure dual-secret support when possible.
4. **Validate:** Run smoke tests (`scripts/ci/http_smoke.sh`), monitor errors/metrics (e.g., `nats.connection_error`).
5. **Revoke old secret:** After validation, revoke/delete old entries; update audit log.
6. **Record:** Append to rotation log (`docs/security/rotation-log.md` when applicable) with timestamps.

Emergency rotation follows the same steps with compressed timelines; post-incident review documents lessons learned.

## Verification & Monitoring

- Automated alerts when secrets approach expiry (Vault leases, cert-manager expiration metrics, cosign key schedule).
- CI checks (`scripts/ci/enforce_security_policy.mjs`) block commits containing secrets (gitleaks).
- Quarterly secret access review as part of `ACCESS_REVIEWS.md` ensures only necessary personnel retain read/write access.

## Prohibited Practices

- Secrets must never be committed to git, chat logs, or shared documents.
- Do not reuse production secrets in lower environments.
- Avoid long-lived tokens without rotation; if provider lacks API access, document exception with expiry.

## References

- `docs/runbooks/secret-rotation.md` — operational rotation steps.
- `infra/secrets/` — Vault Agent and sealed secret scaffolding.
- `docs/security/ACCESS_REVIEWS.md` — quarterly review cadence.
