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
    # Nearby inputs get similar outputs; `length` says how near is near.
    return variance * np.exp(-((a[:, None] - b[None, :]) ** 2) / (2 * length**2))


# EXERCISE
def gp_posterior(
    x_train: np.ndarray, y_train: np.ndarray, x: np.ndarray, length: float, noise: float = 1e-6
) -> tuple[np.ndarray, np.ndarray]:
    """The GP's mean and standard deviation at x given the training points (zero prior mean, unit variance)."""
    # Solve with a Cholesky factor rather than inverting K: it is faster and numerically stable.
    K = rbf(x_train, x_train, length) + noise * np.eye(len(x_train))
    L = np.linalg.cholesky(K)
    alpha = np.linalg.solve(L.T, np.linalg.solve(L, y_train))
    Ks = rbf(x_train, x, length)
    mean = Ks.T @ alpha
    v = np.linalg.solve(L, Ks)
    var = np.maximum(1.0 - np.sum(v**2, axis=0), 0)
    return mean, np.sqrt(var)


# EXERCISE
def expected_improvement(mean: np.ndarray, std: np.ndarray, best: float, xi: float = 0.01) -> np.ndarray:
    """Expected improvement over `best` for maximisation; 0 where std is 0."""
    # EI is large where the guess is already high, or where the GP is unsure and could be high: both are worth a look.
    with np.errstate(divide="ignore", invalid="ignore"):
        z = (mean - best - xi) / std
        ei = (mean - best - xi) * norm.cdf(z) + std * norm.pdf(z)
    return np.where(std > 0, ei, 0.0)


# EXERCISE
def bayes_opt(
    f: Callable[[np.ndarray], np.ndarray], n_init: int, n_iter: int, seed: int, length: float = 1.0
) -> tuple[np.ndarray, np.ndarray]:
    """Maximise f on [0, 10]: n_init random points, then n_iter points each chosen by the highest expected
    improvement on a grid of 1,001 points. Returns all (x, y) evaluated, in order."""
    rng = np.random.default_rng(seed)
    grid = np.linspace(0, 10, 1001)
    x = rng.uniform(0, 10, n_init)
    y = f(x)
    for _ in range(n_iter):
        mean, std = gp_posterior(x, y, grid, length)
        nxt = grid[np.argmax(expected_improvement(mean, std, y.max()))]
        x, y = np.append(x, nxt), np.append(y, f(np.array([nxt])))
    return x, y
