# Your work goes here. Generated from solution.py by make_exercises.py; run the tests with pytest.
"""Week 5: statistics, summaries, outliers, likelihood, regression and the bootstrap.

Describe data robustly, flag outliers with a rule you can explain, fit a distribution by maximum likelihood, fit a
regression by least squares, and put an interval round any statistic with the bootstrap.
"""

from collections.abc import Callable

import numpy as np


def make_delivery_times(seed: int = 0) -> np.ndarray:
    """Invented delivery times in hours: mostly near 30, plus a few parcels that went astray."""
    rng = np.random.default_rng(seed)
    return np.concatenate([rng.normal(30, 4, 195), [80.0, 95.0, 110.0, 2.0, 140.0]])


# EXERCISE
def summary(x: np.ndarray) -> dict[str, float]:
    """mean, median, sd (sample, ddof=1) and iqr (75th minus 25th percentile)."""
    raise NotImplementedError("TODO: write summary")


# EXERCISE
def iqr_outliers(x: np.ndarray, k: float = 1.5) -> np.ndarray:
    """A boolean mask: True for values below Q1 - k IQR or above Q3 + k IQR."""
    raise NotImplementedError("TODO: write iqr_outliers")


# EXERCISE
def normal_mle(x: np.ndarray) -> tuple[float, float]:
    """The maximum-likelihood mean and standard deviation of a normal distribution (the sd divides by n)."""
    raise NotImplementedError("TODO: write normal_mle")


# EXERCISE
def least_squares(X: np.ndarray, y: np.ndarray) -> np.ndarray:
    """Coefficients of y ~ intercept + X by least squares; the intercept comes first."""
    raise NotImplementedError("TODO: write least_squares")


# EXERCISE
def bootstrap_interval(
    x: np.ndarray, stat: Callable[[np.ndarray], float], n_boot: int, seed: int, level: float = 0.95
) -> tuple[float, float]:
    """A percentile bootstrap interval: resample x with replacement n_boot times, compute stat on each, take the
    middle `level` of the results."""
    raise NotImplementedError("TODO: write bootstrap_interval")
