import pytest

from safety_gate_service.acuity import AcuityModel
from safety_gate_service.classifier import EmergencyClassifier
from safety_gate_service.ner import SafetyNER


def test_classifier_disallows_remote_downloads_without_opt_in():
    classifier = EmergencyClassifier(env={"SAFETY_GATE_ALLOW_REMOTE_MODELS": "0"})
    with pytest.raises(RuntimeError):
        classifier._load_transformer_model("huggingface/test-model")  # type: ignore[attr-defined]


def test_ner_disallows_remote_downloads_without_opt_in():
    ner = SafetyNER(env={"SAFETY_GATE_ALLOW_REMOTE_MODELS": "0"})
    with pytest.raises(RuntimeError):
        ner._load_pipeline()


def test_acuity_rejects_remote_bundle_uri():
    model = AcuityModel(env={})
    with pytest.raises(RuntimeError):
        model._load_bundle("https://malicious.example.com/model.joblib")
