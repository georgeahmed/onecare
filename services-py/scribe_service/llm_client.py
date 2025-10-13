from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Optional

from .token_utils import truncate_to_tokens

DEFAULT_MODEL = "gpt-4o"
DEFAULT_ENDPOINT = "https://api.openai.com/v1"
ENV_MODEL = "LLM_MODEL"
ENV_API_KEY = "LLM_API_KEY"
ENV_ENDPOINT = "LLM_API_ENDPOINT"
FALLBACK_MODEL_ENV = "SCRIBE_LLM_MODEL"
FALLBACK_API_KEY_ENV = "SCRIBE_LLM_API_KEY"
FALLBACK_ENDPOINT_ENV = "SCRIBE_LLM_ENDPOINT"


def _read_env(name: str) -> Optional[str]:
    value = os.getenv(name)
    if value is None:
        return None
    stripped = value.strip()
    return stripped or None


@dataclass(frozen=True)
class SummaryLLM:
    model_name: str
    api_key: str
    endpoint: str = DEFAULT_ENDPOINT
    system_prompt: str = ""
    user_prompt: str = ""

    @classmethod
    def from_env(cls) -> "SummaryLLM":
        model = (
            _read_env(ENV_MODEL)
            or _read_env(FALLBACK_MODEL_ENV)
            or DEFAULT_MODEL
        )
        api_key = _read_env(ENV_API_KEY) or _read_env(FALLBACK_API_KEY_ENV)
        if not api_key:
            raise RuntimeError("LLM_API_KEY environment variable is required")
        endpoint = (
            _read_env(ENV_ENDPOINT)
            or _read_env(FALLBACK_ENDPOINT_ENV)
            or DEFAULT_ENDPOINT
        )
        system_prompt = _load_template(SYSTEM_PROMPT_FILE)
        user_prompt = _load_template(USER_PROMPT_FILE)
        return cls(model_name=model, api_key=api_key, endpoint=endpoint, system_prompt=system_prompt, user_prompt=user_prompt)

    def summarize(
        self,
        transcript: str,
        *,
        max_tokens: int = 512,
        encounter_id: str | None = None,
        patient_name: str | None = None,
    ) -> str:
        """
        Produce a deterministic summary stub. The real implementation would invoke the configured LLM.

        Parameters
        ----------
        transcript:
            Input transcript text.
        max_tokens:
            Upper bound on tokens for downstream calls (unused in stub, but recorded for traceability).
        """

        context = {
            "encounter_id": encounter_id or "unknown",
            "patient_name": patient_name or "Unknown",
            "transcript": transcript.strip() if transcript else "",
        }
        context["transcript"] = truncate_to_tokens(context["transcript"], max_tokens)
        user_prompt = render_template(self.user_prompt, context)
        user_prompt = truncate_to_tokens(user_prompt, max_tokens)

        source = user_prompt.strip()
        if not source:
            return f"[summary:{self.model_name}] (empty transcript)"

        truncated = truncate_to_tokens(source, max_tokens)
        return f"[summary:{self.model_name}:tokens<={max_tokens}] {truncated}"


def _load_template(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8").strip()
    except FileNotFoundError as exc:
        raise TemplateError(f"Template not found: {path}") from exc


def render_template(template: str, context: Dict[str, Any]) -> str:
    result = template
    for key, value in context.items():
        placeholder = f"{{{{ {key} }}}}"
        fallback = (
            "{{ " + key + " or \"Unknown\" }}"  # handle default placeholder from template
        )
        replacement = str(value)
        result = result.replace(placeholder, replacement)
        result = result.replace(fallback, replacement)
    return result


__all__ = ["SummaryLLM"]
TEMPLATES_DIR = Path(__file__).resolve().parent / "templates"
SYSTEM_PROMPT_FILE = TEMPLATES_DIR / "system_prompt.txt"
USER_PROMPT_FILE = TEMPLATES_DIR / "user_prompt.txt"


class TemplateError(RuntimeError):
    pass
