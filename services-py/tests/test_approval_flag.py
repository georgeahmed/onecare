import pytest
from fastapi.testclient import TestClient

from scribe_service.main import app
from security_utils import scribe_headers, set_scribe_auth_env


@pytest.fixture(autouse=True)
def configure_llm(monkeypatch):
    monkeypatch.setenv("LLM_MODEL", "gpt-4o-mini")
    monkeypatch.setenv("LLM_API_KEY", "key")
    set_scribe_auth_env(monkeypatch)
    yield


def _call_draft(client, approved_env=None):
    if approved_env is not None:
        for key in ("REQUIRE_CLINICIAN_APPROVAL", "SCRIBE_REQUIRE_CLINICIAN_APPROVAL"):
            client.app.dependency_overrides = {}
    payload = {"text": "Sample transcript."}
    response = client.post(
        "/draft",
        headers=scribe_headers("scribe:draft"),
        json=payload,
    )
    return response.json()


def test_draft_requires_approval_by_default():
    with TestClient(app) as client:
        body = _call_draft(client)
        assert body["approved"] is False


def test_draft_approved_when_flag_disabled(monkeypatch):
    monkeypatch.setenv("REQUIRE_CLINICIAN_APPROVAL", "0")
    with TestClient(app) as client:
        body = _call_draft(client)
        assert body["approved"] is True
