# Your work goes here. Generated from solution.py by make_exercises.py; run the tests with pytest.
"""Week 14: Bayesian optimisation and Gaussian processes.

When each evaluation is expensive (a day of training, a lab experiment), spend thought instead of trials. A
Gaussian process gives a best guess and an uncertainty everywhere; expected improvement picks the next point by
weighing a good guess (exploit) against a large uncertainty (explore).
"""

from collections.abc import Callable

import numpy as np
from scipy.stats import norm


def mystery(x: np.ndarray) -> np.ndarray:
    """An invented 1-D objective on [0, 10] to maximise, with one broad hill and a narrower, higher one."""
    return np.exp(-((x - 2.5) ** 2) / 2) + 1.4 * np.exp(-((x - 7.6) ** 2) / 0.6)


# EXERCISE
def rbf(a: np.ndarray, b: np.ndarray, length: float, variance: float = 1.0) -> np.ndarray:
    """The squared-exponential covariance variance * exp(-(a_i - b_j)^2 / (2 length^2)) for 1-D inputs."""
    raise NotImplementedError("TODO: write rbf")


# EXERCISE
def gp_posterior(
    x_train: np.ndarray, y_train: np.ndarray, x: np.ndarray, length: float, noise: float = 1e-6
) -> tuple[np.ndarray, np.ndarray]:
    """The GP's mean and standard deviation at x given the training points (zero prior mean, unit variance)."""
    raise NotImplementedError("TODO: write gp_posterior")


# EXERCISE
def expected_improvement(mean: np.ndarray, std: np.ndarray, best: float, xi: float = 0.01) -> np.ndarray:
    """Expected improvement over `best` for maximisation; 0 where std is 0."""
    raise NotImplementedError("TODO: write expected_improvement")


# EXERCISE
def bayes_opt(
    f: Callable[[np.ndarray], np.ndarray], n_init: int, n_iter: int, seed: int, length: float = 1.0
) -> tuple[np.ndarray, np.ndarray]:
    """Maximise f on [0, 10]: n_init random points, then n_iter points each chosen by the highest expected
    improvement on a grid of 1,001 points. Returns all (x, y) evaluated, in order."""
    raise NotImplementedError("TODO: write bayes_opt")
