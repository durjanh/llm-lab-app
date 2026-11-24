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
    return {
        "tp": int(np.sum((pred == 1) & (y == 1))),
        "fp": int(np.sum((pred == 1) & (y == 0))),
        "tn": int(np.sum((pred == 0) & (y == 0))),
        "fn": int(np.sum((pred == 0) & (y == 1))),
    }


# EXERCISE
def rates(c: dict[str, int]) -> dict[str, float]:
    """accuracy, sensitivity (recall), specificity and precision from a confusion dict."""
    # Sensitivity asks "of the real positives, how many did we catch?"; specificity the same for negatives;
    # precision "of those we flagged, how many were right?". Which matters depends on the cost of each error.
    total = sum(c.values())
    return {
        "accuracy": (c["tp"] + c["tn"]) / total,
        "sensitivity": c["tp"] / (c["tp"] + c["fn"]),
        "specificity": c["tn"] / (c["tn"] + c["fp"]),
        "precision": c["tp"] / (c["tp"] + c["fp"]) if c["tp"] + c["fp"] else 0.0,
    }


# EXERCISE
def roc_curve(y: np.ndarray, scores: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """(false positive rates, true positive rates), one point per threshold, from (0, 0) to (1, 1)."""
    # Sorting by score and walking down the list lowers the threshold one row at a time: each positive passed
    # moves the curve up, each negative moves it right.
    order = np.argsort(-scores, kind="stable")
    ys = y[order]
    tpr = np.concatenate([[0], np.cumsum(ys) / ys.sum()])
    fpr = np.concatenate([[0], np.cumsum(1 - ys) / (1 - ys).sum()])
    return fpr, tpr


# EXERCISE
def area_under(fpr: np.ndarray, tpr: np.ndarray) -> float:
    """The area under the curve by the trapezium rule."""
    # AUC is the chance that a random positive scores above a random negative: 0.5 is guessing, 1 is perfect.
    return float(np.sum(np.diff(fpr) * (tpr[1:] + tpr[:-1]) / 2))


# EXERCISE
def lift(y: np.ndarray, scores: np.ndarray, top_fraction: float) -> float:
    """The positive rate in the top `top_fraction` of rows by score, divided by the overall positive rate."""
    # Lift answers the business question: if we can only call the top 10%, how much better than calling at random?
    n_top = int(round(len(y) * top_fraction))
    top = np.argsort(-scores, kind="stable")[:n_top]
    return float(y[top].mean() / y.mean())
