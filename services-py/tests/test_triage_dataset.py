from __future__ import annotations

import json
import hashlib
from pathlib import Path

from triage_dataset.builder import DatasetBuildConfig, build_dataset
from triage_dataset.sanitizers import SanitizerConfig, build_row_sanitizer


def test_build_dataset_with_sanitizer(tmp_path: Path) -> None:
    config = DatasetBuildConfig(output_dir=tmp_path, dataset_version="vtest")
    sanitizer = build_row_sanitizer(SanitizerConfig(salt="test-salt"))

    submissions = [
        {
            "submissionId": "sub-1",
            "consentScope": "training_allowed",
            "narrative": "Alice called from 07911 123456.",
            "practiceId": "prac-1",
            "patientKey": "patient-1",
            "attachments": [{"contentType": "image/png", "url": "https://example.com/file.png"}],
        },
        {
            "submissionId": "sub-2",
            "consentScope": "opt_out",
            "narrative": "Excluded",
            "practiceId": "prac-2",
        },
    ]
    safety = [
        {
            "submissionId": "sub-1",
            "safetyGateDecision": "DIVERTED",
            "safetyGate": {"decision": "DIVERTED", "redFlags": ["chest_pain"]},
        }
    ]
    clinician = [
        {
            "submissionId": "sub-1",
            "clinicianDisposition": "er_transfer",
            "labels": {"emergency": True},
        }
    ]

    result = build_dataset(
        config=config,
        submissions=submissions,
        safety_gate_records=safety,
        clinician_records=clinician,
        sanitize_row=sanitizer,
        deident_version="deid-1",
        source_ranges={"submissions": "2025-01-01/2025-02-01"},
    )

    dataset_dir = tmp_path / "vtest"
    dataset_file = dataset_dir / "dataset.jsonl"
    manifest_file = dataset_dir / "manifest.json"

    assert dataset_file.exists()
    assert manifest_file.exists()
    assert result.manifest.record_count == 1
    assert result.manifest.consent_scope_breakdown["training_allowed"] == 1
    hashed_practice = hashlib.sha256("test-saltprac-1".encode("utf-8")).hexdigest()
    with dataset_file.open("r", encoding="utf-8") as handle:
        payload = [json.loads(line) for line in handle if line.strip()]
    assert len(payload) == 1
    row = payload[0]
    assert row["practiceIdHashed"] == hashed_practice
    assert "<PHONE>" in row["narrative"]
    assert row["attachments"][0]["url"] == "<REDACTED>"
