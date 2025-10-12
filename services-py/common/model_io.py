from __future__ import annotations

import json
import os
import pickle
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Optional, Sequence, Tuple

_DEFAULT_MODELS_DIR = Path(__file__).resolve().parents[1] / "models"
_ARTIFACT_SUFFIX = "bin"
_META_SUFFIX = "meta.json"


@dataclass(frozen=True)
class ModelArtifact:
    """Represents a loaded model artifact along with metadata and resolved version."""

    artifact: Any
    metadata: Mapping[str, Any]
    version: str


def save_model_artifact(
    model_name: str,
    version: str,
    artifact: Any,
    metadata: Mapping[str, Any] | None = None,
    *,
    models_dir: Path | str | None = None,
) -> Path:
    """
    Persist a model artifact with semantic versioning and maintain a latest pointer.

    Parameters
    ----------
    model_name:
        Logical name for the artifact (e.g., "acuity").
    version:
        Semantic version string (e.g., "0.1.0").
    artifact:
        Serializable payload to persist; pickled to disk.
    metadata:
        Optional metadata mapping stored as JSON; `modelVersion` is enforced.
    models_dir:
        Directory where the artifact should be written. Defaults to services-py/models.
    """

    directory = _ensure_directory(models_dir)
    artifact_filename = _versioned_filename(model_name, version, _ARTIFACT_SUFFIX)
    artifact_path = directory / artifact_filename

    with artifact_path.open("wb") as handle:
        pickle.dump(artifact, handle)

    metadata_payload = dict(metadata or {})
    metadata_payload.setdefault("modelVersion", version)
    metadata_filename = _versioned_filename(model_name, version, _META_SUFFIX)
    metadata_path = directory / metadata_filename
    metadata_path.write_text(json.dumps(metadata_payload, indent=2, sort_keys=True), encoding="utf-8")

    _point_latest(directory, model_name, artifact_path, metadata_path)
    return artifact_path


def load_model_artifact(
    model_name: str,
    *,
    version: Optional[str] = None,
    models_dir: Path | str | None = None,
) -> ModelArtifact:
    """
    Load a versioned model artifact and its metadata.

    Parameters
    ----------
    model_name:
        Logical name for the artifact (e.g., "acuity").
    version:
        Optional semantic version. If omitted, the latest pointer or highest available version is used.
    models_dir:
        Directory to inspect. Defaults to services-py/models.
    """

    directory = _ensure_directory(models_dir, ensure_exists=True)
    artifact_path, resolved_version = _resolve_artifact_path(directory, model_name, version)
    metadata = _read_metadata(directory, model_name, resolved_version)

    with artifact_path.open("rb") as handle:
        payload = pickle.load(handle)

    return ModelArtifact(artifact=payload, metadata=metadata, version=resolved_version)


def _ensure_directory(path: Path | str | None, ensure_exists: bool = False) -> Path:
    directory = Path(path) if path is not None else _DEFAULT_MODELS_DIR
    if ensure_exists and not directory.exists():
        raise FileNotFoundError(f"Models directory not found: {directory}")
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def _versioned_filename(model_name: str, version: str, suffix: str) -> str:
    if not version:
        raise ValueError("version must be a non-empty string")
    if suffix.startswith("."):
        suffix = suffix[1:]
    return f"{model_name}-v{version}.{suffix}"


def _point_latest(directory: Path, model_name: str, artifact_path: Path, metadata_path: Path) -> None:
    artifact_link = directory / f"{model_name}-latest.{_ARTIFACT_SUFFIX}"
    metadata_link = directory / f"{model_name}-latest.{_META_SUFFIX}"
    _create_symlink(artifact_link, artifact_path)
    _create_symlink(metadata_link, metadata_path)


def _create_symlink(link_path: Path, target_path: Path) -> None:
    if link_path.exists() or link_path.is_symlink():
        link_path.unlink()
    try:
        # Use relative targets to keep artifacts portable.
        link_path.symlink_to(target_path.name)
    except OSError:
        shutil.copy2(target_path, link_path)


def _resolve_artifact_path(directory: Path, model_name: str, version: Optional[str]) -> Tuple[Path, str]:
    if version:
        candidate = directory / _versioned_filename(model_name, version, _ARTIFACT_SUFFIX)
        if not candidate.exists():
            raise FileNotFoundError(f"Artifact {candidate} not found")
        return candidate, version

    latest = directory / f"{model_name}-latest.{_ARTIFACT_SUFFIX}"
    if latest.exists():
        resolved = latest.resolve() if latest.is_symlink() else latest
        resolved_version = _extract_version(resolved.name, model_name)
        if not resolved_version:
            resolved_version = _extract_version(latest.name, model_name)
        return resolved, resolved_version or "unknown"

    available = sorted(directory.glob(f"{model_name}-v*.{_ARTIFACT_SUFFIX}"))
    if not available:
        raise FileNotFoundError(f"No artifacts found for {model_name} in {directory}")
    selected = max(available, key=lambda path: _version_sort_key(_extract_version(path.name, model_name) or "0"))
    resolved_version = _extract_version(selected.name, model_name) or "unknown"
    return selected, resolved_version


def _read_metadata(directory: Path, model_name: str, version: str) -> Mapping[str, Any]:
    candidates = [
        directory / _versioned_filename(model_name, version, _META_SUFFIX),
        directory / f"{model_name}-latest.{_META_SUFFIX}",
    ]
    for candidate in candidates:
        if candidate.exists():
            content = candidate.read_text(encoding="utf-8")
            data = json.loads(content) if content.strip() else {}
            data.setdefault("modelVersion", version)
            return data
    return {"modelVersion": version}


def _extract_version(filename: str, model_name: str) -> Optional[str]:
    prefix = f"{model_name}-v"
    suffix = f".{_ARTIFACT_SUFFIX}"
    if filename.startswith(prefix) and filename.endswith(suffix):
        return filename[len(prefix) : -len(suffix)]
    return None


def _version_sort_key(version: str) -> Sequence[Any]:
    components = []
    for part in version.replace("-", ".").split("."):
        if part.isdigit():
            components.append(int(part))
        else:
            components.append(part)
    return components


__all__ = ["ModelArtifact", "save_model_artifact", "load_model_artifact"]

