"""Week 10 checks: impurity measures, the split search, and the overfitting a deep tree shows."""

import numpy as np
import pytest


def test_entropy(mod):
    assert mod.entropy(np.array([1, 1, 1])) == 0
    assert mod.entropy(np.array([0, 1, 0, 1])) == pytest.approx(1)
    assert mod.entropy(np.array([0, 1, 2, 3])) == pytest.approx(2)


def test_gini(mod):
    assert mod.gini(np.array([2, 2])) == 0
    assert mod.gini(np.array([0, 1])) == pytest.approx(0.5)


def test_best_threshold_separates_cleanly(mod):
    x = np.array([1.0, 2.0, 3.0, 10.0, 11.0, 12.0])
    y = np.array([0, 0, 0, 1, 1, 1])
    t, gain = mod.best_threshold(x, y)
    assert t == pytest.approx(6.5)
    assert gain == pytest.approx(0.5)


def test_unlimited_depth_memorises(mod):
    X, y = mod.make_data()
    res = mod.accuracy_by_depth(X, y, [2, 4, None])
    assert res[None][0] == 1.0  # every training row right
    assert res[None][1] < res[None][0] - 0.15  # and much worse on new rows
    assert max(res[2][1], res[4][1]) >= res[None][1]
