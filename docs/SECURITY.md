# Security

This repository handles clinical workflows and is expected to protect PHI/PII at all times. Secrets must never be committed to git or shared outside of approved tooling. This document captures the baseline for storing, rotating, and validating secrets across environments.

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

- CI runs `npm audit --audit-level=high` and `pip-audit` (see `.github/workflows/ci.yml`) to detect vulnerable dependencies. Both steps upload SARIF-style output as artifacts for triage.
- Use `npx license-checker --json` locally before introducing new packages. The allowlist is: `MIT`, `Apache-2.0`, `BSD-2-Clause`, `BSD-3-Clause`, `ISC`. Raise an exception if you need anything else.
- When a scan flags an issue, record it in the security backlog with remediation ETA. Block releases if a critical/high advisory lacks an approved exception.

## Secret Scanning Pipeline

- Gitleaks runs in CI on every push and fails the job for high-confidence findings. The configuration matches `.pre-commit-config.yaml`.
- Install pre-commit hooks (`pre-commit install`) so local diffs are scanned before committing. Use the `--redact` flag when sharing reports.
- If a false positive appears, add the signature to `.gitleaks.toml` with a justification and expiry date.

## Network Egress Controls

- Kubernetes deployments must apply the deny-by-default NetworkPolicy template in `infra/k8s/networkpolicies/egress-deny.yaml` and then explicitly allow necessary hosts/ports.
- For HTTP clients, enforce SSRF mitigations by validating hostnames and IPs against the allowlist before issuing requests (see `apps/orchestrator/src/index.ts` for existing URL guards).
- Document every exception request (team, hostname, expiry) in the environment runbooks and review quarterly.
