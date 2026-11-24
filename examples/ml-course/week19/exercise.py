# Your work goes here. Generated from solution.py by make_exercises.py; run the tests with pytest.
"""Week 19: language models I, tokens, next-token prediction and attention.

Turn text into token ids, build the simplest language model (counts of which character follows which), sample
from it with a temperature, and compute scaled dot-product attention with a causal mask, the step at the heart
of a transformer. All in NumPy: no downloads and no keys.
"""

import numpy as np

CORPUS = (
    "the kettle sang on the stove. the cat watched the kettle. "
    "the rain tapped on the window and the cat slept by the stove. "
)


# EXERCISE
def tokenise(text: str) -> tuple[list[str], list[int]]:
    """Character tokens: the sorted list of distinct characters (the vocabulary) and the text as ids into it."""
    raise NotImplementedError("TODO: write tokenise")


# EXERCISE
def bigram_probs(ids: list[int], vocab_size: int, smoothing: float = 0.1) -> np.ndarray:
    """A vocab x vocab matrix: row a holds P(next = b | current = a), from counts plus `smoothing` in every cell."""
    raise NotImplementedError("TODO: write bigram_probs")


# EXERCISE
def softmax(z: np.ndarray, temperature: float = 1.0) -> np.ndarray:
    """softmax(z / temperature) over the last axis, computed stably."""
    raise NotImplementedError("TODO: write softmax")


# EXERCISE
def sample(probs: np.ndarray, start: int, length: int, temperature: float, seed: int) -> list[int]:
    """Generate `length` ids after `start`, each drawn from softmax(log(probs[current]), temperature)."""
    raise NotImplementedError("TODO: write sample")


# EXERCISE
def attention(Q: np.ndarray, K: np.ndarray, V: np.ndarray, causal: bool = True) -> tuple[np.ndarray, np.ndarray]:
    """Scaled dot-product attention for one head. Q, K, V are (positions, dim). With causal=True a position may
    only attend to itself and earlier positions. Returns (output, attention weights)."""
    raise NotImplementedError("TODO: write attention")
