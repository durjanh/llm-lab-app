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
    # Real models use sub-word tokens (see the lab's Tokens page), but characters keep the vocabulary tiny.
    vocab = sorted(set(text))
    index = {ch: i for i, ch in enumerate(vocab)}
    return vocab, [index[ch] for ch in text]


# EXERCISE
def bigram_probs(ids: list[int], vocab_size: int, smoothing: float = 0.1) -> np.ndarray:
    """A vocab x vocab matrix: row a holds P(next = b | current = a), from counts plus `smoothing` in every cell."""
    # Smoothing gives every pair a little probability, so an unseen pair is unlikely rather than impossible.
    counts = np.full((vocab_size, vocab_size), smoothing)
    for a, b in zip(ids, ids[1:]):
        counts[a, b] += 1
    return counts / counts.sum(axis=1, keepdims=True)


# EXERCISE
def softmax(z: np.ndarray, temperature: float = 1.0) -> np.ndarray:
    """softmax(z / temperature) over the last axis, computed stably."""
    # Subtracting the maximum changes nothing mathematically and stops exp() overflowing.
    z = z / temperature
    z = z - z.max(axis=-1, keepdims=True)
    e = np.exp(z)
    return e / e.sum(axis=-1, keepdims=True)


# EXERCISE
def sample(probs: np.ndarray, start: int, length: int, temperature: float, seed: int) -> list[int]:
    """Generate `length` ids after `start`, each drawn from softmax(log(probs[current]), temperature)."""
    # Low temperature sharpens the distribution towards the likeliest next token; high temperature flattens it.
    rng = np.random.default_rng(seed)
    out = [start]
    for _ in range(length):
        p = softmax(np.log(probs[out[-1]]), temperature)
        out.append(int(rng.choice(len(p), p=p)))
    return out


# EXERCISE
def attention(Q: np.ndarray, K: np.ndarray, V: np.ndarray, causal: bool = True) -> tuple[np.ndarray, np.ndarray]:
    """Scaled dot-product attention for one head. Q, K, V are (positions, dim). With causal=True a position may
    only attend to itself and earlier positions. Returns (output, attention weights)."""
    # Each position scores every other by a dot product, scaled by sqrt(dim) so the softmax does not saturate,
    # and takes a weighted average of their values. The mask hides the future during training.
    scores = Q @ K.T / np.sqrt(Q.shape[1])
    if causal:
        scores = np.where(np.tril(np.ones_like(scores)) == 1, scores, -np.inf)
    weights = softmax(scores)
    return weights @ V, weights
