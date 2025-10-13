from __future__ import annotations

import math
import threading
from collections import deque
from typing import Deque, List, Optional


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
            self._samples.append(value_ms)
            self._count += 1
            self._sum += value_ms
            for idx, upper in enumerate(self._buckets):
                if value_ms <= upper:
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


def _quantile(values: List[float] | Deque[float], quantile: float) -> Optional[float]:
    if not values:
        return None
    ordered = sorted(values)
    position = quantile * (len(ordered) - 1)
    index = max(0, min(len(ordered) - 1, int(round(position))))
    return float(ordered[index])


metrics_tracker = LatencyMetrics()


def record_latency(latency_ms: float) -> dict[str, Optional[float]]:
    return metrics_tracker.observe(latency_ms)


def render_metrics() -> str:
    return metrics_tracker.render_prometheus()
