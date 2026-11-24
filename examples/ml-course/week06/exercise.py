# Your work goes here. Generated from solution.py by make_exercises.py; run the tests with pytest.
"""Week 6: generalisation, splits, and bias against variance.

Fit polynomials of rising degree to noisy data. Training error keeps falling; validation error falls and then
rises. Choose the degree on validation, and report the test error once, at the end.
"""

import numpy as np


def make_curve(n: int = 60, seed: int = 0) -> tuple[np.ndarray, np.ndarray]:
    """Noisy samples of an invented smooth curve on [-1, 1]."""
    rng = np.random.default_rng(seed)
    x = rng.uniform(-1, 1, n)
    return x, np.sin(2.5 * x) + 0.3 * x + rng.normal(0, 0.2, n)


# EXERCISE
def three_way_split(n: int, seed: int, val: float = 0.2, test: float = 0.2) -> tuple[np.ndarray, ...]:
    """Shuffled index arrays (train, validation, test) for n rows."""
    raise NotImplementedError("TODO: write three_way_split")


# EXERCISE
def fit_polynomial(x: np.ndarray, y: np.ndarray, degree: int) -> np.ndarray:
    """Least-squares polynomial coefficients, highest power first (as np.polyval expects)."""
    raise NotImplementedError("TODO: write fit_polynomial")


# EXERCISE
def mse(coef: np.ndarray, x: np.ndarray, y: np.ndarray) -> float:
    """Mean squared error of the polynomial on (x, y)."""
    raise NotImplementedError("TODO: write mse")


# EXERCISE
def error_by_degree(x: np.ndarray, y: np.ndarray, degrees: list[int], seed: int) -> dict[int, tuple[float, float]]:
    """For each degree, (training MSE, validation MSE) using three_way_split's train and validation parts."""
    raise NotImplementedError("TODO: write error_by_degree")


# EXERCISE
def choose_degree(errors: dict[int, tuple[float, float]]) -> int:
    """The degree with the lowest validation error."""
    raise NotImplementedError("TODO: write choose_degree")
