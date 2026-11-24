"""Week 4: probability, Bayes' rule, distributions and Monte Carlo.

Work out a test result with Bayes' rule and see how a rare condition makes a good test look poor. Then build a
distribution from its formula, and estimate things by simulation when the exact answer is awkward.
"""

import math

import numpy as np


# EXERCISE
def posterior_positive(prevalence: float, sensitivity: float, specificity: float) -> float:
    """P(condition | positive test) by Bayes' rule."""
    # Positives come from two places: true positives among the few who have it, and false positives among the
    # many who do not. With a rare condition the second group can be the larger one.
    true_pos = prevalence * sensitivity
    false_pos = (1 - prevalence) * (1 - specificity)
    return true_pos / (true_pos + false_pos)


# EXERCISE
def binomial_pmf(k: int, n: int, p: float) -> float:
    """P(exactly k successes in n independent tries, each with probability p), from the formula."""
    # n choose k counts the orders the successes can come in; each order has the same probability.
    return math.comb(n, k) * p**k * (1 - p) ** (n - k)


# EXERCISE
def estimate_pi(n: int, seed: int) -> float:
    """Monte Carlo: the share of n random points in the unit square that fall inside the quarter circle, times 4."""
    # The quarter circle covers pi/4 of the square, so the hit rate estimates pi/4. The error shrinks like
    # 1/sqrt(n): a hundred times more points for one more correct digit.
    pts = np.random.default_rng(seed).random((n, 2))
    return 4 * float(np.mean((pts**2).sum(axis=1) <= 1))


# EXERCISE
def shared_birthday_exact(people: int) -> float:
    """The probability that at least two of `people` share a birthday (365 equally likely days)."""
    # Easier from the other side: the chance that all birthdays differ, one person at a time.
    all_differ = 1.0
    for i in range(people):
        all_differ *= (365 - i) / 365
    return 1 - all_differ


# EXERCISE
def shared_birthday_simulated(people: int, trials: int, seed: int) -> float:
    """The same probability estimated by simulating `trials` rooms of people."""
    rng = np.random.default_rng(seed)
    days = rng.integers(0, 365, size=(trials, people))
    # Sorting each room puts equal birthdays next to each other.
    days.sort(axis=1)
    return float(np.mean((np.diff(days, axis=1) == 0).any(axis=1)))
