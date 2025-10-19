import pytest

from safety_gate_service.preprocess import NarrativeValidationError, validate_narrative


def test_validate_narrative_happy_path():
    result = validate_narrative("Patient reports mild headache today.")
    assert result.startswith("Patient")


@pytest.mark.parametrize(
    "text,code",
    [
        (None, "narrative_missing"),
        ("   ", "narrative_empty"),
        ("x" * 2100, "narrative_too_long"),
        ("!!!!!!!!!", "narrative_low_signal"),
        ("aaaaabbbbbccccccdddddd", "narrative_repeated_chars"),
    ],
)
def test_validate_narrative_rejections(text, code):
    with pytest.raises(NarrativeValidationError) as exc:
        validate_narrative(text)
    assert str(exc.value) == code
