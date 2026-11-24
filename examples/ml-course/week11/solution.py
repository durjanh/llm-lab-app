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
    # About 63% of rows appear at least once (1 - 1/e); the rest are "out of bag" and can score the tree.
    return rng.integers(0, n, n)


# EXERCISE
def bagged_trees(X: np.ndarray, y: np.ndarray, X_new: np.ndarray, n_trees: int, seed: int) -> np.ndarray:
    """Grow n_trees unlimited-depth DecisionTreeClassifier(random_state=i) on bootstrap samples and return the
    majority vote for X_new (ties go to class 1)."""
    # Each tree overfits differently; their errors partly cancel in the vote, so variance falls while bias stays.
    rng = np.random.default_rng(seed)
    votes = np.zeros(len(X_new))
    for i in range(n_trees):
        idx = bootstrap_indices(len(X), rng)
        votes += DecisionTreeClassifier(random_state=i).fit(X[idx], y[idx]).predict(X_new)
    return (votes >= n_trees / 2).astype(int)


# EXERCISE
def boost_regression(x: np.ndarray, y: np.ndarray, rounds: int, lr: float) -> list[DecisionTreeRegressor]:
    """Gradient boosting for squared error, by hand: start from the mean, then each round fit a depth-2
    DecisionTreeRegressor(random_state=0) to the current residuals and add lr times its prediction. Returns the
    trees; the start value is y.mean(). x is one-dimensional."""
    # Residuals are the negative gradient of squared error, so fitting them is gradient descent in function
    # space. A small lr with many rounds generalises better than a few big steps.
    pred = np.full(len(y), y.mean())
    trees = []
    for _ in range(rounds):
        tree = DecisionTreeRegressor(max_depth=2, random_state=0).fit(x.reshape(-1, 1), y - pred)
        pred += lr * tree.predict(x.reshape(-1, 1))
        trees.append(tree)
    return trees


def boosted_predict(trees: list, start: float, lr: float, x: np.ndarray) -> np.ndarray:
    """Predictions of a boost_regression model."""
    return start + lr * sum(t.predict(x.reshape(-1, 1)) for t in trees)


# EXERCISE
def compare(seed: int = 0) -> dict[str, float]:
    """Test accuracy of: one unlimited tree, bagged_trees (50), RandomForestClassifier(200, random_state=0) and
    GradientBoostingClassifier(random_state=0), all on make_data(seed)."""
    X, y, Xt, yt = make_data(seed)
    return {
        "tree": DecisionTreeClassifier(random_state=0).fit(X, y).score(Xt, yt),
        "bagging": float(np.mean(bagged_trees(X, y, Xt, 50, seed) == yt)),
        "forest": RandomForestClassifier(200, random_state=0).fit(X, y).score(Xt, yt),
        "boosting": GradientBoostingClassifier(random_state=0).fit(X, y).score(Xt, yt),
    }
