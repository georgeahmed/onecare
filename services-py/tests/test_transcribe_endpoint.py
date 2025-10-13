from fastapi.testclient import TestClient

from scribe_service.main import app


def test_ready_endpoint_reports_ready():
    with TestClient(app) as client:
        response = client.get("/ready")

        assert response.status_code == 200
        assert response.json() == {"status": "ready"}


def test_transcribe_endpoint_returns_transcript():
    payload = {
        "encounterId": "enc-123",
        "audioUrl": "s3://bucket/audio.wav",
        "contentType": "audio/wav",
        "diarization": True,
    }

    with TestClient(app) as client:
        response = client.post("/transcribe", json=payload)

        assert response.status_code == 200
        body = response.json()
        assert set(body) == {"text", "quality"}
        assert body["text"].startswith("[0.00-30.00]")
        assert "s3://bucket/audio.wav" in body["text"]
        quality = body["quality"]
        assert quality["lowConfidence"] in {True, False}
        assert quality["silenceDetected"] in {True, False}
        assert isinstance(quality["notes"], list)


def test_transcribe_rejects_insecure_scheme():
    payload = {
        "encounterId": "enc-456",
        "audioUrl": "http://example.com/audio.wav",
        "contentType": "audio/wav",
    }

    with TestClient(app) as client:
        response = client.post("/transcribe", json=payload)

        assert response.status_code == 422
        body = response.json()
        assert isinstance(body.get("detail"), list)
        first_error = body["detail"][0]
        assert first_error["type"] == "string_pattern_mismatch"
        assert first_error["loc"] == ["body", "audioUrl"]


def test_transcribe_rejects_private_host():
    payload = {
        "encounterId": "enc-789",
        "audioUrl": "https://127.0.0.1/audio.wav",
        "contentType": "audio/wav",
    }

    with TestClient(app) as client:
        response = client.post("/transcribe", json=payload)

        assert response.status_code == 400
        body = response.json()
        assert body["detail"]["error"]["code"] == "invalid_input"
        assert body["detail"]["error"]["details"]["reason"] == "private_host"
