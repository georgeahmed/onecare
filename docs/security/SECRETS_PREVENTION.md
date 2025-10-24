# Secrets Prevention & Scanning

Last updated: 2025-10-18  
Owners: Security, All Contributors

## Pre-Commit Hooks

- `gitleaks` pre-commit hook configured in `.pre-commit-config.yaml`. Install once with `pre-commit install`.
- Hook scans staged changes for high-confidence secrets. Blocks commit on detection. Redact findings in output.
- To bypass for known false positives, add entry to `.gitleaks.toml` (with justification and expiry) and coordinate with Security.

## CI Enforcement

- CI job `security-scans` runs gitleaks with the same configuration on every push/PR.
- Failing to remove secrets causes build failure until resolved.

## Pre-Receive Guidance

- For central Git hosting, enable server-side gitleaks/trufflehog hooks mirroring repo config. Platform team to manage (tracked in `SECOPS-112`).

## Handling Leaks

1. Immediately rotate the exposed credential (see `SECRETS_POLICY.md`).
2. Purge the secret from git history (BFG/git filter-repo) following incident response steps.
3. Document incident in security log and notify stakeholders.

## Developer Tips

- Use environment variables and Vault for secrets; never store in code or console history.
- For local development, store secrets in `.env.local` (ignored) and prefer short-lived tokens.
- Review diffs before committing, especially generated files.
