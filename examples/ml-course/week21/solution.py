"""Week 21: interpretability, fairness and documentation.

Find out what a trained model relies on by shuffling one feature at a time, measure whether its errors fall
evenly across two groups, and write down what it is for and where it fails in a model card.
"""

import numpy as np
from sklearn.ensemble import RandomForestClassifier


def make_loans(n: int = 2000, seed: int = 0) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Invented loan data: income and debt decide repayment; `noise` decides nothing; `group` (0 or 1) is a
    protected attribute that is correlated with income. Returns (X with columns income, debt, noise; y; group)."""
    rng = np.random.default_rng(seed)
    group = rng.integers(0, 2, n)
    income = rng.normal(30 + 8 * group, 8, n)
    debt = rng.normal(10, 4, n)
    noise = rng.normal(0, 1, n)
    y = ((income - 1.5 * debt + rng.normal(0, 4, n)) > 15).astype(int)
    return np.column_stack([income, debt, noise]), y, group


FEATURES = ["income", "debt", "noise"]


def fit_model(X: np.ndarray, y: np.ndarray) -> RandomForestClassifier:
    """A random forest trained on the first 1,500 rows."""
    return RandomForestClassifier(200, min_samples_leaf=5, random_state=0).fit(X[:1500], y[:1500])


# EXERCISE
def permutation_importance(model, X: np.ndarray, y: np.ndarray, seed: int, repeats: int = 5) -> np.ndarray:
    """For each column, the mean drop in accuracy when that column is shuffled (others left alone), over
    `repeats` shuffles."""
    # Shuffling breaks the link between one feature and the answer while keeping its distribution, so the
    # accuracy lost is what the model was using that feature for. It works for any model.
    rng = np.random.default_rng(seed)
    base = model.score(X, y)
    drops = np.zeros(X.shape[1])
    for j in range(X.shape[1]):
        for _ in range(repeats):
            Xs = X.copy()
            Xs[:, j] = rng.permutation(Xs[:, j])
            drops[j] += base - model.score(Xs, y)
    return drops / repeats


# EXERCISE
def approval_rate_gap(pred: np.ndarray, group: np.ndarray) -> float:
    """Demographic parity difference: approval rate of group 1 minus that of group 0."""
    return float(pred[group == 1].mean() - pred[group == 0].mean())


# EXERCISE
def true_positive_rate_gap(y: np.ndarray, pred: np.ndarray, group: np.ndarray) -> float:
    """Equal opportunity difference: among people who did repay (y = 1), approval rate of group 1 minus group 0."""
    # Unlike the approval gap, this compares like with like: only people who would have repaid. Which gap
    # matters is a decision for the people the model affects, not a technical default.
    tpr = [pred[(group == g) & (y == 1)].mean() for g in (0, 1)]
    return float(tpr[1] - tpr[0])


# EXERCISE
def model_card(info: dict[str, str]) -> str:
    """A Markdown model card with "# <name>" and these sections in order, each "## <Title>" followed by its
    text: Intended use, Out of scope, Training data, Evaluation, Fairness, Limitations. Raise ValueError naming
    any missing key (name, intended_use, out_of_scope, training_data, evaluation, fairness, limitations)."""
    # The card's value is in the parts people skip: what it must not be used for, and where it is known to fail.
    keys = ["intended_use", "out_of_scope", "training_data", "evaluation", "fairness", "limitations"]
    missing = [k for k in ["name", *keys] if not info.get(k)]
    if missing:
        raise ValueError(f"missing: {', '.join(missing)}")
    parts = [f"# {info['name']}"]
    for k in keys:
        parts.append(f"## {k.replace('_', ' ').capitalize()}\n\n{info[k]}")
    return "\n\n".join(parts) + "\n"
