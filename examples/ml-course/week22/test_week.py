"""Week 22 checks: k-means recovers the groups, the elbow is at four, and shapes beat k-means."""

import numpy as np
from sklearn.cluster import KMeans


def test_kmeans_matches_sklearn_quality(mod):
    X = mod.make_shops()
    best = min(mod.inertia(X, *mod.kmeans(X, 4, s)) for s in range(5))
    ref = KMeans(4, n_init=5, random_state=0).fit(X).inertia_
    assert best <= ref * 1.01


def test_elbow_at_four(mod):
    curve = mod.elbow(mod.make_shops(), [1, 2, 3, 4, 5, 6], seed=0)
    drops = {k: curve[k - 1] - curve[k] for k in range(2, 7)}
    assert all(curve[k] <= curve[k - 1] + 1e-9 for k in range(2, 7))
    assert drops[4] > 5 * drops[5]  # big gain up to four, little after


def test_single_linkage_follows_the_moons(mod):
    r = mod.moons_agreement()
    assert r["single_linkage"] > 0.95
    assert r["kmeans"] < 0.6
