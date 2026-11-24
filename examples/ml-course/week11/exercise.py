# Your work goes here. Generated from solution.py by make_exercises.py; run the tests with pytest.
"""Week 11: ensembles, bagging, random forests and boosting.

One deep tree is unstable: change a few rows and it changes a lot. Average many trees grown on bootstrap samples
(bagging), add random feature choice (a random forest), or grow small trees one after another, each fixing the
last one's errors (boosting).
"""

import numpy as np
from sklearn.datasets import make_moons
from sklearn.ensemble import GradientBoostingClassifier, RandomForestClassifier
from sklearn.tree import DecisionTreeClassifier, DecisionTreeRegressor


def make_data(seed: int = 0) -> tuple[np.ndarray, ...]:
    """Noisy half-moons, split 400 / 400 into train and test."""
    X, y = make_moons(n_samples=800, noise=0.35, random_state=seed)
    return X[:400], y[:400], X[400:], y[400:]


# EXERCISE
def bootstrap_indices(n: int, rng: np.random.Generator) -> np.ndarray:
    """n row indices drawn with replacement."""
    raise NotImplementedError("TODO: write bootstrap_indices")


# EXERCISE
def bagged_trees(X: np.ndarray, y: np.ndarray, X_new: np.ndarray, n_trees: int, seed: int) -> np.ndarray:
    """Grow n_trees unlimited-depth DecisionTreeClassifier(random_state=i) on bootstrap samples and return the
    majority vote for X_new (ties go to class 1)."""
    raise NotImplementedError("TODO: write bagged_trees")


# EXERCISE
def boost_regression(x: np.ndarray, y: np.ndarray, rounds: int, lr: float) -> list[DecisionTreeRegressor]:
    """Gradient boosting for squared error, by hand: start from the mean, then each round fit a depth-2
    DecisionTreeRegressor(random_state=0) to the current residuals and add lr times its prediction. Returns the
    trees; the start value is y.mean(). x is one-dimensional."""
    raise NotImplementedError("TODO: write boost_regression")


def boosted_predict(trees: list, start: float, lr: float, x: np.ndarray) -> np.ndarray:
    """Predictions of a boost_regression model."""
    return start + lr * sum(t.predict(x.reshape(-1, 1)) for t in trees)


# EXERCISE
def compare(seed: int = 0) -> dict[str, float]:
    """Test accuracy of: one unlimited tree, bagged_trees (50), RandomForestClassifier(200, random_state=0) and
    GradientBoostingClassifier(random_state=0), all on make_data(seed)."""
    raise NotImplementedError("TODO: write compare")
