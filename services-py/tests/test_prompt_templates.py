from pathlib import Path

from scribe_service.llm_client import SummaryLLM, render_template


def test_system_and_user_template_loaded(monkeypatch, tmp_path):
    system_path = tmp_path / "system.txt"
    user_path = tmp_path / "user.txt"
    system_path.write_text("System prompt content", encoding="utf-8")
    user_path.write_text("Encounter {{ encounter_id }}", encoding="utf-8")

    monkeypatch.setattr("scribe_service.llm_client.SYSTEM_PROMPT_FILE", system_path)
    monkeypatch.setattr("scribe_service.llm_client.USER_PROMPT_FILE", user_path)
    monkeypatch.setenv("LLM_API_KEY", "key")
    monkeypatch.setenv("LLM_MODEL", "model")

    client = SummaryLLM.from_env()

    assert client.system_prompt == "System prompt content"
    assert client.user_prompt == "Encounter {{ encounter_id }}"

    output = client.summarize("Transcript text", encounter_id="enc-1", patient_name="Alice")
    assert "[summary:model" in output
    assert "Encounter enc-1" in output


def test_render_template_handles_defaults():
    template = "Patient: {{ patient_name or \"Unknown\" }}"
    rendered = render_template(template, {"patient_name": "Bob"})
    assert rendered == "Patient: Bob"

    rendered_unknown = render_template(template, {"patient_name": "Unknown"})
    assert rendered_unknown == "Patient: Unknown"
