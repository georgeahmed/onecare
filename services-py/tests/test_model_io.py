import pytest

from common.model_io import (
    load_model_artifact,
    save_model_artifact,
)


def test_save_and_load_versioned_artifact(tmp_path):
    artifact_v1 = {"payload": "first"}
    metadata_v1 = {"notes": "initial"}

    path_v1 = save_model_artifact(
        "acuity",
        "0.1.0",
        artifact_v1,
        metadata_v1,
        models_dir=tmp_path,
    )

    assert path_v1.name == "acuity-v0.1.0.bin"
    latest_path = tmp_path / "acuity-latest.bin"
    assert latest_path.exists()

    loaded_latest = load_model_artifact("acuity", models_dir=tmp_path)
    assert loaded_latest.version == "0.1.0"
    assert loaded_latest.artifact == artifact_v1
    assert loaded_latest.metadata["modelVersion"] == "0.1.0"
    assert loaded_latest.metadata["notes"] == "initial"

    artifact_v2 = {"payload": "second"}
    metadata_v2 = {"notes": "next"}

    save_model_artifact(
        "acuity",
        "0.2.0",
        artifact_v2,
        metadata_v2,
        models_dir=tmp_path,
    )

    latest_path = tmp_path / "acuity-latest.bin"
    assert latest_path.exists()

    latest_data = load_model_artifact("acuity", models_dir=tmp_path)
    assert latest_data.version == "0.2.0"
    assert latest_data.artifact == artifact_v2
    assert latest_data.metadata["notes"] == "next"

    previous = load_model_artifact("acuity", version="0.1.0", models_dir=tmp_path)
    assert previous.version == "0.1.0"
    assert previous.artifact == artifact_v1


def test_load_missing_artifact_raises(tmp_path):
    missing_dir = tmp_path / "missing"
    with pytest.raises(FileNotFoundError):
        load_model_artifact("nonexistent", models_dir=missing_dir)
    assert not missing_dir.exists()


def test_metadata_latest_fallback(tmp_path):
    artifact = {"payload": "only"}
    save_model_artifact("acuity", "1.0.0", artifact, {}, models_dir=tmp_path)

    # Remove version-specific metadata to exercise latest fallback path.
    version_meta = tmp_path / "acuity-v1.0.0.meta.json"
    version_meta.unlink()

    loaded = load_model_artifact("acuity", version="1.0.0", models_dir=tmp_path)
    assert loaded.metadata["modelVersion"] == "1.0.0"
