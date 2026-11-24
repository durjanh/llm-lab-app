# Your work goes here. Generated from solution.py by make_exercises.py; run the tests with pytest.
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
    raise NotImplementedError("TODO: write entropy")


# EXERCISE
def gini(y: np.ndarray) -> float:
    """Gini impurity: the chance two labels drawn at random (with replacement) differ."""
    raise NotImplementedError("TODO: write gini")


# EXERCISE
def best_threshold(x: np.ndarray, y: np.ndarray) -> tuple[float, float]:
    """The threshold t on one feature that most reduces weighted Gini impurity when splitting into x <= t and
    x > t. Returns (t, impurity decrease). Try the midpoints between consecutive distinct sorted values."""
    raise NotImplementedError("TODO: write best_threshold")


def make_data(seed: int = 0) -> tuple[np.ndarray, np.ndarray]:
    """An invented two-class problem with label noise, so a perfect fit is a sign of memorising."""
    return make_classification(n_samples=600, n_features=8, n_informative=4, flip_y=0.15, random_state=seed)


# EXERCISE
def accuracy_by_depth(X: np.ndarray, y: np.ndarray, depths: list[int | None]) -> dict:
    """Train on the first 400 rows, test on the rest. For each max_depth (None means unlimited), return
    (train accuracy, test accuracy) from scikit-learn's DecisionTreeClassifier(random_state=0)."""
    raise NotImplementedError("TODO: write accuracy_by_depth")
