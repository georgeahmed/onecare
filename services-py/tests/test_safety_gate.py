from fastapi.testclient import TestClient
from safety_gate_service.main import app


def test_analyze_proceed():
    client = TestClient(app)
    resp = client.post(
        "/analyze",
        json={
            "practiceId": "p1",
            "patient": {"id": "x"},
            "narrative": "mild headache",
            "channel": "web",
        },
    )
    assert resp.status_code == 200
    assert resp.json()["outcome"] == "SAFE_TO_CONTINUE"


def test_analyze_divert():
    client = TestClient(app)
    resp = client.post(
        "/analyze",
        json={
            "practiceId": "p1",
            "patient": {"id": "x"},
            "narrative": "I have chest pain",
            "channel": "web",
        },
    )
    assert resp.status_code == 200
    assert resp.json()["outcome"] == "DIVERTED"

