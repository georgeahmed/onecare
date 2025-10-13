from common.features.encode_features import EMBEDDING_SIZE, encode_features


def test_encode_features_shapes():
    raw = {
        "symptom_mentions": [
            {"name": "Severe chest pain"},
            {"name": "Shortness of breath"},
        ],
        "patient": {"age": 55, "comorbidities": {"diabetes": True, "respiratory": True}},
    }

    encoded = encode_features(raw)

    assert len(encoded["symptom_embedding"]) == EMBEDDING_SIZE
    assert abs(sum(value * value for value in encoded["symptom_embedding"]) - 1.0) < 1e-6
    assert encoded["age_years"] == 55.0
    assert encoded["comorbidity_flags"] == {
        "diabetes": True,
        "cardiac": False,
        "respiratory": True,
    }


def test_encode_features_defaults():
    encoded = encode_features({})

    assert encoded["symptom_embedding"] == [0.0] * EMBEDDING_SIZE
    assert encoded["age_years"] == 0.0
    assert encoded["comorbidity_flags"] == {
        "diabetes": False,
        "cardiac": False,
        "respiratory": False,
    }
