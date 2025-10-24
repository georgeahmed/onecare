# Code Scanning Policy (Semgrep & CodeQL)

Last updated: 2025-10-18  
Owners: Security, Engineering Leads

## Tooling

- **Semgrep:** OWASP Top 10 ruleset plus repository-specific rules to catch SSRF, unsafe logging, and insecure dependencies.
- **CodeQL:** GitHub Advanced Security queries for JavaScript/TypeScript and Python.

## Pipeline

- CI runs SAST in the `sast` job (`.github/workflows/ci.yml`).
- Semgrep outputs `semgrep.json` and `semgrep.sarif` artefacts; CodeQL publishes SARIF to GitHub security.
- High/critical Semgrep findings (severity `ERROR`) fail the job. Medium/low log warnings.
- SARIF artefacts are archived for later review and compliance evidence.

## Ruleset Maintenance

- Security owns the rulesets; update quarterly or when new patterns emerge.
- False positives must be suppressed via inline comments (`# nosemgrep`) with justification and expiry, and tracked in `config/security/sast-allowlist.yml` (future enhancement).

## Remediation Workflow

1. Finding raised in CI → developer reviews job logs/artefacts.
2. Fix issue or document suppression in PR with rationale.
3. Security reviews high-severity suppressions weekly.

## References

- `docs/security/APPLICATION_SECURITY.md` — broader testing strategy.
- `docs/security/SECURE_SDLC.md` — integration into PR checklist.
