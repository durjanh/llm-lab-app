# Your work goes here. Generated from solution.py by make_exercises.py; run the tests with pytest.
"""Week 8: evaluating fairly, k-fold, stratification, imbalance and leakage.

Write k-fold splitting and its stratified version, balance a rare class by oversampling the training folds only,
and catch the classic leak: choosing features on all the data before cross-validating, which finds signal in
pure noise.
"""

import numpy as np
from sklearn.feature_selection import SelectKBest, f_classif
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import cross_val_score
from sklearn.pipeline import make_pipeline


# EXERCISE
def kfold(n: int, k: int, seed: int) -> list[np.ndarray]:
    """k disjoint index arrays covering 0..n-1 after a seeded shuffle, sizes differing by at most one."""
    raise NotImplementedError("TODO: write kfold")


# EXERCISE
def stratified_kfold(y: np.ndarray, k: int, seed: int) -> list[np.ndarray]:
    """Like kfold, but each fold gets each class in (nearly) the same proportion as the whole."""
    raise NotImplementedError("TODO: write stratified_kfold")


# EXERCISE
def oversample(X: np.ndarray, y: np.ndarray, seed: int) -> tuple[np.ndarray, np.ndarray]:
    """Repeat randomly chosen minority-class rows until both classes (0 and 1) are the same size."""
    raise NotImplementedError("TODO: write oversample")


def make_noise(seed: int = 0) -> tuple[np.ndarray, np.ndarray]:
    """100 rows of 2,000 random features and random labels: there is nothing to learn."""
    rng = np.random.default_rng(seed)
    return rng.normal(size=(100, 2000)), rng.integers(0, 2, 100)


# EXERCISE
def leaky_score(X: np.ndarray, y: np.ndarray) -> float:
    """Pick the 20 features most related to y using ALL rows, then 5-fold cross-validate logistic regression on
    them. Returns the mean accuracy. This is the mistake."""
    raise NotImplementedError("TODO: write leaky_score")


# EXERCISE
def proper_score(X: np.ndarray, y: np.ndarray) -> float:
    """The same model, with the feature selection inside a pipeline so it is refitted on each training fold."""
    raise NotImplementedError("TODO: write proper_score")
