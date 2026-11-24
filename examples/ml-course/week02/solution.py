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
    # Each step moves against the gradient, the direction of steepest climb, by lr times its size.
    path = [np.asarray(x0, dtype=float)]
    for _ in range(steps):
        path.append(path[-1] - lr * grad(path[-1]))
    return np.array(path)


# EXERCISE
def momentum(grad: Grad, x0: np.ndarray, lr: float, steps: int, beta: float = 0.9) -> np.ndarray:
    """Gradient descent with momentum: velocity v = beta * v + grad, then x -= lr * v. Returns the path."""
    # Momentum averages recent gradients: the zigzag across the valley cancels out while the steady pull along
    # it adds up, so progress along the floor speeds up.
    x = np.asarray(x0, dtype=float)
    v = np.zeros_like(x)
    path = [x]
    for _ in range(steps):
        v = beta * v + grad(x)
        x = x - lr * v
        path.append(x)
    return np.array(path)


# EXERCISE
def adam(grad: Grad, x0: np.ndarray, lr: float, steps: int, b1: float = 0.9, b2: float = 0.999) -> np.ndarray:
    """Adam with bias correction (eps 1e-8). Returns the path."""
    # Adam divides each coordinate's step by a running size of its gradient, so a steep direction and a shallow
    # one get steps of similar length. The bias correction stops the first steps being tiny while the running
    # averages, which start at zero, warm up.
    x = np.asarray(x0, dtype=float)
    m = np.zeros_like(x)
    s = np.zeros_like(x)
    path = [x]
    for t in range(1, steps + 1):
        g = grad(x)
        m = b1 * m + (1 - b1) * g
        s = b2 * s + (1 - b2) * g**2
        m_hat = m / (1 - b1**t)
        s_hat = s / (1 - b2**t)
        x = x - lr * m_hat / (np.sqrt(s_hat) + 1e-8)
        path.append(x)
    return np.array(path)


# EXERCISE
def fit_line_gd(x: np.ndarray, y: np.ndarray, lr: float = 0.1, steps: int = 2000) -> tuple[float, float]:
    """Fit y = a x + b by gradient descent on the mean squared error, starting from a = b = 0. Returns (a, b)."""
    # The MSE gradient is the average of error times input (for a) and the average error (for b).
    a = b = 0.0
    for _ in range(steps):
        err = a * x + b - y
        a -= lr * 2 * np.mean(err * x)
        b -= lr * 2 * np.mean(err)
    return a, b
