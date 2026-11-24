"""Week 1 checks against NumPy and against derivatives worked out by hand."""

import math

import numpy as np
import pytest


def test_dot(mod):
    assert mod.dot([1, 2, 3], [4, 5, 6]) == 32
    with pytest.raises(ValueError):
        mod.dot([1, 2], [1, 2, 3])


def test_matmul_matches_numpy(mod):
    rng = np.random.default_rng(1)
    a, b = rng.normal(size=(3, 4)), rng.normal(size=(4, 2))
    assert np.allclose(mod.matmul(a.tolist(), b.tolist()), a @ b)


def test_cosine(mod):
    assert mod.cosine_similarity(np.array([1.0, 0.0]), np.array([5.0, 0.0])) == pytest.approx(1)
    assert mod.cosine_similarity(np.array([1.0, 0.0]), np.array([0.0, 2.0])) == pytest.approx(0)
    assert mod.cosine_similarity(np.array([1.0, 1.0]), np.array([-1.0, -1.0])) == pytest.approx(-1)


def test_derivative_by_hand(mod):
    # d/dx sin(x) x^2 = cos(x) x^2 + 2x sin(x)
    x = 1.3
    exact = math.cos(x) * x**2 + 2 * x * math.sin(x)
    assert mod.derivative(mod.sample_function, x) == pytest.approx(exact, rel=1e-6)


def test_gradient(mod):
    # f(x, y) = x^2 y + 3y, so the gradient is (2xy, x^2 + 3)
    f = lambda p: p[0] ** 2 * p[1] + 3 * p[1]
    assert np.allclose(mod.gradient(f, np.array([2.0, -1.0])), [-4.0, 7.0], atol=1e-6)
