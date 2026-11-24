"""Week 9: nearest neighbours.

Predict from the k most similar training rows. Write the distances, the vote and the average yourself, see why
features must share a scale, and pick k by cross-validation.
"""

import numpy as np
from sklearn.datasets import make_moons
from sklearn.model_selection import cross_val_score
from sklearn.neighbors import KNeighborsClassifier


def make_data(seed: int = 0) -> tuple[np.ndarray, np.ndarray]:
    """Two interleaved half-moons with some noise: a boundary no straight line can draw."""
    return make_moons(n_samples=300, noise=0.25, random_state=seed)


# EXERCISE
def distances(a: np.ndarray, B: np.ndarray, p: int = 2) -> np.ndarray:
    """The Minkowski distance from point a to every row of B: p=2 is Euclidean, p=1 Manhattan."""
    return np.sum(np.abs(B - a) ** p, axis=1) ** (1 / p)


# EXERCISE
def knn_classify(X_train: np.ndarray, y_train: np.ndarray, X: np.ndarray, k: int) -> np.ndarray:
    """The majority label among the k nearest training rows (Euclidean), for each row of X. Ties go to the
    smaller label."""
    # No training step at all: the model is the data. The cost moves to prediction, which must search.
    out = []
    for row in X:
        nearest = np.argsort(distances(row, X_train), kind="stable")[:k]
        out.append(np.bincount(y_train[nearest]).argmax())
    return np.array(out)


# EXERCISE
def knn_regress(X_train: np.ndarray, y_train: np.ndarray, X: np.ndarray, k: int) -> np.ndarray:
    """The mean target of the k nearest training rows, for each row of X."""
    return np.array([y_train[np.argsort(distances(r, X_train), kind="stable")[:k]].mean() for r in X])


# EXERCISE
def best_k(X: np.ndarray, y: np.ndarray, ks: list[int]) -> int:
    """The k with the highest 5-fold cross-validated accuracy, using scikit-learn's KNeighborsClassifier."""
    # Small k follows every noisy point (variance); large k blurs the boundary (bias). Cross-validation finds
    # the balance on this data.
    scores = {k: cross_val_score(KNeighborsClassifier(n_neighbors=k), X, y, cv=5).mean() for k in ks}
    return max(scores, key=scores.get)
