import pytest
from fastapi.testclient import TestClient

from scribe_service.asr_runner import TranscriptionChunk, TranscriptionResult
from scribe_service.audio_store import AudioRetentionConfig, AudioStore
from scribe_service.main import app
from security_utils import scribe_headers, set_scribe_auth_env


@pytest.fixture(autouse=True)
def configure_auth(monkeypatch):
    set_scribe_auth_env(monkeypatch)


def test_ready_endpoint_reports_ready():
    with TestClient(app) as client:
        response = client.get("/ready")

        assert response.status_code == 200
        assert response.json() == {"status": "ready"}


def test_transcribe_endpoint_returns_transcript(monkeypatch):
    captured_payload: dict[str, str] = {}

    def fake_transcribe(audio_payload, *, model, enable_diarization=True, **_):
        captured_payload.update(audio_payload)
        return TranscriptionResult(
            text="[SPEAKER_1] transcribed text",
            chunks=(
                TranscriptionChunk(
                    index=0,
                    start=0.0,
                    end=30.0,
                    text="[SPEAKER_1] chunk",
                    speaker="SPEAKER_1",
                ),
            ),
            model_name=model.name if hasattr(model, "name") else "stub",
        )

    monkeypatch.setattr("scribe_service.main.run_transcription", fake_transcribe)

    payload = {
        "encounterId": "enc-123",
        "audioUrl": "https://storage.example/audio.wav?token=secret",
        "contentType": "audio/wav",
        "diarization": True,
    }

    with TestClient(app) as client:
        client.app.state.audio_store = AudioStore(AudioRetentionConfig(store_audio="binary", retention_days=30))
        response = client.post(
            "/transcribe",
            headers=scribe_headers("scribe:transcribe"),
            json=payload,
        )

        assert response.status_code == 200
        body = response.json()
        assert set(body) == {"text", "quality"}
        assert body["text"].startswith("[SPEAKER_1]")
        assert "transcribed text" in body["text"]
        quality = body["quality"]
        assert quality["lowConfidence"] in {True, False}
        assert quality["silenceDetected"] in {True, False}
        assert isinstance(quality["notes"], list)
        assert response.headers.get("x-correlation-id")
        assert response.headers.get("x-consent-reference")
        assert captured_payload["contentType"] == "audio/wav"
        stored_refs = client.app.state.audio_store.list_references()
        assert len(stored_refs) == 1
        assert "token" not in stored_refs[0].audio_url


def test_transcribe_respects_diarization_flag():
    payload = {
        "encounterId": "enc-789",
        "audioUrl": "s3://bucket/audio.wav",
        "contentType": "audio/wav",
        "diarization": False,
    }

    with TestClient(app) as client:
        response = client.post(
            "/transcribe",
            headers=scribe_headers("scribe:transcribe"),
            json=payload,
        )

    assert response.status_code == 200
    body = response.json()
    assert "[SPEAKER_" not in body["text"]


def test_transcribe_rejects_insecure_scheme():
    payload = {
        "encounterId": "enc-456",
        "audioUrl": "http://example.com/audio.wav",
        "contentType": "audio/wav",
    }

    with TestClient(app) as client:
        response = client.post(
            "/transcribe",
            headers=scribe_headers("scribe:transcribe"),
            json=payload,
        )

    assert response.status_code == 400
    body = response.json()
    error = body["detail"]["error"]
    assert error["code"] == "invalid_input"
    assert error["details"]["reason"] == "unsupported_scheme"
    assert response.headers.get("x-correlation-id")
    assert response.headers.get("x-consent-reference")


def test_transcribe_rejects_private_host():
    payload = {
        "encounterId": "enc-789",
        "audioUrl": "https://127.0.0.1/audio.wav",
        "contentType": "audio/wav",
    }

    with TestClient(app) as client:
        response = client.post(
            "/transcribe",
            headers=scribe_headers("scribe:transcribe"),
            json=payload,
        )

    assert response.status_code == 400
    body = response.json()
    assert body["detail"]["error"]["code"] == "invalid_input"
    assert body["detail"]["error"]["details"]["reason"] == "private_host"
    assert response.headers.get("x-correlation-id")
    assert response.headers.get("x-consent-reference")


def test_transcribe_rejects_s3_credentials():
    payload = {
        "encounterId": "enc-cred",
        "audioUrl": "s3://access:secret@bucket/audio.wav",
        "contentType": "audio/wav",
    }

    with TestClient(app) as client:
        response = client.post(
            "/transcribe",
            headers=scribe_headers("scribe:transcribe"),
            json=payload,
        )

    assert response.status_code == 400
    body = response.json()
    detail = body["detail"]["error"]["details"]
    assert detail["reason"] == "credentials_not_allowed"
    assert response.headers.get("x-correlation-id")
    assert response.headers.get("x-consent-reference")
