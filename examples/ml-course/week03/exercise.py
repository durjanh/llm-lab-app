# Your work goes here. Generated from solution.py by make_exercises.py; run the tests with pytest.
"""Week 3: what machine learning is, and data with missing values.

A model learns a rule from examples and is judged on examples it has not seen, so the first job is a fair split.
The second is missing values: measure them, fill them using the training rows only, and keep a flag, because the
fact that a value is missing is often itself informative.
"""

import numpy as np
import pandas as pd
from sklearn.impute import SimpleImputer


def make_patients(n: int = 200, seed: int = 0) -> pd.DataFrame:
    """Invented clinic records: age, weight and a blood test result, with some results not taken."""
    rng = np.random.default_rng(seed)
    df = pd.DataFrame(
        {
            "age": rng.integers(18, 90, n).astype(float),
            "weight": rng.normal(75, 12, n).round(1),
            "result": rng.normal(5.5, 1.2, n).round(2),
        }
    )
    # Older patients are more often tested, so a missing result says something about the patient.
    df.loc[rng.random(n) < np.where(df["age"] < 40, 0.4, 0.1), "result"] = np.nan
    df.loc[rng.random(n) < 0.05, "weight"] = np.nan
    return df


# EXERCISE
def split(df: pd.DataFrame, test_fraction: float, seed: int) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Shuffle the rows with the seed and return (train, test), the test part holding round(n * fraction) rows."""
    raise NotImplementedError("TODO: write split")


# EXERCISE
def missing_report(df: pd.DataFrame) -> dict[str, float]:
    """The fraction of missing values in each column."""
    raise NotImplementedError("TODO: write missing_report")


# EXERCISE
def fit_medians(train: pd.DataFrame) -> dict[str, float]:
    """The median of each column, computed on the training rows only."""
    raise NotImplementedError("TODO: write fit_medians")


# EXERCISE
def fill_missing(df: pd.DataFrame, medians: dict[str, float]) -> pd.DataFrame:
    """A copy with each gap filled from `medians` and a 0/1 column `<name>_missing` for every column that had one."""
    raise NotImplementedError("TODO: write fill_missing")


# EXERCISE
def fill_with_sklearn(train: pd.DataFrame, test: pd.DataFrame) -> np.ndarray:
    """The same median fill with scikit-learn's SimpleImputer (with add_indicator=True), fitted on train,
    applied to test."""
    raise NotImplementedError("TODO: write fill_with_sklearn")
