from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

_DEFAULT_DATASET = Path(__file__).resolve().parent / "data" / "safety_samples.jsonl"


@dataclass
class SafetySample:
    """Represents a single curated safety sample."""

    text: str
    red_flag_labels: list[str]
    emergency: bool


def load_safety_samples(dataset_path: Path | None = None) -> list[SafetySample]:
    """
    Load curated JSONL samples for test fixtures or local experimentation.

    Parameters
    ----------
    dataset_path:
        Optional override path; defaults to the canonical dataset packaged with the service.

    Returns
    -------
    list[SafetySample]
        Parsed samples; raises FileNotFoundError if the dataset is missing.
    """

    path = dataset_path or _DEFAULT_DATASET
    samples: list[SafetySample] = []

    with path.open(encoding="utf-8") as handle:
        for raw_line in handle:
            line = raw_line.strip()
            if not line:
                continue
            record = json.loads(line)
            samples.append(
                SafetySample(
                    text=record["text"],
                    red_flag_labels=sorted(record.get("red_flag_labels", [])),
                    emergency=bool(record["emergency"]),
                )
            )

    return samples
