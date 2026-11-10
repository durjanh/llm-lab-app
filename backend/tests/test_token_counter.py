"""The token counter's catalogue and counts, with a fake tokenizer and a fake count_tokens: no network."""
from __future__ import annotations

from backend.app.services.token_counter import CATALOGUE, TokenCounterService, segments


class FakeTokenizers:
    """Splits on spaces, keeping the space with the next word, and downloads nothing."""

    def __init__(self) -> None:
        self.asked: list[str] = []

    def cached(self, repo: str) -> bool:
        return repo == "Xenova/gpt-4o"

    def encode(self, repo: str, text: str) -> list[tuple[int, int]]:
        self.asked.append(repo)
        out, start = [], 0
        for i in range(1, len(text) + 1):
            if i == len(text) or text[i] == " ":
                out.append((start, i))
                start = i
        return out


class FakeClaude:
    """8 tokens of framing, 3 for a system prompt's wrapping, one token per character of text."""

    def count_tokens(self, model: str, messages: list[dict], system: str | None = None) -> int:
        return 8 + (3 + len(system) if system else 0) + len(messages[0]["content"])


def service() -> TokenCounterService:
    return TokenCounterService(FakeClaude(), FakeTokenizers())


def test_segments_keep_every_character_and_every_token() -> None:
    text = "café 😀!"
    # A byte-level tokenizer splits the emoji into two tokens with the same positions.
    segs = segments(text, [(0, 4), (4, 6), (5, 6), (6, 7)])
    assert "".join(s["text"] for s in segs) == text
    assert sum(s["tokens"] for s in segs) == 4 and segs[1] == {"text": " 😀", "tokens": 2}
    # Text a tokenizer skips stays visible.
    assert "".join(s["text"] for s in segments("ab  cd", [(0, 2), (4, 6)])) == "ab  cd"


def test_every_provider_is_offered_and_gemini_is_marked_as_an_estimate() -> None:
    models = service().catalogue()
    assert {m["provider"] for m in models} >= {"Anthropic", "OpenAI", "Google", "Meta", "Mistral AI", "Alibaba", "DeepSeek"}
    gemini = next(m for m in models if m["id"] == "gemini")
    assert gemini["exact"] is False and "Estimate" in gemini["note"]
    assert all(m["exact"] for m in models if m["id"] != "gemini")
    assert next(m for m in models if m["id"] == "claude-haiku-5-5")["input_price"] == 0.10
    assert next(m for m in models if m["id"] == "llama-4")["ready"] is False  # not downloaded yet
    assert len({m["id"] for m in CATALOGUE}) == len(CATALOGUE)


def test_a_published_tokenizer_gives_pieces_and_gpt_adds_its_framing() -> None:
    r = service().count("gpt-5.4-mini", "Be brief.", "How many days")
    assert r["tokens"] == 2 + 3 and r["system_tokens"] == 2 and r["prompt_tokens"] == 3
    assert [s["text"] for s in r["segments"]["prompt"]] == ["How", " many", " days"]
    assert r["request_tokens"] > r["tokens"]  # o200k_base text plus the framing measured against Azure's bill
    assert r["cost_usd"] == r["request_tokens"] * 0.75 / 1_000_000


def test_claude_counts_through_count_tokens_without_pieces() -> None:
    r = service().count("claude-opus-4-8", "Hi", "Hello there")
    assert r["segments"] is None
    assert r["prompt_tokens"] == len("Hello there") and r["system_tokens"] == len("Hi")
    assert r["request_tokens"] == 8 + 3 + 2 + 11


def test_compare_counts_every_model_and_reports_failures_per_row() -> None:
    class Broken(FakeTokenizers):
        def encode(self, repo: str, text: str) -> list[tuple[int, int]]:
            if repo == "deepseek-ai/DeepSeek-V3":
                raise RuntimeError("download failed")
            return super().encode(repo, text)

    rows = TokenCounterService(FakeClaude(), Broken()).compare("", "one two three")
    assert len(rows) >= len(CATALOGUE)
    broken = next(r for r in rows if r["id"] == "deepseek-v3")
    assert broken["tokens"] is None and "download failed" in broken["error"]
    assert all(r["tokens"] == 3 for r in rows if r.get("how") == "tokenizer" and r["id"] != "deepseek-v3")
    assert all("segments" not in r for r in rows)
