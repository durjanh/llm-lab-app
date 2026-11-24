# Your work goes here. Generated from solution.py by make_exercises.py; run the tests with pytest.
"""Week 22: unsupervised learning I, clustering.

With no labels, group rows by similarity. Write k-means, use its inertia to choose k, and see where it fails:
k-means assumes round clusters of similar size, while single-linkage hierarchical clustering follows shapes.
"""

import numpy as np
from sklearn.cluster import AgglomerativeClustering
from sklearn.datasets import make_blobs, make_moons
from sklearn.metrics import adjusted_rand_score


def make_shops(seed: int = 0) -> np.ndarray:
    """Invented shoppers (visits a month, spend per visit) in four natural groups."""
    X, _ = make_blobs(n_samples=400, centers=[[2, 10], [8, 15], [3, 40], [10, 45]], cluster_std=1.5, random_state=seed)
    return X


# EXERCISE
def kmeans(X: np.ndarray, k: int, seed: int, iters: int = 100) -> tuple[np.ndarray, np.ndarray]:
    """Lloyd's algorithm from k distinct rows chosen at random: assign each row to the nearest centre, move each
    centre to the mean of its rows, stop when nothing moves. Returns (labels, centres)."""
    raise NotImplementedError("TODO: write kmeans")


# EXERCISE
def inertia(X: np.ndarray, labels: np.ndarray, centres: np.ndarray) -> float:
    """The sum of squared distances from each row to its centre."""
    raise NotImplementedError("TODO: write inertia")


# EXERCISE
def elbow(X: np.ndarray, ks: list[int], seed: int) -> dict[int, float]:
    """Inertia for each k, taking the best of 5 starts (seeds seed .. seed+4)."""
    raise NotImplementedError("TODO: write elbow")


# EXERCISE
def moons_agreement(seed: int = 0) -> dict[str, float]:
    """Adjusted Rand index against the true moons (make_moons(300, noise=0.05)) for our kmeans with k=2 and for
    AgglomerativeClustering(2, linkage="single")."""
    raise NotImplementedError("TODO: write moons_agreement")
