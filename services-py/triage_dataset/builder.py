from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Dict, Iterable, List, Mapping, MutableMapping, Sequence

SubmissionRecord = Mapping[str, object]
SafetyGateRecord = Mapping[str, object]
ClinicianRecord = Mapping[str, object]
RowSanitizer = Callable[[Mapping[str, object]], Mapping[str, object]]


@dataclass
class DatasetBuildConfig:
    output_dir: Path
    dataset_version: str
    consent_scope_allowed: Sequence[str] = field(default_factory=lambda: ["training_allowed"])
    manifest_filename: str = "manifest.json"
    dataset_filename: str = "dataset.jsonl"
    overwrite: bool = False

    def ensure_output_dir(self) -> Path:
        if self.output_dir.exists() and not self.output_dir.is_dir():
            raise ValueError(f"output path {self.output_dir} is not a directory")
        if not self.output_dir.exists():
            self.output_dir.mkdir(parents=True, exist_ok=True)
        version_dir = self.output_dir / self.dataset_version
        if version_dir.exists():
            if not version_dir.is_dir():
                raise ValueError(f"dataset version path {version_dir} is not a directory")
            if any(version_dir.iterdir()) and not self.overwrite:
                raise FileExistsError(f"dataset version {self.dataset_version} already exists")
        else:
            version_dir.mkdir(parents=True, exist_ok=True)
        return version_dir


@dataclass
class DatasetManifest:
    dataset_version: str
    record_count: int
    extraction_started_at: str
    extraction_finished_at: str
    emergency_positive_rate: float
    consent_scope_breakdown: Dict[str, int]
    source_ranges: Dict[str, str]
    deident_version: str

    def to_dict(self) -> Dict[str, object]:
        return {
            "datasetVersion": self.dataset_version,
            "recordCount": self.record_count,
            "extractionStartedAt": self.extraction_started_at,
            "extractionFinishedAt": self.extraction_finished_at,
            "emergencyPositiveRate": self.emergency_positive_rate,
            "consentScopeBreakdown": self.consent_scope_breakdown,
            "sourceRanges": self.source_ranges,
            "deidentVersion": self.deident_version,
        }


@dataclass
class DatasetBuildResult:
    rows: List[Dict[str, object]]
    manifest: DatasetManifest
    output_path: Path


def build_dataset(
    *,
    config: DatasetBuildConfig,
    submissions: Iterable[SubmissionRecord],
    safety_gate_records: Iterable[SafetyGateRecord],
    clinician_records: Iterable[ClinicianRecord],
    sanitize_row: RowSanitizer,
    deident_version: str,
    source_ranges: Mapping[str, str],
) -> DatasetBuildResult:
    start = _now()
    version_dir = config.ensure_output_dir()

    safety_index = _build_index(safety_gate_records, "submissionId")
    clinician_index = _build_index(clinician_records, "submissionId")

    allowed_scopes = set(config.consent_scope_allowed)
    dataset_rows: List[Dict[str, object]] = []
    consent_counts: MutableMapping[str, int] = {}
    emergency_positive = 0

    for raw in submissions:
        submission_id = _require_str(raw, "submissionId")
        consent = _require_str(raw, "consentScope")
        consent_counts[consent] = consent_counts.get(consent, 0) + 1
        if consent not in allowed_scopes:
            continue
        merged = dict(raw)
        merged.update(safety_index.get(submission_id, {}))
        merged.update(clinician_index.get(submission_id, {}))
        sanitized = sanitize_row(merged)
        dataset_rows.append(dict(sanitized))
        label_container = sanitized.get("labels")
        if isinstance(label_container, Mapping) and bool(label_container.get("emergency")):
            emergency_positive += 1

    end = _now()

    manifest = DatasetManifest(
        dataset_version=config.dataset_version,
        record_count=len(dataset_rows),
        extraction_started_at=start,
        extraction_finished_at=end,
        emergency_positive_rate=_ratio(emergency_positive, len(dataset_rows)),
        consent_scope_breakdown=dict(sorted(consent_counts.items())),
        source_ranges=dict(source_ranges),
        deident_version=deident_version,
    )

    dataset_path = version_dir / config.dataset_filename
    manifest_path = version_dir / config.manifest_filename

    _write_jsonl(dataset_path, dataset_rows, overwrite=config.overwrite)
    _write_json(manifest_path, manifest.to_dict(), overwrite=config.overwrite)

    return DatasetBuildResult(rows=dataset_rows, manifest=manifest, output_path=version_dir)


def _build_index(records: Iterable[Mapping[str, object]], key: str) -> Dict[str, Dict[str, object]]:
    index: Dict[str, Dict[str, object]] = {}
    for record in records:
        value = record.get(key)
        if isinstance(value, str):
            index[value] = dict(record)
    return index


def _write_jsonl(path: Path, rows: Sequence[Mapping[str, object]], *, overwrite: bool) -> None:
    if path.exists() and not overwrite:
        raise FileExistsError(f"dataset file {path} already exists")
    with path.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, separators=(",", ":")))
            handle.write("\n")


def _write_json(path: Path, payload: Mapping[str, object], *, overwrite: bool) -> None:
    if path.exists() and not overwrite:
        raise FileExistsError(f"manifest file {path} already exists")
    with path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, sort_keys=True)
        handle.write("\n")


def _require_str(payload: Mapping[str, object], key: str) -> str:
    value = payload.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"missing or invalid {key}")
    return value


def _ratio(numerator: int, denominator: int) -> float:
    if denominator <= 0:
        return 0.0
    return round(numerator / denominator, 6)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()

