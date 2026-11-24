"""Week 18 checks: grid and random search find good settings, and halving saves budget."""

import numpy as np


def test_grid_and_random_find_good_settings(mod):
    X, y = mod.make_data()
    score = lambda c, g: mod.svm_score(X, y, c, g)
    (_, _), grid_best = mod.grid_search(score, [-1.0, 1.0, 3.0], [-3.0, -1.5, 0.0])
    (_, _), rand_best = mod.random_search(score, 9, seed=0)
    worst = mod.svm_score(X, y, -2.0, 1.0)
    assert grid_best > worst + 0.2
    assert rand_best > worst + 0.2


def test_random_search_returns_its_best(mod):
    calls = []
    score = lambda c, g: (calls.append((c, g)), -(c**2) - g**2)[1]
    pair, best = mod.random_search(score, 20, seed=1)
    assert len(calls) >= 20
    assert best == max(-(c**2) - g**2 for c, g in calls[:20])


def test_successive_halving_finds_the_best_for_less(mod):
    candidates = list(np.linspace(0, 1, 16))
    winner, spent = mod.successive_halving(candidates, mod.noisy_quality, min_budget=1, rounds=4)
    assert abs(winner - 0.7) < 0.1
    full = 16 * 8  # every candidate at the final budget
    assert spent == 16 * 1 + 8 * 2 + 4 * 4 + 2 * 8  # each round's survivors times its budget
    assert spent <= full / 2
