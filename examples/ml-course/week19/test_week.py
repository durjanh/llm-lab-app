"""Week 19 checks: tokenising round-trips, probabilities sum to one, temperature and the causal mask work."""

import numpy as np


def test_tokenise_round_trip(mod):
    vocab, ids = mod.tokenise(mod.CORPUS)
    assert "".join(vocab[i] for i in ids) == mod.CORPUS
    assert vocab == sorted(set(mod.CORPUS))


def test_bigram_rows_are_distributions(mod):
    vocab, ids = mod.tokenise(mod.CORPUS)
    P = mod.bigram_probs(ids, len(vocab))
    assert np.allclose(P.sum(axis=1), 1)
    t, h = vocab.index("t"), vocab.index("h")
    assert P[t].argmax() == h  # in this text, "t" is most often followed by "h"


def test_temperature(mod):
    z = np.array([2.0, 1.0, 0.0])
    cold, warm = mod.softmax(z, 0.1), mod.softmax(z, 10.0)
    assert cold[0] > 0.99
    assert warm.max() - warm.min() < 0.1
    assert np.allclose(mod.softmax(np.array([1000.0, 1000.0])), [0.5, 0.5])  # no overflow


def test_cold_sampling_is_repetitive(mod):
    vocab, ids = mod.tokenise(mod.CORPUS)
    P = mod.bigram_probs(ids, len(vocab))
    cold = mod.sample(P, ids[0], 40, temperature=0.05, seed=0)
    hot = mod.sample(P, ids[0], 40, temperature=3.0, seed=0)
    assert len(cold) == 41
    assert len(set(cold)) < len(set(hot))


def test_causal_attention(mod):
    rng = np.random.default_rng(0)
    Q, K, V = (rng.normal(size=(5, 4)) for _ in range(3))
    out, w = mod.attention(Q, K, V)
    assert np.allclose(w.sum(axis=1), 1)
    assert np.allclose(np.triu(w, k=1), 0)  # nothing from the future
    assert np.allclose(out[0], V[0])  # the first position can only see itself
    _, free = mod.attention(Q, K, V, causal=False)
    assert np.all(free > 0)
