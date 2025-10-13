from scribe_service.token_utils import rough_token_count, truncate_to_tokens


def test_rough_token_count_estimates_words():
    text = "This is a simple sentence."
    count = rough_token_count(text)
    assert count >= 4


def test_truncate_to_tokens_limits_word_count():
    text = "word1 word2 word3 word4"
    truncated = truncate_to_tokens(text, max_tokens=2)
    assert truncated in {"word1", "word1 word2"}
    assert rough_token_count(truncated) <= 2


def test_truncate_empty_text():
    assert truncate_to_tokens("", max_tokens=10) == ""
