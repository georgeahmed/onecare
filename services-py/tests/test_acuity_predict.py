import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from safety_gate_service.main import app
from safety_gate_service.predict import load_model_bundle

FIXTURE_DIR = Path(__file__).resolve().parent / "fixtures" / "acuity"
INPUT_CASES = json.loads((FIXTURE_DIR / "input.json").read_text(encoding="utf-8"))["cases"]
EXPECTED_OUTCOMES = {
    case["name"]: case for case in json.loads((FIXTURE_DIR / "output.json").read_text(encoding="utf-8"))["cases"]
}


@pytest.fixture(autouse=True)
def reset_model_cache(monkeypatch):
    monkeypatch.delenv("SAFETY_GATE_ACUITY_MODEL_PATH", raising=False)
    monkeypatch.delenv("SAFETY_GATE_ACUITY_META_PATH", raising=False)
    monkeypatch.delenv("SAFETY_GATE_ACUITY_MODEL_VERSION", raising=False)
    monkeypatch.delenv("SAFETY_GATE_MODELS_DIR", raising=False)
    load_model_bundle.cache_clear()
    yield
    load_model_bundle.cache_clear()


@pytest.mark.parametrize("case", INPUT_CASES, ids=lambda case: case["name"])
def test_predict_matches_fixture(case):
    client = TestClient(app)
    response = client.post("/predict", json=case["request"])

    assert response.status_code == 200
    correlation_id = response.headers.get("x-correlation-id")
    assert correlation_id

    body = response.json()
    expected = EXPECTED_OUTCOMES[case["name"]]["predict"]

    assert body["level"] == expected["level"]
    assert body["modelVersion"] == expected["modelVersion"]
    assert body["probEmergency"] == pytest.approx(expected["probEmergency"], rel=1e-6, abs=1e-12)


@pytest.mark.parametrize("case", INPUT_CASES, ids=lambda case: case["name"])
def test_predict_proba_matches_fixture(case):
    client = TestClient(app)
    response = client.post("/predict_proba", json=case["request"])

    assert response.status_code == 200
    correlation_id = response.headers.get("x-correlation-id")
    assert correlation_id

    body = response.json()
    expected = EXPECTED_OUTCOMES[case["name"]]["predict_proba"]

    assert body["modelVersion"] == expected["modelVersion"]

    probabilities = body["probabilities"]
    expected_probabilities = expected["probabilities"]
    assert set(probabilities) == set(expected_probabilities)

    for label, value in expected_probabilities.items():
        assert probabilities[label] == pytest.approx(value, rel=1e-6, abs=1e-12)

    assert sum(probabilities.values()) == pytest.approx(1.0, rel=1e-6, abs=1e-9)
