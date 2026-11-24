"""Week 14 checks: the GP passes through its data, EI behaves, and Bayesian optimisation beats random search."""

import numpy as np


def test_gp_interpolates(mod):
    x = np.array([1.0, 4.0, 6.0])
    y = np.array([0.3, -0.5, 1.2])
    mean, std = mod.gp_posterior(x, y, x, length=1.0)
    assert np.allclose(mean, y, atol=1e-4)
    assert np.all(std < 1e-2)
    _, far = mod.gp_posterior(x, y, np.array([20.0]), length=1.0)
    assert far[0] > 0.99  # far from the data, back to the prior's uncertainty


def test_expected_improvement(mod):
    ei = mod.expected_improvement(np.array([0.0, 0.0, 2.0]), np.array([0.0, 1.0, 0.1]), best=1.0)
    assert ei[0] == 0  # certain and worse: nothing to gain
    assert ei[1] > 0  # unsure: might beat the best
    assert ei[2] > ei[1]  # confidently better


def test_bayes_opt_beats_random_search(mod):
    found = [mod.bayes_opt(mod.mystery, 3, 12, seed=s)[1].max() for s in range(5)]
    rng = np.random.default_rng(0)
    random = [mod.mystery(rng.uniform(0, 10, 15)).max() for _ in range(5)]
    assert np.mean(found) > np.mean(random)
    assert np.mean(found) > 1.35  # finds the narrow, higher hill
