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
    # "Naive" means each feature is treated as independent within a class, so the model is just these numbers.
    classes = np.unique(y)
    return {
        "classes": classes,
        "priors": np.array([np.mean(y == c) for c in classes]),
        "means": np.array([X[y == c].mean(axis=0) for c in classes]),
        "vars": np.array([X[y == c].var(axis=0) for c in classes]),
    }


# EXERCISE
def gaussian_nb_predict(model: dict, X: np.ndarray) -> np.ndarray:
    """The class with the highest log prior plus summed log normal densities, for each row."""
    # Adding logs instead of multiplying densities avoids numbers too small for floating point.
    log_post = []
    for prior, mu, var in zip(model["priors"], model["means"], model["vars"]):
        log_lik = -0.5 * np.sum(np.log(2 * np.pi * var) + (X - mu) ** 2 / var, axis=1)
        log_post.append(np.log(prior) + log_lik)
    return model["classes"][np.argmax(log_post, axis=0)]


# EXERCISE
def sigmoid(z: np.ndarray) -> np.ndarray:
    """1 / (1 + e^-z), squashing any score into a probability."""
    return 1 / (1 + np.exp(-z))


# EXERCISE
def log_loss(y: np.ndarray, p: np.ndarray) -> float:
    """Mean binary cross-entropy, with p clipped to [1e-12, 1 - 1e-12]."""
    # Log loss punishes confident mistakes hard, which is what makes the probabilities honest, not just the labels.
    p = np.clip(p, 1e-12, 1 - 1e-12)
    return float(-np.mean(y * np.log(p) + (1 - y) * np.log(1 - p)))


# EXERCISE
def logistic_fit(X: np.ndarray, y: np.ndarray, lr: float = 0.1, steps: int = 5000) -> tuple[np.ndarray, float]:
    """Logistic regression by gradient descent on the mean log loss, from zero weights. Returns (w, b)."""
    # The gradient of the log loss is (p - y) times the input: the same shape as linear regression's.
    w = np.zeros(X.shape[1])
    b = 0.0
    for _ in range(steps):
        err = sigmoid(X @ w + b) - y
        w -= lr * X.T @ err / len(y)
        b -= lr * err.mean()
    return w, b
