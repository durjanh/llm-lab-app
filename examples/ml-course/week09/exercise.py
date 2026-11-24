# Your work goes here. Generated from solution.py by make_exercises.py; run the tests with pytest.
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
    raise NotImplementedError("TODO: write distances")


# EXERCISE
def knn_classify(X_train: np.ndarray, y_train: np.ndarray, X: np.ndarray, k: int) -> np.ndarray:
    """The majority label among the k nearest training rows (Euclidean), for each row of X. Ties go to the
    smaller label."""
    raise NotImplementedError("TODO: write knn_classify")


# EXERCISE
def knn_regress(X_train: np.ndarray, y_train: np.ndarray, X: np.ndarray, k: int) -> np.ndarray:
    """The mean target of the k nearest training rows, for each row of X."""
    raise NotImplementedError("TODO: write knn_regress")


# EXERCISE
def best_k(X: np.ndarray, y: np.ndarray, ks: list[int]) -> int:
    """The k with the highest 5-fold cross-validated accuracy, using scikit-learn's KNeighborsClassifier."""
    raise NotImplementedError("TODO: write best_k")
