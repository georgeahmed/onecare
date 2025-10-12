from safety_gate_service.datasets import SafetySample, load_safety_samples


def test_load_safety_samples_default_dataset():
    samples = load_safety_samples()

    assert samples, "expected at least one curated safety sample"
    for sample in samples:
        assert isinstance(sample, SafetySample)
        assert sample.red_flag_labels == sorted(sample.red_flag_labels)
        assert isinstance(sample.emergency, bool)


def test_load_safety_samples_custom_path(tmp_path):
    dataset_path = tmp_path / "custom_samples.jsonl"
    dataset_path.write_text(
        '{"text": "neutral narrative", "red_flag_labels": [], "emergency": false}\n',
        encoding="utf-8",
    )

    samples = load_safety_samples(dataset_path)

    assert len(samples) == 1
    assert samples[0].text == "neutral narrative"
    assert samples[0].red_flag_labels == []
    assert samples[0].emergency is False
