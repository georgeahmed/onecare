import json
import pickle
from pathlib import Path

import train_acuity


def test_train_acuity_creates_artifacts(tmp_path, monkeypatch):
    monkeypatch.chdir(Path(__file__).resolve().parents[1])
    tmp_models = tmp_path / "models"
    tmp_models.mkdir(parents=True, exist_ok=True)

    monkeypatch.setattr(train_acuity, "MODEL_DIR", tmp_models, raising=False)
    monkeypatch.setattr(train_acuity, "TRAINING_DATA_PATH", tmp_models / "acuity_training_data.pkl", raising=False)
    monkeypatch.setattr(train_acuity, "MODEL_VERSION", "9.9.9", raising=False)

    train_acuity.main()

    assert train_acuity.TRAINING_DATA_PATH.exists()

    artifact_path = tmp_models / "acuity-v9.9.9.bin"
    metadata_path = tmp_models / "acuity-v9.9.9.meta.json"
    latest_path = tmp_models / "acuity-latest.bin"
    latest_meta = tmp_models / "acuity-latest.meta.json"

    assert artifact_path.exists()
    assert metadata_path.exists()
    assert latest_path.exists()
    assert latest_meta.exists()

    with artifact_path.open("rb") as handle:
        artifact = pickle.load(handle)
    with latest_path.open("rb") as handle:
        latest_artifact = pickle.load(handle)
    assert "prototypes" in artifact
    assert artifact["schema"] == "https://onecare/features/acuity/v1"
    assert latest_artifact == artifact

    metadata = json.loads(metadata_path.read_text())
    latest_metadata = json.loads(latest_meta.read_text())
    assert metadata["calibration"]["temperature"] > 0
    assert 0 <= metadata["calibration"]["threshold"] <= 1
    assert metadata["modelVersion"] == "9.9.9"
    assert latest_metadata["modelVersion"] == "9.9.9"
