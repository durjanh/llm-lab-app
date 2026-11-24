# Your work goes here. Generated from solution.py by make_exercises.py; run the tests with pytest.
"""Week 12: naive Bayes and logistic regression.

Two probabilistic classifiers. Naive Bayes models how each class generates its features and inverts that with
Bayes' rule; logistic regression models the probability of the class directly and learns it by gradient descent
on the log loss.
"""

import numpy as np
from sklearn.datasets import make_classification


def make_data(seed: int = 0) -> tuple[np.ndarray, ...]:
    """An invented two-class problem, split 300 / 200 into train and test."""
    X, y = make_classification(n_samples=500, n_features=4, n_informative=3, n_redundant=0, random_state=seed)
    return X[:300], y[:300], X[300:], y[300:]


# EXERCISE
def gaussian_nb_fit(X: np.ndarray, y: np.ndarray) -> dict:
    """Per class: its prior (share of rows), and the mean and variance of each feature (variance divides by n).
    Returns {"classes", "priors", "means", "vars"} as arrays, one row per class."""
    raise NotImplementedError("TODO: write gaussian_nb_fit")


# EXERCISE
def gaussian_nb_predict(model: dict, X: np.ndarray) -> np.ndarray:
    """The class with the highest log prior plus summed log normal densities, for each row."""
    raise NotImplementedError("TODO: write gaussian_nb_predict")


# EXERCISE
def sigmoid(z: np.ndarray) -> np.ndarray:
    """1 / (1 + e^-z), squashing any score into a probability."""
    raise NotImplementedError("TODO: write sigmoid")


# EXERCISE
def log_loss(y: np.ndarray, p: np.ndarray) -> float:
    """Mean binary cross-entropy, with p clipped to [1e-12, 1 - 1e-12]."""
    raise NotImplementedError("TODO: write log_loss")


# EXERCISE
def logistic_fit(X: np.ndarray, y: np.ndarray, lr: float = 0.1, steps: int = 5000) -> tuple[np.ndarray, float]:
    """Logistic regression by gradient descent on the mean log loss, from zero weights. Returns (w, b)."""
    raise NotImplementedError("TODO: write logistic_fit")
