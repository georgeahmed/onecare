from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, List, Mapping, MutableMapping, Sequence
import os

try:
    import boto3  # type: ignore
except Exception:  # pragma: no cover - optional dependency
    boto3 = None


try:
    import yaml  # type: ignore
except Exception:  # pragma: no cover - optional dependency
    yaml = None


class SourceConfigError(RuntimeError):
    pass


@dataclass
class SourceEntry:
    type: str
    path: str | None = None
    glob: str | None = None
    bucket: str | None = None
    prefix: str | None = None


def load_source_config(path: Path) -> Mapping[str, Sequence[SourceEntry]]:
    if not path.exists():
        raise SourceConfigError(f"source config {path} does not exist")
    if path.suffix.lower() in {".yaml", ".yml"}:
        if yaml is None:
            raise SourceConfigError("PyYAML not installed; cannot parse YAML config")
        with path.open("r", encoding="utf-8") as handle:
            data = yaml.safe_load(handle)
    else:
        with path.open("r", encoding="utf-8") as handle:
            data = json.load(handle)
    if not isinstance(data, Mapping):
        raise SourceConfigError("source config must be an object")
    result: MutableMapping[str, List[SourceEntry]] = {}
    for key, value in data.items():
        if not isinstance(value, Iterable):
            raise SourceConfigError(f"source config entry {key} must be a list")
        entries: List[SourceEntry] = []
        for raw in value:
            if not isinstance(raw, Mapping):
                continue
            entry_type = str(raw.get("type" or "kind") or "local").strip().lower()
            if entry_type not in {"local", "s3"}:
                raise SourceConfigError(f"unsupported source type {entry_type}")
            entry = SourceEntry(type=entry_type)
            if entry_type == "local":
                entry.path = _as_optional_str(raw.get("path"))
                entry.glob = _as_optional_str(raw.get("glob"))
                if not entry.path and not entry.glob:
                    raise SourceConfigError("local source requires path or glob")
            else:
                entry.bucket = _require_str(raw, "bucket")
                entry.prefix = _as_optional_str(raw.get("prefix")) or ""
            entries.append(entry)
        result[key] = entries
    return result


def resolve_source_paths(
    entries: Sequence[SourceEntry],
    *,
    scratch_dir: Path,
    label: str,
) -> List[Path]:
    resolved: List[Path] = []
    scratch_dir.mkdir(parents=True, exist_ok=True)
    for entry in entries:
        if entry.type == "local":
            if entry.path:
                resolved.extend(_expand_local_path(entry.path))
            if entry.glob:
                resolved.extend(_expand_local_glob(entry.glob))
        elif entry.type == "s3":
            if boto3 is None:
                raise SourceConfigError("boto3 is required to download from S3")
            bucket = entry.bucket or ""
            prefix = entry.prefix or ""
            target_dir = scratch_dir / label / bucket / prefix.replace("/", "_")
            target_dir.mkdir(parents=True, exist_ok=True)
            _download_s3_prefix(boto3, bucket, prefix, target_dir)
            resolved.extend(sorted(target_dir.glob("*.jsonl")))
    return resolved


def _expand_local_path(spec: str) -> List[Path]:
    expanded = os.path.expandvars(spec)
    path = Path(expanded).expanduser()
    if path.is_dir():
        return sorted(path.glob("*.jsonl"))
    if path.exists():
        return [path]
    return []


def _expand_local_glob(pattern: str) -> List[Path]:
    expanded = os.path.expandvars(pattern)
    path = Path(expanded).expanduser()
    base = path.parent
    if not base.exists():
        return []
    return sorted(base.glob(path.name))


def _download_s3_prefix(boto3_module, bucket: str, prefix: str, target_dir: Path) -> None:
    client = boto3_module.client("s3")
    paginator = client.get_paginator("list_objects_v2")
    kwargs = {"Bucket": bucket}
    if prefix:
        kwargs["Prefix"] = prefix
    for page in paginator.paginate(**kwargs):  # pragma: no cover - depends on AWS
        contents = page.get("Contents", [])
        for obj in contents:
            key = obj.get("Key")
            if not isinstance(key, str) or not key.endswith(".jsonl"):
                continue
            filename = key.split("/")[-1]
            destination = target_dir / filename
            client.download_file(bucket, key, str(destination))


def _require_str(mapping: Mapping[str, object], key: str) -> str:
    value = mapping.get(key)
    if not isinstance(value, str) or not value.strip():
        raise SourceConfigError(f"missing {key}")
    return value.strip()


def _as_optional_str(value: object) -> str | None:
    if isinstance(value, str):
        trimmed = os.path.expandvars(value.strip())
        return trimmed or None
    return None
