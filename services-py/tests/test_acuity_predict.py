import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from safety_gate_service.main import app
from safety_gate_service.predict import load_model_bundle
from security_utils import safety_headers, set_safety_auth_env

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
    set_safety_auth_env(monkeypatch)
    load_model_bundle.cache_clear()
    yield
    load_model_bundle.cache_clear()


@pytest.mark.parametrize("case", INPUT_CASES, ids=lambda case: case["name"])
def test_predict_matches_fixture(case):
    client = TestClient(app)
    response = client.post(
        "/predict",
        headers=safety_headers(scope="safety:predict"),
        json=case["request"],
    )

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
    response = client.post(
        "/predict_proba",
        headers=safety_headers(scope="safety:predict"),
        json=case["request"],
    )

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


def test_load_model_bundle_rejects_mismatched_dimension(monkeypatch):
    monkeypatch.setattr(
        "safety_gate_service.predict._load_artifact_payload",
        lambda *args, **kwargs: ({"prototypes": {2: [0.1, 0.2]}}, {"modelVersion": "bad"}),
    )
    load_model_bundle.cache_clear()
    with pytest.raises(RuntimeError, match="dimension"):
        load_model_bundle()
    load_model_bundle.cache_clear()


def test_predict_outcome_requires_emergency_prototype(monkeypatch):
    from safety_gate_service.predict import EMBEDDING_SIZE

    prototype_length = EMBEDDING_SIZE + 4
    monkeypatch.setattr(
        "safety_gate_service.predict._load_artifact_payload",
        lambda *args, **kwargs: (
            {"prototypes": {0: [0.0] * prototype_length}},
            {"modelVersion": "missing"},
        ),
    )
    load_model_bundle.cache_clear()

    response = TestClient(app).post(
        "/predict",
        headers=safety_headers(scope="safety:predict"),
        json={
            "symptomMentions": [{"name": "Chest pain", "confidence": 0.9}],
            "patient": {"ageYears": 55},
        },
    )

    assert response.status_code == 500
    body = response.json()
    error = body.get("error") or body.get("detail", {}).get("error")
    assert error is not None
    assert error["code"] == "prediction_failed"
    load_model_bundle.cache_clear()
