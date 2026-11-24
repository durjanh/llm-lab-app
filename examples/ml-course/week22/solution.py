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
    rng = np.random.default_rng(seed)
    centres = X[rng.choice(len(X), k, replace=False)].astype(float)
    for _ in range(iters):
        labels = np.argmin(((X[:, None, :] - centres[None]) ** 2).sum(-1), axis=1)
        # An empty cluster keeps its old centre rather than becoming the mean of nothing.
        new = np.array([X[labels == j].mean(0) if np.any(labels == j) else centres[j] for j in range(k)])
        if np.allclose(new, centres):
            break
        centres = new
    return labels, centres


# EXERCISE
def inertia(X: np.ndarray, labels: np.ndarray, centres: np.ndarray) -> float:
    """The sum of squared distances from each row to its centre."""
    return float(((X - centres[labels]) ** 2).sum())


# EXERCISE
def elbow(X: np.ndarray, ks: list[int], seed: int) -> dict[int, float]:
    """Inertia for each k, taking the best of 5 starts (seeds seed .. seed+4)."""
    # Inertia always falls as k rises; the "elbow" where it stops falling fast suggests a natural k.
    out = {}
    for k in ks:
        out[k] = min(inertia(X, *kmeans(X, k, seed + s)) for s in range(5))
    return out


# EXERCISE
def moons_agreement(seed: int = 0) -> dict[str, float]:
    """Adjusted Rand index against the true moons (make_moons(300, noise=0.05)) for our kmeans with k=2 and for
    AgglomerativeClustering(2, linkage="single")."""
    X, y = make_moons(n_samples=300, noise=0.05, random_state=seed)
    return {
        "kmeans": adjusted_rand_score(y, kmeans(X, 2, seed)[0]),
        "single_linkage": adjusted_rand_score(y, AgglomerativeClustering(2, linkage="single").fit_predict(X)),
    }
