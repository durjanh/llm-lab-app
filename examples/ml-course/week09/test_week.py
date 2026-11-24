"""Week 9 checks against scikit-learn, and the scale trap."""

import numpy as np
import pytest
from sklearn.neighbors import KNeighborsClassifier, KNeighborsRegressor


def test_distances(mod):
    B = np.array([[3.0, 4.0], [0.0, 0.0]])
    assert np.allclose(mod.distances(np.zeros(2), B), [5, 0])
    assert np.allclose(mod.distances(np.zeros(2), B, p=1), [7, 0])


def test_classifier_matches_sklearn(mod):
    X, y = mod.make_data()
    ours = mod.knn_classify(X[:200], y[:200], X[200:], k=7)
    theirs = KNeighborsClassifier(n_neighbors=7).fit(X[:200], y[:200]).predict(X[200:])
    assert np.mean(ours == theirs) > 0.97  # ties can break differently


def test_regressor_matches_sklearn(mod):
    rng = np.random.default_rng(0)
    X = rng.uniform(0, 1, (150, 2))
    y = X[:, 0] * 3 + rng.normal(0, 0.05, 150)
    ours = mod.knn_regress(X[:100], y[:100], X[100:], k=5)
    theirs = KNeighborsRegressor(n_neighbors=5).fit(X[:100], y[:100]).predict(X[100:])
    assert ours == pytest.approx(theirs)


def test_unscaled_feature_drowns_the_signal(mod):
    # Feature 0 carries the label; feature 1 is noise measured in thousands. Unscaled, distance is all noise.
    rng = np.random.default_rng(1)
    y = rng.integers(0, 2, 300)
    X = np.column_stack([y + rng.normal(0, 0.3, 300), rng.normal(0, 1000, 300)])
    raw = np.mean(mod.knn_classify(X[:200], y[:200], X[200:], 5) == y[200:])
    Z = (X - X[:200].mean(0)) / X[:200].std(0)
    scaled = np.mean(mod.knn_classify(Z[:200], y[:200], Z[200:], 5) == y[200:])
    assert scaled > 0.85 > raw + 0.15


def test_best_k_is_not_one(mod):
    X, y = mod.make_data()
    assert mod.best_k(X, y, [1, 3, 5, 9, 15, 25, 51]) > 1
