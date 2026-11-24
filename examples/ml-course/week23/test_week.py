"""Week 23 checks against scikit-learn's PCA, a compression that keeps the picture, and a similarity search."""

import numpy as np
from sklearn.decomposition import PCA


def test_matches_sklearn(mod):
    X = mod.digits()
    comps, ratio, _ = mod.pca(X, 5)
    ref = PCA(5).fit(X)
    assert np.allclose(ratio, ref.explained_variance_ratio_)
    assert np.allclose(np.abs(comps), np.abs(ref.components_), atol=1e-6)  # signs may flip


def test_compression_keeps_most_of_the_picture(mod):
    X = mod.digits()
    k = mod.components_for(X, 0.9)
    assert 15 <= k <= 30  # far fewer than 64 pixels
    comps, _, mean = mod.pca(X, k)
    rebuilt = mod.reconstruct(mod.project(X, comps, mean), comps, mean)
    assert np.mean((rebuilt - X) ** 2) / np.var(X) < 0.15


def test_nearest_by_cosine(mod):
    items = np.array([[1.0, 0.0], [10.0, 1.0], [0.0, 1.0], [-1.0, 0.0]])
    assert list(mod.nearest(np.array([2.0, 0.1]), items, 2)) == [1, 0]
