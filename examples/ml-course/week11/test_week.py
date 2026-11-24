"""Week 11 checks: bootstrap coverage, boosting reduces error round by round, ensembles beat one tree."""

import numpy as np
import pytest


def test_bootstrap_leaves_about_a_third_out(mod):
    idx = mod.bootstrap_indices(10_000, np.random.default_rng(0))
    assert len(idx) == 10_000
    assert len(np.unique(idx)) / 10_000 == pytest.approx(1 - np.exp(-1), abs=0.01)


def test_boosting_error_falls(mod):
    rng = np.random.default_rng(0)
    x = rng.uniform(0, 6, 200)
    y = np.sin(x) + rng.normal(0, 0.1, 200)
    trees = mod.boost_regression(x, y, rounds=100, lr=0.1)
    errs = [np.mean((mod.boosted_predict(trees[:r], y.mean(), 0.1, x) - y) ** 2) for r in (0, 10, 50, 100)]
    assert errs == sorted(errs, reverse=True)
    assert errs[-1] < 0.02


def test_ensembles_beat_one_tree(mod):
    r = mod.compare()
    assert r["bagging"] > r["tree"]
    assert r["forest"] > r["tree"]
    assert r["boosting"] > r["tree"]
