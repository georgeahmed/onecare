from __future__ import annotations

import math


def rough_token_count(text: str) -> int:
    if not text:
        return 0
    words = text.split()
    # heuristic: assume ~0.75 tokens per word plus punctuation allowance
    estimate = len(words) * 0.75 + text.count("\n") * 0.2
    return max(1, math.ceil(estimate))


def truncate_to_tokens(text: str, max_tokens: int) -> str:
    if max_tokens <= 0 or not text:
        return ""

    words = text.split()
    truncated_words = []
    tokens_used = 0

    for word in words:
        word_tokens = max(1, math.ceil(len(word) / 4))
        if tokens_used + word_tokens > max_tokens:
            break
        truncated_words.append(word)
        tokens_used += word_tokens

    return " ".join(truncated_words)


__all__ = ["rough_token_count", "truncate_to_tokens"]
