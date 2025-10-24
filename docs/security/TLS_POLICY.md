# TLS / mTLS Policy

Last updated: 2025-10-18  
Owners: Security, DevOps SRE

## Objectives

Ensure confidentiality, integrity, and authenticity of all network traffic between OneCare services and external partners.

## Protocol Requirements

- **Minimum version:** TLS 1.2. Prefer TLS 1.3 for new integrations. Disable SSLv3, TLS 1.0/1.1.
- **Ciphersuites:**
  - Server-side: `TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384`, `TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384`, TLS 1.3 defaults (`TLS_AES_256_GCM_SHA384`, `TLS_CHACHA20_POLY1305_SHA256`).
  - Disable static RSA and CBC suites.
- **Certificates:**
  - Public endpoints: LetsEncrypt via cert-manager (`clusterissuer-*.yaml`).
  - Internal services: certificates issued by `onecare-internal-ca` (cert-manager). Rotate leaf certs every 30 days, CA every 6 months.
- **HSTS:** Enable on public ingress (`max-age=31536000; includeSubDomains`).

## Mutual TLS

- **Mandatory:** Internal service-to-service traffic (orchestrator ↔ booking/ics/safety), NATS/JetStream, ICS partner integrations where available.
- **Optional:** External partners without mTLS support must provide compensating controls (IP allowlists, signed requests).
- mTLS configuration references:
  - Kubernetes ingress: see `infra/k8s/cert-manager/` and service values files.
  - Compose/dev: `scripts/ops/generate-dev-certs.sh` issues local CA + client certs.
- Services must trust the `onecare-internal-ca` bundle stored in Vault/ConfigMap.

## Certificate Pinning & Validation

- **Outbound HTTP clients:**
  - Validate hostname and certificate chain (default). Reject mismatched SAN/CN.
  - For high-risk integrations (GP Connect, ICS partner APIs), configure SPKI pin sets updated during rotation.
  - JWKs / OIDC: pin TLS to provider endpoints and cache JWKs for ≤12 hours (see `OIDC_JWT_HARDENING.md`).
- **Rotation:**
  - Pre-stage new pins and overlap with existing ones for at least one deploy cycle.
  - Document rotation plan in runbooks; test in staging.

## Operational Practices

- Maintain cert-manager health dashboards; alert when certificates expire in <7 days.
- Store private keys in Kubernetes secrets sourced from Vault/Sealed Secrets. Never commit keys to git.
- Use short-lived (≤7 days) client certificates where possible; automate renewals.
- Audit TLS configuration quarterly (Mozilla Observatory, SSL Labs) for public endpoints.
- Keep ingress controllers patched; enable OCSP stapling and TLS session resumption.

## References

- `infra/k8s/cert-manager/*.yaml` — issuer and certificate resources.
- `infra/k8s/ingress/*.yaml` — ingress definitions with cert-manager annotations.
- `docs/security/THREAT_MODEL.md` — context for secure channels.
- `docs/security/OIDC_JWT_HARDENING.md` — requirements for JWT & JWKs.
