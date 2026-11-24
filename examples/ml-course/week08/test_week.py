"""Week 8 checks: folds partition the rows, stratification keeps the class balance, and the leak shows."""

import numpy as np


def test_kfold_partitions(mod):
    folds = mod.kfold(103, 5, seed=0)
    assert len(folds) == 5
    assert sorted(np.concatenate(folds)) == list(range(103))
    assert max(map(len, folds)) - min(map(len, folds)) <= 1


def test_stratified_keeps_rare_class_in_every_fold(mod):
    y = np.array([1] * 10 + [0] * 90)
    folds = mod.stratified_kfold(y, 5, seed=0)
    assert sorted(np.concatenate(folds)) == list(range(100))
    assert all(y[f].sum() == 2 for f in folds)


def test_oversample_balances(mod):
    X = np.arange(20).reshape(10, 2)
    y = np.array([1, 1, 0, 0, 0, 0, 0, 0, 0, 0])
    X2, y2 = mod.oversample(X, y, seed=0)
    assert (y2 == 1).sum() == (y2 == 0).sum() == 8
    assert set(map(tuple, X2[y2 == 1])) <= set(map(tuple, X[y == 1]))  # copies only, nothing invented


def test_selection_before_cv_finds_signal_in_noise(mod):
    X, y = mod.make_noise()
    assert mod.leaky_score(X, y) > 0.7
    assert mod.proper_score(X, y) < 0.65
