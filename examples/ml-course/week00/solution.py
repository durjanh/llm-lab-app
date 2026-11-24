"""Week 0: orientation and tools.

The week checks your set-up and the three tools every later week uses: plain Python, NumPy arrays and pandas
tables. Each function below is short; the point is to see the same job done three ways and why arrays win.

Run the tests from examples/ml-course:  .venv/bin/pytest week00
"""

import numpy as np
import pandas as pd


# EXERCISE
def mean_of(values: list[float]) -> float:
    """The arithmetic mean of a list, in plain Python with a loop (no sum(), no NumPy)."""
    # A loop makes the work visible: one addition per value, then one division.
    total = 0.0
    for v in values:
        total += v
    return total / len(values)


# EXERCISE
def word_counts(text: str) -> dict[str, int]:
    """How often each word appears, lower-cased, with punctuation . , ! ? removed."""
    # Normalising first matters: "Cat" and "cat." should be one word, which is the first lesson in preparing data.
    cleaned = text.lower()
    for mark in ".,!?":
        cleaned = cleaned.replace(mark, " ")
    counts: dict[str, int] = {}
    for word in cleaned.split():
        counts[word] = counts.get(word, 0) + 1
    return counts


# EXERCISE
def standardise(x: np.ndarray) -> np.ndarray:
    """Each column of a 2-D array rescaled to mean 0 and standard deviation 1, with NumPy and no loops."""
    # Broadcasting applies the column means and spreads to every row at once; this is why arrays replace loops.
    return (x - x.mean(axis=0)) / x.std(axis=0)


# EXERCISE
def mean_by_group(df: pd.DataFrame, group: str, value: str) -> dict[str, float]:
    """The mean of column `value` for each distinct entry of column `group`, as a dict."""
    # groupby is pandas' split-apply-combine: split rows by group, average each part, put the answers together.
    return df.groupby(group)[value].mean().to_dict()
