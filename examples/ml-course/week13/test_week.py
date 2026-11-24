"""Week 13 checks: the hinge objective falls, the margin separates, the kernel matches scikit-learn."""

import numpy as np
from sklearn.metrics.pairwise import rbf_kernel


def test_linear_svm_separates(mod):
    X, y = mod.make_separable()
    w, b = mod.linear_svm(X, y)
    assert np.mean(np.sign(X @ w + b) == y) == 1.0
    assert mod.hinge_objective(w, b, X, y, 10.0) < mod.hinge_objective(np.zeros(2), 0.0, X, y, 10.0)


def test_rbf_kernel_matches_sklearn(mod):
    rng = np.random.default_rng(0)
    A, B = rng.normal(size=(5, 3)), rng.normal(size=(4, 3))
    assert np.allclose(mod.rbf_kernel(A, B, 0.7), rbf_kernel(A, B, gamma=0.7))


def test_kernel_bends_the_boundary(mod):
    r = mod.linear_vs_rbf()
    assert r["linear"] < 0.7
    assert r["rbf"] > 0.95
