# Your work goes here. Generated from solution.py by make_exercises.py; run the tests with pytest.
"""Week 1: maths I, vectors, matrices and derivatives.

Write the operations machine learning is built from with loops first, then check them against NumPy. A model's
prediction is mostly dot products and matrix products; training is mostly derivatives.
"""

import math
from collections.abc import Callable

import numpy as np


# EXERCISE
def dot(u: list[float], v: list[float]) -> float:
    """The dot product of two equal-length vectors, with a loop."""
    raise NotImplementedError("TODO: write dot")


# EXERCISE
def matmul(a: list[list[float]], b: list[list[float]]) -> list[list[float]]:
    """The matrix product a @ b with loops. Entry (i, j) is the dot product of row i of a and column j of b."""
    raise NotImplementedError("TODO: write matmul")


# EXERCISE
def cosine_similarity(u: np.ndarray, v: np.ndarray) -> float:
    """The cosine of the angle between two vectors: 1 for the same direction, 0 at right angles, -1 opposite."""
    raise NotImplementedError("TODO: write cosine_similarity")


# EXERCISE
def derivative(f: Callable[[float], float], x: float, h: float = 1e-5) -> float:
    """The derivative of f at x by the central difference (f(x+h) - f(x-h)) / 2h."""
    raise NotImplementedError("TODO: write derivative")


# EXERCISE
def gradient(f: Callable[[np.ndarray], float], x: np.ndarray, h: float = 1e-5) -> np.ndarray:
    """The gradient of f at x: one central difference per coordinate, the others held still."""
    raise NotImplementedError("TODO: write gradient")


def sample_function(x: float) -> float:
    """A function to differentiate in the tests: sin(x) times x squared."""
    return math.sin(x) * x**2
