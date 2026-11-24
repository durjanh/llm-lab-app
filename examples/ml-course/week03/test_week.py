"""Week 3 checks: a clean split, honest filling, and the same answer as scikit-learn."""

import numpy as np


def test_split_sizes_and_no_overlap(mod):
    df = mod.make_patients()
    train, test = mod.split(df, 0.25, seed=1)
    assert len(test) == 50 and len(train) == 150
    assert not set(train.index) & set(test.index)


def test_missing_report(mod):
    report = mod.missing_report(mod.make_patients())
    assert report["age"] == 0
    assert 0.1 < report["result"] < 0.35


def test_medians_come_from_train_only(mod):
    df = mod.make_patients()
    train, test = mod.split(df, 0.25, seed=1)
    assert mod.fit_medians(train)["weight"] == train["weight"].median()


def test_fill_keeps_a_flag(mod):
    df = mod.make_patients()
    train, test = mod.split(df, 0.25, seed=1)
    filled = mod.fill_missing(test, mod.fit_medians(train))
    assert not filled[["age", "weight", "result"]].isna().any().any()
    assert filled["result_missing"].sum() == test["result"].isna().sum()


def test_matches_sklearn(mod):
    df = mod.make_patients()
    train, test = mod.split(df, 0.25, seed=1)
    ours = mod.fill_missing(test, mod.fit_medians(train))
    theirs = mod.fill_with_sklearn(train, test)
    assert np.allclose(ours[["age", "weight", "result"]].to_numpy(), theirs[:, :3])
