# Your work goes here. Generated from solution.py by make_exercises.py; run the tests with pytest.
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
    raise NotImplementedError("TODO: write mean_of")


# EXERCISE
def word_counts(text: str) -> dict[str, int]:
    """How often each word appears, lower-cased, with punctuation . , ! ? removed."""
    raise NotImplementedError("TODO: write word_counts")


# EXERCISE
def standardise(x: np.ndarray) -> np.ndarray:
    """Each column of a 2-D array rescaled to mean 0 and standard deviation 1, with NumPy and no loops."""
    raise NotImplementedError("TODO: write standardise")


# EXERCISE
def mean_by_group(df: pd.DataFrame, group: str, value: str) -> dict[str, float]:
    """The mean of column `value` for each distinct entry of column `group`, as a dict."""
    raise NotImplementedError("TODO: write mean_by_group")
