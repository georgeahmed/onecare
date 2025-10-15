"""Test helper utilities for service-to-service authentication."""

from __future__ import annotations

from typing import Optional

SAFETY_API_KEY = "test-safety-key"
SCRIBE_API_KEY = "test-scribe-key"
CONSENT_REFERENCE = "Consent/test"


def set_safety_auth_env(monkeypatch) -> None:
    monkeypatch.setenv("SAFETY_GATE_API_KEY", SAFETY_API_KEY)


def safety_headers(scope: str = "safety:analyze", correlation_id: Optional[str] = None) -> dict[str, str]:
    headers = {
        "authorization": f"Bearer {SAFETY_API_KEY}",
        "x-auth-scope": scope,
        "x-consent-reference": CONSENT_REFERENCE,
    }
    if correlation_id:
        headers["x-correlation-id"] = correlation_id
    return headers


def set_scribe_auth_env(monkeypatch) -> None:
    monkeypatch.setenv("SCRIBE_SERVICE_API_KEY", SCRIBE_API_KEY)


def scribe_headers(scope: str, correlation_id: Optional[str] = None) -> dict[str, str]:
    headers = {
        "authorization": f"Bearer {SCRIBE_API_KEY}",
        "x-auth-scope": scope,
        "x-consent-reference": CONSENT_REFERENCE,
    }
    if correlation_id:
        headers["x-correlation-id"] = correlation_id
    return headers
