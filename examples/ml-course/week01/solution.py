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
    # Multiply matching entries and add them up: a weighted sum, which is what one neuron computes.
    if len(u) != len(v):
        raise ValueError("vectors must have the same length")
    return sum(a * b for a, b in zip(u, v))


# EXERCISE
def matmul(a: list[list[float]], b: list[list[float]]) -> list[list[float]]:
    """The matrix product a @ b with loops. Entry (i, j) is the dot product of row i of a and column j of b."""
    if len(a[0]) != len(b):
        raise ValueError("inner dimensions differ")
    columns = list(zip(*b))
    return [[dot(row, list(col)) for col in columns] for row in a]


# EXERCISE
def cosine_similarity(u: np.ndarray, v: np.ndarray) -> float:
    """The cosine of the angle between two vectors: 1 for the same direction, 0 at right angles, -1 opposite."""
    # Dividing by both lengths removes size, leaving direction; this is how embeddings are compared.
    return float(u @ v / (np.linalg.norm(u) * np.linalg.norm(v)))


# EXERCISE
def derivative(f: Callable[[float], float], x: float, h: float = 1e-5) -> float:
    """The derivative of f at x by the central difference (f(x+h) - f(x-h)) / 2h."""
    # The central difference's error shrinks with h squared, against h for the one-sided version.
    return (f(x + h) - f(x - h)) / (2 * h)


# EXERCISE
def gradient(f: Callable[[np.ndarray], float], x: np.ndarray, h: float = 1e-5) -> np.ndarray:
    """The gradient of f at x: one central difference per coordinate, the others held still."""
    # Each partial derivative nudges one coordinate. Backpropagation gets the same numbers far more cheaply,
    # and this slow version is how its answers are checked ("gradient checking").
    g = np.zeros_like(x, dtype=float)
    for i in range(len(x)):
        step = np.zeros_like(x, dtype=float)
        step[i] = h
        g[i] = (f(x + step) - f(x - step)) / (2 * h)
    return g


def sample_function(x: float) -> float:
    """A function to differentiate in the tests: sin(x) times x squared."""
    return math.sin(x) * x**2
