# Access Reviews & Least-Privilege Policy

Last updated: 2025-10-18  
Owners: Security (coordination), DevOps SRE, Engineering Managers

## Principles

- Grant access based on least privilege and need-to-know. Role-based groups preferred over direct user permissions.
- Access changes must be ticketed and approved by the relevant team lead.
- All production access requires MFA.

## Systems in Scope

- Cloud infrastructure (AWS/GCP/Azure projects).
- Kubernetes clusters.
- Databases, object stores, message brokers.
- Observability platforms (Grafana, Loki, Prometheus, Sentry).
- CI/CD (GitHub, artifact registries).
- Vault / Secrets management.

## Quarterly Review Process

1. Export current access lists per system (IAM roles, GitHub teams, Vault policies).
2. Compare to expected roster; flag inactive users, team changes, contractors.
3. Review elevated privileges (admin, production shell access).
4. Remove or downgrade access promptly; document approvals.
5. Store evidence (CSV exports, meeting notes) in `docs/security/access-review/<YYYY-QX>/` with summary.

### Review Schedule

- Q1 (Jan), Q2 (Apr), Q3 (Jul), Q4 (Oct). Lead: Security.
- Ad-hoc review required after personnel changes or incidents.

### Checklist

- [ ] Export user/group membership for each system.
- [ ] Validate justification for privileged roles.
- [ ] Confirm contractors have end dates and access revocation plan.
- [ ] Ensure service accounts rotate credentials per `SECRETS_POLICY.md`.
- [ ] Update onboarding/offboarding documentation.

## Role Definitions

- **Admin:** Full management rights; limited to platform/SRE leads; requires justification.
- **Maintainer:** Deploy/manage services but not change IAM policies.
- **Viewer:** Read-only metrics/logs.
- **Service Account:** Non-human account with scoped access; rotates credentials periodically.

## Automation & Tooling

- Use Terraform/IaC for permissions where feasible; PRs reviewed by two maintainers.
- Vault & IAM access reports generated via scheduled jobs (re-use `backup-nightly` runner window).
- Slack bot reminder sent two weeks before review deadline.

## References

- `docs/security/SECRETS_POLICY.md` — rotation expectations.
- `docs/security/INCIDENT_RESPONSE.md` — escalation if unauthorized access detected.
