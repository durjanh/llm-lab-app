# Your work goes here. Generated from solution.py by make_exercises.py; run the tests with pytest.
"""Week 2: maths II, gradient descent and optimisers.

Minimise functions by walking downhill. Compare plain gradient descent, momentum and Adam on a long, narrow
valley, where plain steps zigzag, then fit a straight line by gradient descent and check it against least squares.
"""

from collections.abc import Callable

import numpy as np

Grad = Callable[[np.ndarray], np.ndarray]


def valley(p: np.ndarray) -> float:
    """A long, narrow bowl: steep across (y), shallow along (x). Its minimum is 0 at (0, 0)."""
    return 0.5 * (p[0] ** 2 + 25 * p[1] ** 2)


def valley_grad(p: np.ndarray) -> np.ndarray:
    """The gradient of `valley`."""
    return np.array([p[0], 25 * p[1]])


# EXERCISE
def gradient_descent(grad: Grad, x0: np.ndarray, lr: float, steps: int) -> np.ndarray:
    """Plain gradient descent. Returns the path, one row per position, starting with x0 (steps + 1 rows)."""
    raise NotImplementedError("TODO: write gradient_descent")


# EXERCISE
def momentum(grad: Grad, x0: np.ndarray, lr: float, steps: int, beta: float = 0.9) -> np.ndarray:
    """Gradient descent with momentum: velocity v = beta * v + grad, then x -= lr * v. Returns the path."""
    raise NotImplementedError("TODO: write momentum")


# EXERCISE
def adam(grad: Grad, x0: np.ndarray, lr: float, steps: int, b1: float = 0.9, b2: float = 0.999) -> np.ndarray:
    """Adam with bias correction (eps 1e-8). Returns the path."""
    raise NotImplementedError("TODO: write adam")


# EXERCISE
def fit_line_gd(x: np.ndarray, y: np.ndarray, lr: float = 0.1, steps: int = 2000) -> tuple[float, float]:
    """Fit y = a x + b by gradient descent on the mean squared error, starting from a = b = 0. Returns (a, b)."""
    raise NotImplementedError("TODO: write fit_line_gd")
