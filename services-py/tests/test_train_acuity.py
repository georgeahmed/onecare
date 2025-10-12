from pathlib import Path
import pickle

import json

import train_acuity


def test_train_acuity_creates_artifacts(tmp_path, monkeypatch):
    monkeypatch.chdir(Path(__file__).resolve().parents[1])
    tmp_models = tmp_path / "models"
    tmp_models.mkdir(parents=True, exist_ok=True)

    monkeypatch.setattr(train_acuity, "MODEL_DIR", tmp_models, raising=False)
    monkeypatch.setattr(train_acuity, "TRAINING_DATA_PATH", tmp_models / "acuity_training_data.pkl", raising=False)
    monkeypatch.setattr(train_acuity, "MODEL_PATH", tmp_models / "acuity_model.pkl", raising=False)
    monkeypatch.setattr(train_acuity, "META_PATH", tmp_models / "acuity.meta.json", raising=False)

    train_acuity.main()

    assert train_acuity.MODEL_PATH.exists()
    assert train_acuity.META_PATH.exists()
    assert train_acuity.TRAINING_DATA_PATH.exists()

    with train_acuity.MODEL_PATH.open("rb") as handle:
        artifact = pickle.load(handle)
    assert "prototypes" in artifact
    assert artifact["schema"] == "https://onecare/features/acuity/v1"

    metadata = json.loads(train_acuity.META_PATH.read_text())
    assert metadata["calibration"]["temperature"] > 0
    assert 0 <= metadata["calibration"]["threshold"] <= 1
