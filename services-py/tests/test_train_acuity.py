from pathlib import Path
import pickle

from train_acuity import MODEL_PATH, METRICS_PATH, TRAINING_DATA_PATH, main


def test_train_acuity_creates_artifacts(tmp_path, monkeypatch):
    monkeypatch.chdir(Path(__file__).resolve().parents[1])
    if MODEL_PATH.exists():
        MODEL_PATH.unlink()
    if METRICS_PATH.exists():
        METRICS_PATH.unlink()
    if TRAINING_DATA_PATH.exists():
        TRAINING_DATA_PATH.unlink()

    main()

    assert MODEL_PATH.exists()
    assert METRICS_PATH.exists()
    assert TRAINING_DATA_PATH.exists()

    with MODEL_PATH.open("rb") as handle:
        artifact = pickle.load(handle)
    assert "prototypes" in artifact
    assert artifact["schema"] == "https://onecare/features/acuity/v1"
