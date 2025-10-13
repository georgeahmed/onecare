# Security Scanning (Dev & CI)

This repo runs lightweight secrets and vulnerability scanning in CI to catch issues early. Local contributors should run the same tools before opening PRs.

## Tools

| Purpose | Tool | CI step |
|---------|------|---------|
| Secrets detection | [gitleaks](https://github.com/gitleaks/gitleaks) | `Security Scans` job (`gitleaks detect --redact`) |
| Dependency / container CVEs | [Trivy](https://aquasecurity.github.io/trivy) | `Security Scans` job (`trivy fs .`) |

## Running locally

```bash
# Secrets scan
docker run --rm -v "$PWD":/repo zricethezav/gitleaks:latest detect --source /repo --redact

# Filesystem dependency scan (node + python deps, Dockerfiles)
docker run --rm -v "$PWD":/repo aquasec/trivy:latest fs /repo --exit-code 0 --severity HIGH,CRITICAL
```

Notes:
- `--exit-code 0` keeps the scan informational; adjust to `1` to fail on high severity findings locally.
- For offline use, run `trivy image` against built containers (e.g., `onecare-orchestrator`).

## CI behaviour

- `Security Scans` job runs on every push/PR:
  - Trivy filesystem scan (HIGH/CRITICAL severities, ignore unfixed). Soft-fail via `continue-on-error`.
  - Gitleaks secrets scan with redaction. Also soft-fail initially.
- Failures raise GitHub warnings. Promote to blocking once findings are triaged.

## Triage workflow

1. Re-run scans locally to confirm.
2. If a secret was committed:
   - Rotate immediately via Vault/provider.
   - Purge from git history per incident response.
3. For vulnerabilities:
   - Identify impacted package/container.
   - Upgrade, replace, or document exception (with expiry).
4. Update this document and `docs/SECURITY.md` if processes change.
