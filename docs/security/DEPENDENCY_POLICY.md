# Dependency Management Policy

Last updated: 2025-10-18  
Owners: Platform Engineering, Security

## Goals

- Keep dependencies current to reduce vulnerability exposure while maintaining stability.

## Automation

- Dependabot monitors npm and pip dependencies via `.github/dependabot.yml`.
- Update frequency: weekly (Monday) with grouped updates for minor/patch versions; security advisories trigger immediate PRs.
- Each PR runs full CI (typecheck, tests, security scans). Auto-merge disabled; manual review required.

## Review Process

- Include release notes/changelogs in PR description.
- For major version bumps, create follow-up task to run regression tests and update docs.
- Label dependency PRs with `dependencies` and, if security-related, `security`.

## Exceptions

- If an update cannot be applied, comment with justification, planned revisit date, and reference to Jira ticket.
- Document pinned versions in `package.json`/`requirements.txt` with rationale.

## References

- Vulnerability policy: `docs/security/VULN_MANAGEMENT.md`
- Supply chain policy: `docs/security/SUPPLY_CHAIN.md`
