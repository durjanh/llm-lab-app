# Your work goes here. Generated from solution.py by make_exercises.py; run the tests with pytest.
"""Week 4: probability, Bayes' rule, distributions and Monte Carlo.

Work out a test result with Bayes' rule and see how a rare condition makes a good test look poor. Then build a
distribution from its formula, and estimate things by simulation when the exact answer is awkward.
"""

import math

import numpy as np


# EXERCISE
def posterior_positive(prevalence: float, sensitivity: float, specificity: float) -> float:
    """P(condition | positive test) by Bayes' rule."""
    raise NotImplementedError("TODO: write posterior_positive")


# EXERCISE
def binomial_pmf(k: int, n: int, p: float) -> float:
    """P(exactly k successes in n independent tries, each with probability p), from the formula."""
    raise NotImplementedError("TODO: write binomial_pmf")


# EXERCISE
def estimate_pi(n: int, seed: int) -> float:
    """Monte Carlo: the share of n random points in the unit square that fall inside the quarter circle, times 4."""
    raise NotImplementedError("TODO: write estimate_pi")


# EXERCISE
def shared_birthday_exact(people: int) -> float:
    """The probability that at least two of `people` share a birthday (365 equally likely days)."""
    raise NotImplementedError("TODO: write shared_birthday_exact")


# EXERCISE
def shared_birthday_simulated(people: int, trials: int, seed: int) -> float:
    """The same probability estimated by simulating `trials` rooms of people."""
    raise NotImplementedError("TODO: write shared_birthday_simulated")
