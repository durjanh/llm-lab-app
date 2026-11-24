"""Week 6 checks: the split is clean, training error falls with degree, and validation picks a middle degree."""

import numpy as np


def test_split_is_a_partition(mod):
    train, val, test = mod.three_way_split(100, seed=0)
    assert (len(train), len(val), len(test)) == (60, 20, 20)
    assert sorted(np.concatenate([train, val, test])) == list(range(100))


def test_training_error_never_rises(mod):
    x, y = mod.make_curve()
    errs = mod.error_by_degree(x, y, list(range(1, 13)), seed=0)
    train = [errs[d][0] for d in sorted(errs)]
    assert all(b <= a + 1e-9 for a, b in zip(train, train[1:]))


def test_validation_picks_a_middle_degree(mod):
    x, y = mod.make_curve()
    errs = mod.error_by_degree(x, y, list(range(1, 13)), seed=0)
    best = mod.choose_degree(errs)
    assert 3 <= best <= 8
    assert errs[12][1] > errs[best][1]  # the most flexible model does worse on unseen data
    assert errs[1][1] > errs[best][1]  # and so does the straight line
