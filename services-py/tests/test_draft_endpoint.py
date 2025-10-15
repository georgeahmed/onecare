import pytest
from fastapi.testclient import TestClient

from scribe_service.main import app
from scribe_service.token_utils import rough_token_count
from security_utils import scribe_headers, set_scribe_auth_env


@pytest.fixture(autouse=True)
def configure_env(monkeypatch):
    monkeypatch.setenv("LLM_MODEL", "gpt-4o-mini")
    monkeypatch.setenv("LLM_API_KEY", "test-key")
    monkeypatch.setenv("LLM_API_ENDPOINT", "https://example.com/llm")
    monkeypatch.setenv("UNCERTAINTY_HIGHLIGHT", "true")
    set_scribe_auth_env(monkeypatch)
    yield


def test_draft_endpoint_returns_summary(monkeypatch):
    monkeypatch.setenv("SUMMARY_MAX_TOKENS", "32")
    payload = {
        "text": "Patient is maybe experiencing dizziness and possibly dehydration.",
        "quality": {
            "lowConfidence": False,
            "silenceDetected": False,
            "notes": [],
        },
    }

    with TestClient(app) as client:
        response = client.post(
            "/draft",
            headers=scribe_headers("scribe:draft"),
            json=payload,
        )

        assert response.status_code == 200
        body = response.json()
        assert "summary" in body
        assert "[summary:gpt-4o-mini" in body["summary"]
        assert rough_token_count(body["summary"]) <= 32


def test_draft_endpoint_uses_default_tokens(monkeypatch):
    monkeypatch.delenv("SUMMARY_MAX_TOKENS", raising=False)
    monkeypatch.setenv("UNCERTAINTY_HIGHLIGHT", "false")

    long_text = " ".join(["word" + str(i) for i in range(100)])
    payload = {"text": long_text}

    with TestClient(app) as client:
        response = client.post(
            "/draft",
            headers=scribe_headers("scribe:draft"),
            json=payload,
        )

        assert response.status_code == 200
        body = response.json()
        assert body["summary"].startswith("[summary:gpt-4o-mini")
        assert rough_token_count(body["summary"]) <= 512


def test_draft_endpoint_returns_service_unavailable_when_llm_misconfigured(monkeypatch):
    monkeypatch.delenv("LLM_API_KEY", raising=False)
    monkeypatch.delenv("SCRIBE_LLM_API_KEY", raising=False)

    payload = {"text": "Patient stable."}

    with TestClient(app) as client:
        response = client.post(
            "/draft",
            headers=scribe_headers("scribe:draft"),
            json=payload,
        )

        assert response.status_code == 503
        assert response.json() == {
            "detail": {"status": "llm_unavailable", "reason": "missing_or_invalid_configuration"}
        }
