# Your work goes here. Generated from solution.py by make_exercises.py; run the tests with pytest.
"""Week 13: support vector machines and kernels.

A linear SVM looks for the boundary with the widest margin, trading margin against mistakes with C. Train one by
sub-gradient descent on the hinge loss, then see a kernel bend the boundary round data a line cannot separate.
"""

import numpy as np
from sklearn.datasets import make_blobs, make_circles
from sklearn.svm import SVC


def make_separable(seed: int = 0) -> tuple[np.ndarray, np.ndarray]:
    """Two well-separated invented clusters, labelled -1 and +1."""
    X, y = make_blobs(n_samples=200, centers=[[-2, -2], [2, 2]], cluster_std=0.8, random_state=seed)
    return X, np.where(y == 0, -1, 1)


# EXERCISE
def hinge_objective(w: np.ndarray, b: float, X: np.ndarray, y: np.ndarray, C: float) -> float:
    """0.5 |w|^2 + C * mean(max(0, 1 - y (w.x + b))) for labels -1 and +1."""
    raise NotImplementedError("TODO: write hinge_objective")


# EXERCISE
def linear_svm(X: np.ndarray, y: np.ndarray, C: float = 10.0, lr: float = 0.01, epochs: int = 2000):
    """Full-batch sub-gradient descent on hinge_objective from zero. Returns (w, b)."""
    raise NotImplementedError("TODO: write linear_svm")


# EXERCISE
def rbf_kernel(A: np.ndarray, B: np.ndarray, gamma: float) -> np.ndarray:
    """The matrix exp(-gamma |a - b|^2) for every row a of A and b of B."""
    raise NotImplementedError("TODO: write rbf_kernel")


# EXERCISE
def linear_vs_rbf(seed: int = 0) -> dict[str, float]:
    """Test accuracy of SVC(kernel="linear") and SVC(kernel="rbf") on make_circles(400, noise=0.1, factor=0.4),
    trained on the first 300 rows."""
    raise NotImplementedError("TODO: write linear_vs_rbf")
