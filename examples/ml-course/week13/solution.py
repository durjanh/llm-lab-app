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
    # The first term widens the margin; the second charges each point inside the margin or on the wrong side.
    return float(0.5 * w @ w + C * np.mean(np.maximum(0, 1 - y * (X @ w + b))))


# EXERCISE
def linear_svm(X: np.ndarray, y: np.ndarray, C: float = 10.0, lr: float = 0.01, epochs: int = 2000):
    """Full-batch sub-gradient descent on hinge_objective from zero. Returns (w, b)."""
    # Only points with margin under 1 contribute to the gradient: these are the support vectors.
    w = np.zeros(X.shape[1])
    b = 0.0
    for _ in range(epochs):
        inside = y * (X @ w + b) < 1
        gw = w - C * (y[inside, None] * X[inside]).sum(axis=0) / len(y)
        gb = -C * y[inside].sum() / len(y)
        w -= lr * gw
        b -= lr * gb
    return w, b


# EXERCISE
def rbf_kernel(A: np.ndarray, B: np.ndarray, gamma: float) -> np.ndarray:
    """The matrix exp(-gamma |a - b|^2) for every row a of A and b of B."""
    # A kernel is a similarity that acts like a dot product in a bigger feature space, without building it.
    sq = (A**2).sum(1)[:, None] + (B**2).sum(1)[None, :] - 2 * A @ B.T
    return np.exp(-gamma * np.maximum(sq, 0))


# EXERCISE
def linear_vs_rbf(seed: int = 0) -> dict[str, float]:
    """Test accuracy of SVC(kernel="linear") and SVC(kernel="rbf") on make_circles(400, noise=0.1, factor=0.4),
    trained on the first 300 rows."""
    X, y = make_circles(n_samples=400, noise=0.1, factor=0.4, random_state=seed)
    return {
        k: SVC(kernel=k).fit(X[:300], y[:300]).score(X[300:], y[300:]) for k in ("linear", "rbf")
    }
