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
