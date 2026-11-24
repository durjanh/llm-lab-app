"""Week 10: decision trees, entropy, Gini and depth.

A tree asks one yes-or-no question at a time. Measure how mixed a group of labels is, find the threshold that
best separates them, then watch a deeper tree memorise its training data.
"""

import numpy as np
from sklearn.datasets import make_classification
from sklearn.tree import DecisionTreeClassifier


# EXERCISE
def entropy(y: np.ndarray) -> float:
    """Shannon entropy of the labels in bits: 0 for a pure group, 1 for a 50/50 split of two classes."""
    p = np.bincount(y) / len(y)
    p = p[p > 0]
    return float(-np.sum(p * np.log2(p)))


# EXERCISE
def gini(y: np.ndarray) -> float:
    """Gini impurity: the chance two labels drawn at random (with replacement) differ."""
    # Gini and entropy almost always choose the same split; Gini is cheaper because it has no logarithm.
    p = np.bincount(y) / len(y)
    return float(1 - np.sum(p**2))


# EXERCISE
def best_threshold(x: np.ndarray, y: np.ndarray) -> tuple[float, float]:
    """The threshold t on one feature that most reduces weighted Gini impurity when splitting into x <= t and
    x > t. Returns (t, impurity decrease). Try the midpoints between consecutive distinct sorted values."""
    # Weighting each side by its size stops a split that peels off one pure row from looking good.
    values = np.unique(x)
    parent = gini(y)
    best = (float(values[0]), 0.0)
    for t in (values[:-1] + values[1:]) / 2:
        left, right = y[x <= t], y[x > t]
        child = (len(left) * gini(left) + len(right) * gini(right)) / len(y)
        if parent - child > best[1]:
            best = (float(t), float(parent - child))
    return best


def make_data(seed: int = 0) -> tuple[np.ndarray, np.ndarray]:
    """An invented two-class problem with label noise, so a perfect fit is a sign of memorising."""
    return make_classification(n_samples=600, n_features=8, n_informative=4, flip_y=0.15, random_state=seed)


# EXERCISE
def accuracy_by_depth(X: np.ndarray, y: np.ndarray, depths: list[int | None]) -> dict:
    """Train on the first 400 rows, test on the rest. For each max_depth (None means unlimited), return
    (train accuracy, test accuracy) from scikit-learn's DecisionTreeClassifier(random_state=0)."""
    out = {}
    for d in depths:
        tree = DecisionTreeClassifier(max_depth=d, random_state=0).fit(X[:400], y[:400])
        out[d] = (tree.score(X[:400], y[:400]), tree.score(X[400:], y[400:]))
    return out
