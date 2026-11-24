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
    # The mean and sd are pulled about by a few extreme values; the median and IQR barely move. Reporting both
    # pairs shows whether a handful of rows are driving the story.
    q1, q3 = np.percentile(x, [25, 75])
    return {"mean": float(x.mean()), "median": float(np.median(x)), "sd": float(x.std(ddof=1)), "iqr": float(q3 - q1)}


# EXERCISE
def iqr_outliers(x: np.ndarray, k: float = 1.5) -> np.ndarray:
    """A boolean mask: True for values below Q1 - k IQR or above Q3 + k IQR."""
    # A rule built from quartiles is not fooled by the outliers it is looking for, unlike mean +- 3 sd, where
    # big outliers inflate the sd and hide themselves.
    q1, q3 = np.percentile(x, [25, 75])
    spread = q3 - q1
    return (x < q1 - k * spread) | (x > q3 + k * spread)


# EXERCISE
def normal_mle(x: np.ndarray) -> tuple[float, float]:
    """The maximum-likelihood mean and standard deviation of a normal distribution (the sd divides by n)."""
    # Setting the derivative of the log-likelihood to zero gives the sample mean and the n-divisor variance.
    mu = float(x.mean())
    return mu, float(np.sqrt(np.mean((x - mu) ** 2)))


# EXERCISE
def least_squares(X: np.ndarray, y: np.ndarray) -> np.ndarray:
    """Coefficients of y ~ intercept + X by least squares; the intercept comes first."""
    # A column of ones carries the intercept. lstsq solves the normal equations stably, without forming an
    # inverse.
    design = np.column_stack([np.ones(len(X)), X])
    coef, *_ = np.linalg.lstsq(design, y, rcond=None)
    return coef


# EXERCISE
def bootstrap_interval(
    x: np.ndarray, stat: Callable[[np.ndarray], float], n_boot: int, seed: int, level: float = 0.95
) -> tuple[float, float]:
    """A percentile bootstrap interval: resample x with replacement n_boot times, compute stat on each, take the
    middle `level` of the results."""
    # Resampling the data you have stands in for collecting new samples, so the spread of the statistic across
    # resamples estimates its uncertainty. It works for the median, where there is no simple formula.
    rng = np.random.default_rng(seed)
    values = [stat(rng.choice(x, size=len(x), replace=True)) for _ in range(n_boot)]
    tail = (1 - level) / 2 * 100
    lo, hi = np.percentile(values, [tail, 100 - tail])
    return float(lo), float(hi)
