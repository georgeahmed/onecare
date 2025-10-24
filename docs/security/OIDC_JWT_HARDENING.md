# OIDC / JWT Verification Hardening

Last updated: 2025-10-18  
Owners: Security, Integrations 01

## Verification Requirements

- **Algorithms:** Accept only asymmetric algorithms (`RS256`, `RS384`, `RS512`, `ES256`, `EdDSA`). Reject `none` and symmetric HMAC algorithms unless explicitly approved.
- **Issuer (`iss`) & Audience (`aud`):** Validate strictly against configured values. Support multiple audiences only when documented; prefer exact string match.
- **Expiration (`exp`) & Not-Before (`nbf`):** Enforce both claims with a default clock skew of ±120 seconds. Reject tokens missing either claim.
- **Issued-At (`iat`):** Optional but recommended to guard against replay; reject tokens issued more than 24 hours ago unless refresh flow documented.
- **JWT ID (`jti`):** When provided, feed into idempotency store for replay detection.

## JWKs Retrieval & Rotation

- Cache JWK sets for a maximum of 12 hours. Shorten to 15 minutes for providers that rotate frequently.
- On encountering an unknown `kid`, trigger immediate re-fetch. If still unknown, fail the request and log at warning level.
- Pin TLS for JWK endpoint using the TLS policy (SPKI hashes). Revalidate after each refresh.
- Support key revocation by maintaining a denylist loaded from configuration/feature flags.

## Error Handling

- Distinguish between invalid signature, expired token, skew violations, and claim mismatches in logs (without exposing token contents).
- Return `401 Unauthorized` with a standard error envelope; never include raw JWT in responses.
- Emit security events for repeated failures (`jwt.invalid_signature`, `jwt.expired`, `jwt.replay_detected`).

## Testing Checklist

| Scenario | Expected Outcome |
|----------|------------------|
| Valid token | Auth succeeds, claims propagated. |
| Wrong audience | Request denied, `jwt.invalid_audience` logged. |
| Wrong issuer | Request denied, `jwt.invalid_issuer`. |
| Expired token | Request denied, `jwt.expired`. |
| `nbf` in future | Request denied, `jwt.not_yet_valid`. |
| Unknown `kid` followed by refresh | Re-fetch JWKs; if still unknown, deny. |
| Replay (`jti` repeated) | Request denied, event logged. |
| Unsupported algorithm | Request denied, event logged. |

Integrations must implement automated tests (Vitest/Pytest) covering the scenarios above before enabling new identity providers.

## Implementation References

- `packages/security/src/jwt.ts` — shared verification helpers (ensure align with this policy).
- `docs/security/TLS_POLICY.md` — TLS pinning requirements for identity providers.
- `docs/security/PRIVACY_CHECKLIST.md` — incorporate JWT hardening checks during privacy reviews.
