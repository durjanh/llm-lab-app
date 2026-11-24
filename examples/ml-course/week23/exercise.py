# Your work goes here. Generated from solution.py by make_exercises.py; run the tests with pytest.
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
    raise NotImplementedError("TODO: write pca")


# EXERCISE
def project(X: np.ndarray, components: np.ndarray, mean: np.ndarray) -> np.ndarray:
    """Coordinates of each row along the components."""
    raise NotImplementedError("TODO: write project")


# EXERCISE
def reconstruct(Z: np.ndarray, components: np.ndarray, mean: np.ndarray) -> np.ndarray:
    """Rows rebuilt from their coordinates."""
    raise NotImplementedError("TODO: write reconstruct")


# EXERCISE
def components_for(X: np.ndarray, share: float) -> int:
    """The fewest components that keep at least `share` of the variance."""
    raise NotImplementedError("TODO: write components_for")


def digits() -> np.ndarray:
    """The 1,797 scikit-learn digits as rows of 64 pixel values."""
    return load_digits().data


# EXERCISE
def nearest(query: np.ndarray, items: np.ndarray, k: int) -> np.ndarray:
    """Indices of the k rows of `items` with the highest cosine similarity to `query`, best first."""
    raise NotImplementedError("TODO: write nearest")
