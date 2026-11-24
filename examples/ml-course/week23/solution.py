"""Week 23: unsupervised learning II, PCA and embeddings.

Principal component analysis finds the directions the data varies most along. Write it from the SVD, measure the
variance each component keeps, compress and rebuild the 8 by 8 digits, and search a small set of invented
embeddings by cosine similarity.
"""

import numpy as np
from sklearn.datasets import load_digits


# EXERCISE
def pca(X: np.ndarray, n_components: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """From the SVD of the centred data: (components as rows, explained variance ratio of each, the mean)."""
    # The right singular vectors are the directions; the squared singular values are the variance along each.
    mean = X.mean(axis=0)
    _, s, vt = np.linalg.svd(X - mean, full_matrices=False)
    ratio = s**2 / np.sum(s**2)
    return vt[:n_components], ratio[:n_components], mean


# EXERCISE
def project(X: np.ndarray, components: np.ndarray, mean: np.ndarray) -> np.ndarray:
    """Coordinates of each row along the components."""
    return (X - mean) @ components.T


# EXERCISE
def reconstruct(Z: np.ndarray, components: np.ndarray, mean: np.ndarray) -> np.ndarray:
    """Rows rebuilt from their coordinates."""
    return Z @ components + mean


# EXERCISE
def components_for(X: np.ndarray, share: float) -> int:
    """The fewest components that keep at least `share` of the variance."""
    _, ratio, _ = pca(X, X.shape[1])
    return int(np.searchsorted(np.cumsum(ratio), share) + 1)


def digits() -> np.ndarray:
    """The 1,797 scikit-learn digits as rows of 64 pixel values."""
    return load_digits().data


# EXERCISE
def nearest(query: np.ndarray, items: np.ndarray, k: int) -> np.ndarray:
    """Indices of the k rows of `items` with the highest cosine similarity to `query`, best first."""
    # Normalising both sides turns the dot product into the cosine, so long and short vectors compare fairly.
    sims = items @ query / (np.linalg.norm(items, axis=1) * np.linalg.norm(query))
    return np.argsort(-sims, kind="stable")[:k]
