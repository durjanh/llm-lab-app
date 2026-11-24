# Your work goes here. Generated from solution.py by make_exercises.py; run the tests with pytest.
"""Week 7: measuring a classifier.

Accuracy alone hides the errors that matter. Build the confusion matrix and the rates read from it, trace the
ROC curve by sweeping the threshold, compute its area, and measure lift: how much richer in positives the
top-scored slice is than the whole.
"""

import numpy as np


def make_scores(n: int = 1000, seed: int = 0) -> tuple[np.ndarray, np.ndarray]:
    """Invented labels (about 10% positive) and a model's scores, higher on positives but overlapping."""
    rng = np.random.default_rng(seed)
    y = (rng.random(n) < 0.1).astype(int)
    scores = rng.normal(0, 1, n) + 1.5 * y
    return y, scores


# EXERCISE
def confusion(y: np.ndarray, pred: np.ndarray) -> dict[str, int]:
    """Counts tp, fp, tn and fn for 0/1 labels and predictions."""
    raise NotImplementedError("TODO: write confusion")


# EXERCISE
def rates(c: dict[str, int]) -> dict[str, float]:
    """accuracy, sensitivity (recall), specificity and precision from a confusion dict."""
    raise NotImplementedError("TODO: write rates")


# EXERCISE
def roc_curve(y: np.ndarray, scores: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """(false positive rates, true positive rates), one point per threshold, from (0, 0) to (1, 1)."""
    raise NotImplementedError("TODO: write roc_curve")


# EXERCISE
def area_under(fpr: np.ndarray, tpr: np.ndarray) -> float:
    """The area under the curve by the trapezium rule."""
    raise NotImplementedError("TODO: write area_under")


# EXERCISE
def lift(y: np.ndarray, scores: np.ndarray, top_fraction: float) -> float:
    """The positive rate in the top `top_fraction` of rows by score, divided by the overall positive rate."""
    raise NotImplementedError("TODO: write lift")
