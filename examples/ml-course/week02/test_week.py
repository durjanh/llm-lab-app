"""Week 2 checks: each optimiser gets down the valley, and the better ones get further in the same steps."""

import numpy as np


START = np.array([10.0, 1.0])


def test_gradient_descent_path(mod):
    path = mod.gradient_descent(mod.valley_grad, START, lr=0.03, steps=50)
    assert path.shape == (51, 2)
    assert np.allclose(path[0], START)
    assert mod.valley(path[-1]) < mod.valley(START)


def test_too_large_a_step_diverges(mod):
    # Across the valley the curvature is 25, so any lr above 2/25 = 0.08 overshoots further each time.
    path = mod.gradient_descent(mod.valley_grad, START, lr=0.09, steps=50)
    assert mod.valley(path[-1]) > mod.valley(START)


def test_momentum_beats_plain_descent(mod):
    plain = mod.gradient_descent(mod.valley_grad, START, lr=0.03, steps=60)
    fast = mod.momentum(mod.valley_grad, START, lr=0.03, steps=60)
    assert mod.valley(fast[-1]) < mod.valley(plain[-1])


def test_adam_reaches_the_floor(mod):
    path = mod.adam(mod.valley_grad, START, lr=0.5, steps=200)
    assert mod.valley(path[-1]) < 1e-2


def test_line_fit_matches_least_squares(mod):
    rng = np.random.default_rng(0)
    x = rng.uniform(-1, 1, 100)
    y = 3 * x - 0.5 + rng.normal(0, 0.1, 100)
    a, b = mod.fit_line_gd(x, y)
    exact_a, exact_b = np.polyfit(x, y, 1)
    assert abs(a - exact_a) < 1e-3 and abs(b - exact_b) < 1e-3
