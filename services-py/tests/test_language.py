from safety_gate_service.language import NarrativeLanguage, detect_language, normalize_narrative


def test_detect_language_english():
    lang = detect_language("Patient reports chest pain and dizziness.")
    assert lang.is_english
    assert lang.code == "en"


def test_detect_language_non_english():
    lang = detect_language("Paciente presenta dolor de pecho y mareos.")
    assert not lang.is_english
    assert lang.code in {"es", "es-es"}


def test_normalize_narrative():
    text, language, translated = normalize_narrative("Paciente presenta dolor de pecho y mareos.")
    assert isinstance(language, NarrativeLanguage)
    assert text
    assert translated in {True, False}
