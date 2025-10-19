from __future__ import annotations

import ipaddress
import os
from collections.abc import AsyncIterator
from typing import Any, Optional
from contextlib import asynccontextmanager
from urllib.parse import urlparse

from fastapi import Depends, FastAPI, HTTPException
from pydantic import BaseModel, Field
from common.contracts.models import ScribeAudio
from common.otel import instrument_fastapi
from common.security import AuthzContext, require_service_auth
from .asr_runner import load_model, transcribe as run_transcription
from .audio_store import create_audio_store
from .quality import evaluate_quality
from .llm_client import SummaryLLM
from .postprocess import highlight_uncertainty

_ALLOWED_AUDIO_SCHEMES = {"https", "s3"}


def _audio_validation_error(reason: str) -> HTTPException:
    return HTTPException(
        status_code=400,
        detail={
            "error": {
                "code": "invalid_input",
                "message": "Invalid audio reference",
                "details": {"reason": reason},
            }
        },
    )


def _is_private_host(host: str) -> bool:
    lowered = host.lower()
    if lowered == "localhost" or lowered.endswith(".local"):
        return True
    try:
        addr = ipaddress.ip_address(host)
    except ValueError:
        return False
    return addr.is_private or addr.is_loopback or addr.is_link_local or addr.is_reserved


def _sanitize_audio_request(audio: ScribeAudio) -> dict[str, Any]:
    encounter_id = (audio.encounterId or "").strip()
    if not encounter_id:
        raise _audio_validation_error("missing_encounter_id")

    raw_url = str(audio.audioUrl).strip()
    if not raw_url:
        raise _audio_validation_error("missing_audio_url")
    try:
        parsed = urlparse(raw_url)
    except ValueError:
        raise _audio_validation_error("invalid_audio_url")

    if parsed.scheme not in _ALLOWED_AUDIO_SCHEMES:
        raise _audio_validation_error("unsupported_scheme")
    if parsed.scheme == "https":
        host = parsed.hostname
        if not host:
            raise _audio_validation_error("missing_hostname")
        if parsed.username or parsed.password:
            raise _audio_validation_error("credentials_not_allowed")
        if _is_private_host(host):
            raise _audio_validation_error("private_host")
    elif parsed.scheme == "s3":
        if not parsed.netloc:
            raise _audio_validation_error("missing_bucket")
        object_path = parsed.path or ""
        if not object_path or object_path == "/":
            raise _audio_validation_error("missing_object_key")

    normalized_url = parsed.geturl()
    if len(normalized_url) > 2048:
        raise _audio_validation_error("url_too_long")

    content_type = str(audio.contentType or "").strip()
    if not content_type.lower().startswith("audio/"):
        raise _audio_validation_error("invalid_content_type")

    return {
        "encounterId": encounter_id,
        "audioUrl": normalized_url,
        "contentType": content_type,
        "diarization": audio.diarization,
    }


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    # Initialize transcription resources before serving traffic.
    app.state.model_ready = False
    app.state.asr_model = load_model()
    app.state.audio_store = create_audio_store()
    app.state.llm_client = None
    app.state.model_ready = True
    try:
        yield
    finally:
        app.state.model_ready = False
        app.state.asr_model = None
        app.state.audio_store = None
        app.state.llm_client = None


app = FastAPI(title="Scribe Service", version="0.1.0", lifespan=lifespan)
instrument_fastapi(app)


_TRANSCRIBE_AUTH = require_service_auth(env_var="SCRIBE_SERVICE_API_KEY", required_scope="scribe:transcribe")
_DRAFT_AUTH = require_service_auth(env_var="SCRIBE_SERVICE_API_KEY", required_scope="scribe:draft")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/ready")
def ready() -> dict[str, str]:
    if getattr(app.state, "model_ready", False):
        return {"status": "ready"}
    raise HTTPException(status_code=503, detail={"status": "not_ready"})


class TranscriptQuality(BaseModel):
    lowConfidence: bool
    silenceDetected: bool
    notes: list[str] = Field(default_factory=list)


class Transcript(BaseModel):
    text: str
    quality: Optional[TranscriptQuality] = None


class Draft(BaseModel):
    summary: str
    approved: bool = True


@app.post("/transcribe", response_model=Transcript)
def transcribe(audio: ScribeAudio, _auth: AuthzContext = Depends(_TRANSCRIBE_AUTH)) -> Transcript:
    model = getattr(app.state, "asr_model", None)
    if model is None:
        model = load_model()

    sanitized = _sanitize_audio_request(audio)

    audio_payload = {
        "url": sanitized["audioUrl"],
        "audioUrl": sanitized["audioUrl"],
        "encounterId": sanitized["encounterId"],
    }
    if sanitized["diarization"] is not None:
        audio_payload["diarization"] = sanitized["diarization"]

    result = run_transcription(audio_payload, model=model)
    store = getattr(app.state, "audio_store", None)
    if store is not None:
        store.record(encounter_id=sanitized["encounterId"], audio_url=sanitized["audioUrl"])
    quality = evaluate_quality(
        result.text,
        chunk_texts=[chunk.text for chunk in result.chunks],
    )
    return Transcript(
        text=result.text,
        quality=TranscriptQuality(
            lowConfidence=quality.low_confidence,
            silenceDetected=quality.silence_detected,
            notes=list(quality.notes),
        ),
    )


@app.post("/draft", response_model=Draft)
def draft(transcript: Transcript, _auth: AuthzContext = Depends(_DRAFT_AUTH)) -> Draft:
    client = _get_llm_client()
    max_tokens = _resolve_max_summary_tokens()
    summary_text = client.summarize(
        transcript.text,
        max_tokens=max_tokens,
    )
    postprocessed = highlight_uncertainty(summary_text, max_tokens=max_tokens)
    approved = not _require_clinician_approval()
    return Draft(summary=postprocessed, approved=approved)


def _get_llm_client() -> SummaryLLM:
    client = getattr(app.state, "llm_client", None)
    if client is None:
        try:
            client = SummaryLLM.from_env()
        except Exception as exc:  # noqa: BLE001 - surface to HTTP layer
            raise HTTPException(
                status_code=503,
                detail={"status": "llm_unavailable", "reason": "missing_or_invalid_configuration"},
            ) from exc
        app.state.llm_client = client
    return client


def _resolve_max_summary_tokens() -> int:
    candidates = [
        os.getenv("SUMMARY_MAX_TOKENS"),
        os.getenv("SCRIBE_SUMMARY_MAX_TOKENS"),
    ]
    for value in candidates:
        if not value:
            continue
        try:
            parsed = int(str(value).strip())
            if parsed > 0:
                return parsed
        except ValueError:
            continue
    return 512


def _require_clinician_approval() -> bool:
    candidates = [
        os.getenv("REQUIRE_CLINICIAN_APPROVAL"),
        os.getenv("SCRIBE_REQUIRE_CLINICIAN_APPROVAL"),
    ]
    for value in candidates:
        if value is None:
            continue
        lowered = value.strip().lower()
        if lowered in {"1", "true", "yes", "on"}:
            return True
        if lowered in {"0", "false", "no", "off"}:
            return False
    # default true to align with config/nhs_gp_defaults.yaml
    return True
