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
    # Three parts because two jobs need unseen data: choosing the model (validation) and then reporting how
    # good the chosen one is (test). Reusing one set for both makes the reported number optimistic.
    order = np.random.default_rng(seed).permutation(n)
    n_val, n_test = round(n * val), round(n * test)
    return order[n_val + n_test :], order[:n_val], order[n_val : n_val + n_test]


# EXERCISE
def fit_polynomial(x: np.ndarray, y: np.ndarray, degree: int) -> np.ndarray:
    """Least-squares polynomial coefficients, highest power first (as np.polyval expects)."""
    return np.polyfit(x, y, degree)


# EXERCISE
def mse(coef: np.ndarray, x: np.ndarray, y: np.ndarray) -> float:
    """Mean squared error of the polynomial on (x, y)."""
    return float(np.mean((np.polyval(coef, x) - y) ** 2))


# EXERCISE
def error_by_degree(x: np.ndarray, y: np.ndarray, degrees: list[int], seed: int) -> dict[int, tuple[float, float]]:
    """For each degree, (training MSE, validation MSE) using three_way_split's train and validation parts."""
    # Low degrees underfit (high bias: both errors high); high degrees overfit (high variance: train error tiny,
    # validation error climbs). The best degree sits between.
    train, val, _ = three_way_split(len(x), seed)
    out = {}
    for d in degrees:
        coef = fit_polynomial(x[train], y[train], d)
        out[d] = (mse(coef, x[train], y[train]), mse(coef, x[val], y[val]))
    return out


# EXERCISE
def choose_degree(errors: dict[int, tuple[float, float]]) -> int:
    """The degree with the lowest validation error."""
    return min(errors, key=lambda d: errors[d][1])
