"""
Minimal OTEL-inspired helpers used by dev services.

The goal is to expose a light abstraction that can later be swapped with real
OpenTelemetry exporters while keeping current services lightweight.
"""

from __future__ import annotations

import logging
import os
import time
from contextlib import contextmanager
from typing import TYPE_CHECKING, Any, Callable, Dict, Generator, Optional

if TYPE_CHECKING:  # pragma: no cover - import-time hints only
    from fastapi import FastAPI, Request
    from starlette.responses import Response

_LOG = logging.getLogger("onecare.otel")


def _env_enabled() -> bool:
    value = os.getenv("OTEL_ENABLED", "").strip().lower()
    return value in {"1", "true", "yes", "on"}


def is_enabled() -> bool:
    """Return whether lightweight instrumentation should emit telemetry."""
    return _env_enabled()


@contextmanager
def span(name: str, attributes: Optional[Dict[str, Any]] = None) -> Generator[None, None, None]:
    """Record a simplified span lifecycle."""
    if not is_enabled():
        yield
        return

    attrs = attributes or {}
    start_time = time.perf_counter()
    _LOG.info("span.start name=%s attrs=%s", name, attrs)
    error: Optional[BaseException] = None

    try:
        yield
    except BaseException as exc:  # pragma: no cover - re-raised
        error = exc
        _LOG.exception("span.error name=%s attrs=%s error=%s", name, attrs, exc.__class__.__name__)
        raise
    finally:
        duration_ms = (time.perf_counter() - start_time) * 1000
        status = "error" if error else "ok"
        _LOG.info(
            "span.finish name=%s duration_ms=%.2f status=%s attrs=%s",
            name,
            duration_ms,
            status,
            attrs,
        )


def record_duration(metric_name: str, duration_ms: float, attributes: Optional[Dict[str, Any]] = None, error: Optional[BaseException] = None) -> None:
    """Emit a duration metric (currently logged)."""
    if not is_enabled():
        return

    attrs = attributes or {}
    status = "error" if error else "ok"
    _LOG.info(
        "metric %s duration_ms=%.2f status=%s attrs=%s",
        metric_name,
        duration_ms,
        status,
        attrs,
    )


def instrument_fastapi(app: "FastAPI") -> None:
    """Attach simple instrumentation middleware to a FastAPI app."""

    @app.middleware("http")
    async def _otel_middleware(request: "Request", call_next: Callable[..., "Response"]) -> "Response":
        route = request.url.path
        method = request.method
        enabled = is_enabled()

        attrs = {"route": route, "method": method}
        start = time.perf_counter()
        response: Optional["Response"] = None
        error: Optional[BaseException] = None

        try:
            if enabled:
                with span("http.server.request", attrs):
                    response = await call_next(request)
            else:
                response = await call_next(request)
            return response
        except BaseException as exc:  # pragma: no cover - propagated
            error = exc
            raise
        finally:
            if enabled:
                duration_ms = (time.perf_counter() - start) * 1000
                metric_attrs = dict(attrs)
                metric_attrs["status_code"] = str(getattr(response, "status_code", "error"))
                record_duration("http.server.duration_ms", duration_ms, metric_attrs, error=error)
