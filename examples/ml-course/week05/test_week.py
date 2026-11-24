"""Week 5 checks: robust summaries, the outlier rule, MLE, regression and a bootstrap interval."""

import numpy as np
import pytest
from scipy import stats


def test_median_resists_outliers(mod):
    s = mod.summary(mod.make_delivery_times())
    assert abs(s["median"] - 30) < 1.5
    assert s["mean"] > s["median"]
    assert s["sd"] > s["iqr"] / 1.35  # for normal data sd is about IQR / 1.35; outliers push sd above it


def test_outlier_rule_finds_the_lost_parcels(mod):
    x = mod.make_delivery_times()
    flagged = set(np.round(x[mod.iqr_outliers(x)], 1))
    assert {80.0, 95.0, 110.0, 140.0, 2.0} <= flagged
    assert len(flagged) <= 8


def test_mle_matches_scipy(mod):
    x = np.random.default_rng(3).normal(10, 2, 500)
    mu, sd = mod.normal_mle(x)
    ref_mu, ref_sd = stats.norm.fit(x)
    assert mu == pytest.approx(ref_mu) and sd == pytest.approx(ref_sd)


def test_least_squares_recovers_coefficients(mod):
    rng = np.random.default_rng(4)
    X = rng.normal(size=(300, 2))
    y = 1.5 + 2 * X[:, 0] - 3 * X[:, 1] + rng.normal(0, 0.1, 300)
    assert np.allclose(mod.least_squares(X, y), [1.5, 2, -3], atol=0.05)


def test_bootstrap_interval_contains_the_median(mod):
    x = mod.make_delivery_times()
    lo, hi = mod.bootstrap_interval(x, np.median, 2000, seed=0)
    assert lo < np.median(x) < hi
    assert hi - lo < 4
