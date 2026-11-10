"""Published tokenizers from Hugging Face, run on this machine with the `tokenizers` library.

The token counter uses them for model families whose tokenizer is public (GPT's o200k_base, Llama, Mistral, Qwen,
DeepSeek, Gemma). Each tokenizer.json is downloaded once, the first time it is needed, and kept in
generated/tokenizers/; after that, counting is offline and free. Encoding returns where each token starts and ends in
the text, so the page can colour the text token by token.
"""
from __future__ import annotations

import threading
from collections import defaultdict
from pathlib import Path
from typing import Any, Protocol

import httpx

HUB = "https://huggingface.co"


class TokenizerSource(Protocol):
    def cached(self, repo: str) -> bool: ...
    def encode(self, repo: str, text: str) -> list[tuple[int, int]]: ...


class HfTokenizers:
    def __init__(self, cache_dir: Path, timeout_s: float = 120.0):
        self.cache_dir, self.timeout_s = cache_dir, timeout_s
        self._loaded: dict[str, Any] = {}
        self._locks: defaultdict[str, threading.Lock] = defaultdict(threading.Lock)

    def _path(self, repo: str) -> Path:
        return self.cache_dir / repo.replace("/", "__") / "tokenizer.json"

    def cached(self, repo: str) -> bool:
        return repo in self._loaded or self._path(repo).is_file()

    def _get(self, repo: str) -> Any:
        if repo in self._loaded:
            return self._loaded[repo]
        with self._locks[repo]:  # one download per tokenizer, however many requests ask at once
            if repo not in self._loaded:
                from tokenizers import Tokenizer
                path = self._path(repo)
                if not path.is_file():
                    path.parent.mkdir(parents=True, exist_ok=True)
                    url = f"{HUB}/{repo}/resolve/main/tokenizer.json"
                    with httpx.stream("GET", url, follow_redirects=True, timeout=self.timeout_s) as r:
                        r.raise_for_status()
                        partial = path.with_suffix(".part")
                        with partial.open("wb") as f:
                            for chunk in r.iter_bytes():
                                f.write(chunk)
                    partial.replace(path)  # a half-finished download is never mistaken for a tokenizer
                self._loaded[repo] = Tokenizer.from_file(str(path))
        return self._loaded[repo]

    def encode(self, repo: str, text: str) -> list[tuple[int, int]]:
        """Each token's (start, end) character positions in the text. Special tokens (begin-of-text) are left out."""
        return [tuple(o) for o in self._get(repo).encode(text, add_special_tokens=False).offsets]
