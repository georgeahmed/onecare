"""Shared service-to-service authentication helpers."""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Optional, Set

from fastapi import Header, HTTPException, status

LOGGER = logging.getLogger("common.security")


def _extract_bearer_token(header: Optional[str]) -> Optional[str]:
    if not header:
        return None
    parts = header.strip().split()
    if len(parts) != 2:
        return None
    scheme, token = parts
    if scheme.lower() != "bearer":
        return None
    return token.strip()


def _parse_scopes(header: Optional[str]) -> Set[str]:
    if not header:
        return set()
    scopes = {item.strip().lower() for item in header.split() if item.strip()}
    return scopes


@dataclass(slots=True)
class AuthzContext:
    """Represents the authenticated caller metadata."""

    actor_id: Optional[str]
    actor_type: Optional[str]
    scopes: Set[str]
    consent_reference: Optional[str]
    correlation_id: Optional[str]


def require_service_auth(
    *,
    env_var: str,
    required_scope: str,
    require_consent: bool = True,
):
    """FastAPI dependency enforcing bearer token + scope + consent headers."""

    normalized_scope = required_scope.strip().lower()

    async def _dependency(  # pragma: no cover - exercised via endpoint tests
        authorization: Optional[str] = Header(default=None),
        scope_header: Optional[str] = Header(default=None, alias="x-auth-scope"),
        consent_reference: Optional[str] = Header(default=None, alias="x-consent-reference"),
        actor_id: Optional[str] = Header(default=None, alias="x-actor-id"),
        actor_type: Optional[str] = Header(default=None, alias="x-actor-type"),
        correlation_id: Optional[str] = Header(default=None, alias="x-correlation-id"),
    ) -> AuthzContext:
        expected = os.getenv(env_var)
        if not expected:
            LOGGER.error("service auth token missing", extra={"env": env_var})
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail={"error": "auth_not_configured"},
            )

        token = _extract_bearer_token(authorization)
        if not token or token != expected:
            LOGGER.warning(
                "service auth denied",
                extra={"reason": "invalid_token", "env": env_var, "correlation_id": correlation_id},
            )
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail={"error": "invalid_token"},
            )

        scopes = _parse_scopes(scope_header)
        if normalized_scope and normalized_scope not in scopes and "*" not in scopes:
            LOGGER.warning(
                "service auth denied",
                extra={
                    "reason": "missing_scope",
                    "required": normalized_scope,
                    "correlation_id": correlation_id,
                },
            )
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail={"error": "insufficient_scope", "required": normalized_scope},
            )

        if require_consent and not consent_reference:
            LOGGER.warning(
                "service auth denied",
                extra={"reason": "missing_consent_reference", "correlation_id": correlation_id},
            )
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail={"error": "missing_consent"},
            )

        return AuthzContext(
            actor_id=actor_id,
            actor_type=actor_type,
            scopes=scopes,
            consent_reference=consent_reference,
            correlation_id=correlation_id,
        )

    return _dependency


__all__ = [
    "AuthzContext",
    "require_service_auth",
]
