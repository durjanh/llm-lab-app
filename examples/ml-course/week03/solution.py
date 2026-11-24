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
    # Shuffling first matters when rows arrive in an order (by date, by clinic); a split of sorted rows would
    # test on a different population from the one trained on.
    order = np.random.default_rng(seed).permutation(len(df))
    n_test = round(len(df) * test_fraction)
    return df.iloc[order[n_test:]], df.iloc[order[:n_test]]


# EXERCISE
def missing_report(df: pd.DataFrame) -> dict[str, float]:
    """The fraction of missing values in each column."""
    return df.isna().mean().to_dict()


# EXERCISE
def fit_medians(train: pd.DataFrame) -> dict[str, float]:
    """The median of each column, computed on the training rows only."""
    # Fitting on train alone is the point: the test rows stand for the future, which you cannot look at.
    return train.median().to_dict()


# EXERCISE
def fill_missing(df: pd.DataFrame, medians: dict[str, float]) -> pd.DataFrame:
    """A copy with each gap filled from `medians` and a 0/1 column `<name>_missing` for every column that had one."""
    # The flag keeps what the gap told us (here, a younger patient) after the gap itself has been filled.
    out = df.copy()
    for col in df.columns:
        if df[col].isna().any():
            out[f"{col}_missing"] = df[col].isna().astype(int)
            out[col] = df[col].fillna(medians[col])
    return out


# EXERCISE
def fill_with_sklearn(train: pd.DataFrame, test: pd.DataFrame) -> np.ndarray:
    """The same median fill with scikit-learn's SimpleImputer (with add_indicator=True), fitted on train,
    applied to test."""
    return SimpleImputer(strategy="median", add_indicator=True).fit(train).transform(test)
