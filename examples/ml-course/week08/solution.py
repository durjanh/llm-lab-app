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
    order = np.random.default_rng(seed).permutation(n)
    return [order[i::k] for i in range(k)]


# EXERCISE
def stratified_kfold(y: np.ndarray, k: int, seed: int) -> list[np.ndarray]:
    """Like kfold, but each fold gets each class in (nearly) the same proportion as the whole."""
    # With a rare class, plain folds can end up with no positives at all, and that fold's score means nothing.
    # Dealing each class out separately, like cards, keeps every fold representative.
    rng = np.random.default_rng(seed)
    folds: list[list[int]] = [[] for _ in range(k)]
    for cls in np.unique(y):
        idx = rng.permutation(np.flatnonzero(y == cls))
        for i, row in enumerate(idx):
            folds[i % k].append(int(row))
    return [np.array(sorted(f)) for f in folds]


# EXERCISE
def oversample(X: np.ndarray, y: np.ndarray, seed: int) -> tuple[np.ndarray, np.ndarray]:
    """Repeat randomly chosen minority-class rows until both classes (0 and 1) are the same size."""
    # Only ever on training data. Oversampling before the split copies rows into the test fold that the model
    # has already seen, and the score rises for no real reason.
    rng = np.random.default_rng(seed)
    minority = 1 if (y == 1).sum() < (y == 0).sum() else 0
    idx = np.flatnonzero(y == minority)
    extra = rng.choice(idx, size=(y != minority).sum() - len(idx), replace=True)
    keep = np.concatenate([np.arange(len(y)), extra])
    return X[keep], y[keep]


def make_noise(seed: int = 0) -> tuple[np.ndarray, np.ndarray]:
    """100 rows of 2,000 random features and random labels: there is nothing to learn."""
    rng = np.random.default_rng(seed)
    return rng.normal(size=(100, 2000)), rng.integers(0, 2, 100)


# EXERCISE
def leaky_score(X: np.ndarray, y: np.ndarray) -> float:
    """Pick the 20 features most related to y using ALL rows, then 5-fold cross-validate logistic regression on
    them. Returns the mean accuracy. This is the mistake."""
    chosen = SelectKBest(f_classif, k=20).fit_transform(X, y)
    return float(cross_val_score(LogisticRegression(max_iter=1000), chosen, y, cv=5).mean())


# EXERCISE
def proper_score(X: np.ndarray, y: np.ndarray) -> float:
    """The same model, with the feature selection inside a pipeline so it is refitted on each training fold."""
    # Inside the pipeline, the test fold plays no part in choosing features, so noise stays noise.
    pipe = make_pipeline(SelectKBest(f_classif, k=20), LogisticRegression(max_iter=1000))
    return float(cross_val_score(pipe, X, y, cv=5).mean())
