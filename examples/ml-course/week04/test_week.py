"""Week 4 checks against worked answers, SciPy and the exact results."""

import math

import pytest
from scipy import stats


def test_rare_condition_makes_most_positives_false(mod):
    # 1 in 1,000, with a test 99% sensitive and 95% specific: about 2% of positives have the condition.
    p = mod.posterior_positive(0.001, 0.99, 0.95)
    assert p == pytest.approx(0.0194, abs=1e-3)


def test_common_condition(mod):
    assert mod.posterior_positive(0.5, 0.9, 0.9) == pytest.approx(0.9)


def test_binomial_matches_scipy(mod):
    for k in range(11):
        assert mod.binomial_pmf(k, 10, 0.3) == pytest.approx(stats.binom.pmf(k, 10, 0.3))


def test_estimate_pi(mod):
    assert abs(mod.estimate_pi(200_000, seed=0) - math.pi) < 0.02


def test_birthdays(mod):
    assert mod.shared_birthday_exact(23) == pytest.approx(0.5073, abs=1e-4)
    assert abs(mod.shared_birthday_simulated(23, 20_000, seed=0) - 0.5073) < 0.02
