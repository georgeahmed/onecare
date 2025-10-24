from __future__ import annotations

import math
import os
import random
import threading
import time
import uuid
from collections import deque
from typing import Deque, Dict, List, Optional, Sequence, Tuple

try:  # pragma: no cover - optional dependency
    from prometheus_client import (
        CollectorRegistry,
        Counter as PromCounter,
        Gauge as PromGauge,
        Histogram as PromHistogram,
        CONTENT_TYPE_LATEST,
        generate_latest,
    )
except ImportError:  # pragma: no cover - fallback when prometheus_client missing
    CollectorRegistry = None  # type: ignore[assignment]
    PromCounter = None  # type: ignore[assignment]
    PromGauge = None  # type: ignore[assignment]
    PromHistogram = None  # type: ignore[assignment]
    generate_latest = None  # type: ignore[assignment]
    CONTENT_TYPE_LATEST = "text/plain; version=0.0.4"


_PROM_REGISTRY: Optional[CollectorRegistry]
if CollectorRegistry is not None:  # pragma: no cover - import guard
    _PROM_REGISTRY = CollectorRegistry()
else:  # pragma: no cover - fallback path
    _PROM_REGISTRY = None

_PROM_REQUEST_COUNTER = (
    PromCounter(
        "safety_gate_requests_total",
        "Count of Safety Gate requests by endpoint and status",
        ["endpoint", "status"],
        registry=_PROM_REGISTRY,
    )
    if PromCounter is not None and _PROM_REGISTRY is not None
    else None
)

_PROM_REQUEST_LATENCY = (
    PromHistogram(
        "safety_gate_request_latency_seconds",
        "Latency of Safety Gate requests in seconds",
        ["endpoint"],
        buckets=(0.05, 0.1, 0.2, 0.4, 0.6, 0.8, 1.0, 1.5, 2.0, 5.0, float("inf")),
        registry=_PROM_REGISTRY,
    )
    if PromHistogram is not None and _PROM_REGISTRY is not None
    else None
)

_PROM_QUEUE_DEPTH = (
    PromGauge(
        "safety_gate_queue_depth",
        "Current depth of the Safety Gate concurrency queue",
        registry=_PROM_REGISTRY,
    )
    if PromGauge is not None and _PROM_REGISTRY is not None
    else None
)


class LatencyMetrics:
    def __init__(self, window_size: int = 256, buckets: Optional[List[float]] = None) -> None:
        self._samples: Deque[float] = deque(maxlen=window_size)
        self._buckets = buckets or [100, 200, 400, 800, 1600, float("inf")]
        self._counts = [0] * len(self._buckets)
        self._count = 0
        self._sum = 0.0
        self._lock = threading.Lock()

    def reset(self) -> None:
        with self._lock:
            self._samples.clear()
            self._counts = [0] * len(self._buckets)
            self._count = 0
            self._sum = 0.0

    def observe(self, value_ms: float) -> dict[str, Optional[float]]:
        with self._lock:
            if self._samples.maxlen is not None and len(self._samples) == self._samples.maxlen:
                self._samples.popleft()
            self._samples.append(value_ms)
            self._sum = float(sum(self._samples))
            self._count = len(self._samples)
            self._counts = [0] * len(self._buckets)
            for sample in self._samples:
                for idx, upper in enumerate(self._buckets):
                    if sample <= upper:
                        self._counts[idx] += 1
                        break
            p50 = _quantile(self._samples, 0.5)
            p95 = _quantile(self._samples, 0.95)
            return {"p50": p50, "p95": p95}

    def render_prometheus(self) -> str:
        with self._lock:
            buckets = list(self._buckets)
            counts = list(self._counts)
            sample_count = self._count
            sample_sum = self._sum
            samples = list(self._samples)

        lines = [
            "# HELP safety_gate_latency_ms Safety Gate analyze latency in milliseconds",
            "# TYPE safety_gate_latency_ms histogram",
        ]

        cumulative = 0
        for upper, count in zip(buckets, counts):
            cumulative += count
            label = "+Inf" if math.isinf(upper) else f"{upper:.0f}"
            lines.append(f'safety_gate_latency_ms_bucket{{le="{label}"}} {cumulative}')

        lines.append(f"safety_gate_latency_ms_count {sample_count}")
        lines.append(f"safety_gate_latency_ms_sum {sample_sum:.6f}")

        p50 = _quantile(samples, 0.5)
        p95 = _quantile(samples, 0.95)
        if p50 is not None:
            lines.append(f"safety_gate_latency_ms_p50 {p50:.6f}")
        if p95 is not None:
            lines.append(f"safety_gate_latency_ms_p95 {p95:.6f}")

        return "\n".join(lines) + "\n"


class HistogramMetric:
    def __init__(self, name: str, help_text: str, buckets: Sequence[float]) -> None:
        unique = sorted(set(float(x) for x in buckets if math.isfinite(x) and x > 0))
        if not unique:
            unique = [1.0]
        self._buckets = unique + [float("inf")]
        self._counts = [0] * len(self._buckets)
        self._count = 0
        self._sum = 0.0
        self._name = name
        self._help = help_text
        self._lock = threading.Lock()

    def observe(self, value: float) -> None:
        if not math.isfinite(value):
            return
        if value < 0:
            value = 0.0
        with self._lock:
            self._count += 1
            self._sum += value
            for idx, upper in enumerate(self._buckets):
                if value <= upper:
                    self._counts[idx] += 1
                    break

    def render(self) -> str:
        with self._lock:
            counts = list(self._counts)
            total = self._count
            summed = self._sum

        lines = [
            f"# HELP {self._name} {self._help}",
            f"# TYPE {self._name} histogram",
        ]
        cumulative = 0
        for upper, count in zip(self._buckets, counts):
            cumulative += count
            label = "+Inf" if math.isinf(upper) else f"{upper:.2f}"
            lines.append(f'{self._name}_bucket{{le="{label}"}} {cumulative}')
        lines.append(f"{self._name}_count {total}")
        lines.append(f"{self._name}_sum {summed:.6f}")
        return "\n".join(lines) + "\n"


class CounterVec:
    def __init__(self, name: str, help_text: str, label: str) -> None:
        self._name = name
        self._help = help_text
        self._label = label
        self._counts: Dict[str, float] = {}
        self._lock = threading.Lock()

    def increment(self, label_value: str, amount: float = 1.0) -> None:
        key = label_value or "unknown"
        with self._lock:
            self._counts[key] = self._counts.get(key, 0.0) + amount

    def render(self) -> str:
        with self._lock:
            items = sorted(self._counts.items())
        lines = [
            f"# HELP {self._name} {self._help}",
            f"# TYPE {self._name} counter",
        ]
        for value, count in items:
            lines.append(f'{self._name}{{{self._label}="{value}"}} {count}')
        return "\n".join(lines) + "\n"


class GaugeMetric:
    def __init__(self, name: str, help_text: str) -> None:
        self._name = name
        self._help = help_text
        self._value = 0.0
        self._lock = threading.Lock()

    def set(self, value: float) -> None:
        with self._lock:
            self._value = value

    def render(self) -> str:
        with self._lock:
            value = self._value
        lines = [
            f"# HELP {self._name} {self._help}",
            f"# TYPE {self._name} gauge",
            f"{self._name} {value}",
        ]
        return "\n".join(lines) + "\n"


class GoldenSampleBuffer:
    def __init__(self, max_samples: int) -> None:
        self._samples: Deque[dict[str, object]] = deque(maxlen=max_samples)
        self._lock = threading.Lock()

    def add(self, sample: dict[str, object]) -> None:
        with self._lock:
            self._samples.append(sample)

    def snapshot(self, reset: bool = False) -> List[dict[str, object]]:
        with self._lock:
            data = list(self._samples)
            if reset:
                self._samples.clear()
        return data

    def render_metric(self, name: str = "safety_gate_golden_samples") -> str:
        with self._lock:
            count = len(self._samples)
        lines = [
            f"# HELP {name} Number of anonymized golden samples retained in memory",
            f"# TYPE {name} gauge",
            f'{name}{{source="anonymized"}} {count}',
        ]
        return "\n".join(lines) + "\n"


def _quantile(values: List[float] | Deque[float], quantile: float) -> Optional[float]:
    if not values:
        return None
    ordered = sorted(values)
    position = quantile * (len(ordered) - 1)
    index = max(0, min(len(ordered) - 1, int(round(position))))
    return float(ordered[index])


def _parse_rate(raw: Optional[str]) -> float:
    if raw is None:
        return 0.0
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return 0.0
    if math.isnan(value):
        return 0.0
    return max(0.0, min(1.0, value))


def _parse_int(raw: Optional[str], default: int) -> int:
    if raw is None:
        return default
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return default
    return max(1, value)


metrics_tracker = LatencyMetrics()
confidence_histogram = HistogramMetric(
    "safety_gate_confidence",
    "Distribution of emergency probability scores",
    [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 1.0],
)
narrative_length_histogram = HistogramMetric(
    "safety_gate_narrative_words",
    "Distribution of narrative word counts",
    [20, 40, 80, 120, 200, 400, 800],
)
red_flag_counter = CounterVec(
    "safety_gate_red_flag_total",
    "Occurrences of red-flag triggers during analysis",
    "flag",
)
decision_counter = CounterVec(
    "safety_gate_decision_total",
    "Decision outcome counts",
    "decision",
)
batch_size_histogram = HistogramMetric(
    "safety_gate_batch_size",
    "Distribution of micro-batch sizes for analyze requests",
    [1, 2, 3, 4, 6, 8, 12, 16],
)
overload_counter = CounterVec(
    "safety_gate_overload_total",
    "Count of Safety Gate overload events",
    "reason",
)
queue_depth_gauge = GaugeMetric(
    "safety_gate_queue_depth",
    "Current Safety Gate concurrency queue depth",
)

_GOLDEN_SAMPLE_RATE = _parse_rate(
    os.getenv("GOLDEN_SAMPLE_RATE") or os.getenv("SAFETY_GATE_GOLDEN_SAMPLE_RATE")
)
_GOLDEN_SAMPLE_BUFFER = _parse_int(os.getenv("GOLDEN_SAMPLE_BUFFER", "128"), 128)
golden_samples = GoldenSampleBuffer(_GOLDEN_SAMPLE_BUFFER)


def _normalize_endpoint(endpoint: Optional[str]) -> str:
    value = (endpoint or "unknown").strip().lower()
    return value or "unknown"


def observe_request_latency(endpoint: Optional[str], latency_ms: float) -> None:
    if _PROM_REQUEST_LATENCY is None:
        return
    if not math.isfinite(latency_ms) or latency_ms < 0:
        return
    _PROM_REQUEST_LATENCY.labels(endpoint=_normalize_endpoint(endpoint)).observe(latency_ms / 1000.0)


def record_request_outcome(endpoint: Optional[str], status: str) -> None:
    if _PROM_REQUEST_COUNTER is None:
        return
    _PROM_REQUEST_COUNTER.labels(
        endpoint=_normalize_endpoint(endpoint),
        status=(status or "unknown").strip().lower() or "unknown",
    ).inc()


def record_latency(latency_ms: float, endpoint: Optional[str] = None) -> dict[str, Optional[float]]:
    observe_request_latency(endpoint, latency_ms)
    return metrics_tracker.observe(latency_ms)


def record_batch_metrics(batch_size: int) -> None:
    if batch_size <= 0:
        return
    batch_size_histogram.observe(float(batch_size))


def record_overload(reason: str) -> None:
    overload_counter.increment(reason)


def update_queue_depth(value: int) -> None:
    queue_depth_gauge.set(float(max(0, value)))
    if _PROM_QUEUE_DEPTH is not None:
        _PROM_QUEUE_DEPTH.set(max(0.0, float(value)))


def record_prediction_metrics(
    *,
    probability: Optional[float],
    narrative: str,
    red_flags: Sequence[str] | None,
    decision: Optional[str],
    symptom_mentions: Sequence[object] | None = None,
) -> None:
    if isinstance(probability, (float, int)):
        confidence_histogram.observe(float(probability))
    word_count = _count_words(narrative)
    narrative_length_histogram.observe(float(word_count))

    normalized_flags = [_sanitize_flag(flag) for flag in red_flags or [] if flag]
    if not normalized_flags:
        red_flag_counter.increment("none")
    else:
        for flag in normalized_flags:
            red_flag_counter.increment(flag)
        red_flag_counter.increment("triggered")

    if decision:
        decision_counter.increment(decision.lower())

    if _GOLDEN_SAMPLE_RATE > 0:
        _maybe_collect_golden_sample(
            probability=probability if isinstance(probability, (float, int)) else None,
            word_count=word_count,
            red_flag_count=len(normalized_flags),
            decision=decision,
            symptom_count=len(symptom_mentions or []),
        )


def _count_words(narrative: str) -> int:
    if not narrative:
        return 0
    return len([word for word in narrative.split() if word])


def _sanitize_flag(flag: str) -> str:
    cleaned = flag.strip().lower().replace(" ", "_")
    return cleaned or "unspecified"


def _maybe_collect_golden_sample(
    *,
    probability: Optional[float],
    word_count: int,
    red_flag_count: int,
    decision: Optional[str],
    symptom_count: int,
) -> None:
    if random.random() > _GOLDEN_SAMPLE_RATE:
        return
    sample = {
        "id": uuid.uuid4().hex,
        "observedAt": int(time.time()),
        "wordCount": word_count,
        "symptomCount": symptom_count,
        "redFlagCount": red_flag_count,
        "decision": (decision or "unknown").lower(),
    }
    if probability is not None:
        sample["probEmergency"] = round(probability, 6)
    golden_samples.add(sample)


def get_golden_samples(reset: bool = False) -> List[dict[str, object]]:
    return golden_samples.snapshot(reset)


def render_metrics() -> str:
    sections = [
        metrics_tracker.render_prometheus(),
        confidence_histogram.render(),
        narrative_length_histogram.render(),
        red_flag_counter.render(),
        decision_counter.render(),
        batch_size_histogram.render(),
        overload_counter.render(),
        queue_depth_gauge.render(),
        golden_samples.render_metric(),
    ]
    return "".join(sections)


def render_prometheus_metrics() -> Optional[Tuple[bytes, str]]:
    if _PROM_REGISTRY is None or generate_latest is None:
        return None
    try:
        payload = generate_latest(_PROM_REGISTRY)
    except Exception:  # pragma: no cover - defensive guard
        return None
    return payload, CONTENT_TYPE_LATEST
