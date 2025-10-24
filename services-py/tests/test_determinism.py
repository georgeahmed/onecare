import os
import random

from safety_gate_service.determinism import DEFAULT_SEED, set_seed


def test_set_seed_reproducible():
    set_seed(1234)
    seq1 = [random.random() for _ in range(3)]
    set_seed(1234)
    seq2 = [random.random() for _ in range(3)]
    assert seq1 == seq2
    assert os.environ["PYTHONHASHSEED"] == "1234"


def test_set_seed_returns_default():
    value = set_seed(None)
    assert value == DEFAULT_SEED
