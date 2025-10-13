import pytest
from fastapi.testclient import TestClient

from scribe_service.main import app


def _payload() -> dict[str, str]:
    return {
        "encounterId": "enc-123",
        "audioUrl": "s3://bucket/audio.wav",
        "contentType": "audio/wav",
    }


def test_audio_not_stored_when_disabled(monkeypatch):
    monkeypatch.setenv("SCRIBE_STORE_AUDIO", "none")
    with TestClient(app) as client:
        response = client.post("/transcribe", json=_payload())
        assert response.status_code == 200
        store = client.app.state.audio_store
        assert store is not None
        assert store.list_references() == []


def test_audio_stored_when_mode_binary(monkeypatch):
    monkeypatch.setenv("SCRIBE_STORE_AUDIO", "binary")
    monkeypatch.setenv("SCRIBE_AUDIO_RETENTION_DAYS", "30")

    with TestClient(app) as client:
        response = client.post("/transcribe", json=_payload())
        assert response.status_code == 200
        store = client.app.state.audio_store
        assert store is not None
        records = store.list_references()
        assert len(records) == 1
        assert records[0].encounter_id == "enc-123"
        assert records[0].audio_url == "s3://bucket/audio.wav"


def test_audio_retention_zero_days_purges_immediately(monkeypatch):
    monkeypatch.setenv("SCRIBE_STORE_AUDIO", "binary")
    monkeypatch.setenv("SCRIBE_AUDIO_RETENTION_DAYS", "0")

    with TestClient(app) as client:
        response = client.post("/transcribe", json=_payload())
        assert response.status_code == 200
        store = client.app.state.audio_store
        assert store is not None
        assert store.list_references() == []
