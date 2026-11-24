"""Week 18: hyperparameter tuning.

Compare three ways of spending a fixed budget of training runs: a grid, random search, and successive halving,
which starts many candidates cheaply and gives more budget only to the promising ones.
"""

import itertools

import numpy as np
from sklearn.datasets import make_classification
from sklearn.model_selection import cross_val_score
from sklearn.svm import SVC


def make_data(seed: int = 0) -> tuple[np.ndarray, np.ndarray]:
    """An invented classification problem where the SVM's C and gamma both matter."""
    return make_classification(n_samples=300, n_features=10, n_informative=5, flip_y=0.05, random_state=seed)


def svm_score(X: np.ndarray, y: np.ndarray, log_c: float, log_gamma: float) -> float:
    """3-fold cross-validated accuracy of an RBF SVM with C = 10^log_c and gamma = 10^log_gamma."""
    return float(cross_val_score(SVC(C=10**log_c, gamma=10**log_gamma), X, y, cv=3).mean())


# EXERCISE
def grid_search(score, c_values: list[float], gamma_values: list[float]) -> tuple[tuple[float, float], float]:
    """Try every (log_c, log_gamma) pair; return the best pair and its score. `score(log_c, log_gamma)`."""
    best = max(itertools.product(c_values, gamma_values), key=lambda p: score(*p))
    return best, score(*best)


# EXERCISE
def random_search(score, n: int, seed: int, c_range=(-2.0, 3.0), gamma_range=(-4.0, 1.0)):
    """Try n pairs drawn uniformly on the log scales; return the best pair and its score."""
    # With the same budget a grid tests only a few values of each setting; random points test n different
    # values of each, which wins when one setting matters much more than the other.
    rng = np.random.default_rng(seed)
    pairs = [(rng.uniform(*c_range), rng.uniform(*gamma_range)) for _ in range(n)]
    scores = [score(*p) for p in pairs]
    i = int(np.argmax(scores))
    return pairs[i], scores[i]


# EXERCISE
def successive_halving(candidates: list, evaluate, min_budget: int, rounds: int) -> tuple[object, int]:
    """Evaluate every candidate at min_budget, keep the better half, double the budget, repeat `rounds` times
    or until one is left. `evaluate(candidate, budget)` returns a score (higher is better). Returns (winner,
    total budget spent)."""
    # Bad candidates usually look bad early, so most of the budget goes to the few still in the running.
    alive, budget, spent = list(candidates), min_budget, 0
    for _ in range(rounds):
        scores = [evaluate(c, budget) for c in alive]
        spent += budget * len(alive)
        order = np.argsort(scores)[::-1]
        alive = [alive[i] for i in order[: max(1, len(alive) // 2)]]
        if len(alive) == 1:
            break
        budget *= 2
    return alive[0], spent


def noisy_quality(candidate: float, budget: int) -> float:
    """An invented learning curve: the true quality is -(candidate - 0.7)^2, measured with noise that shrinks as
    the budget grows, as a model trained for more epochs is judged more reliably."""
    rng = np.random.default_rng(int(candidate * 1e6) + budget)
    return -((candidate - 0.7) ** 2) + rng.normal(0, 0.05 / np.sqrt(budget))
