"""Week 7 checks against scikit-learn and the trap of accuracy on rare positives."""

import numpy as np
import pytest
from sklearn.metrics import confusion_matrix, roc_auc_score


def test_confusion_matches_sklearn(mod):
    y, s = mod.make_scores()
    pred = (s > 1).astype(int)
    tn, fp, fn, tp = confusion_matrix(y, pred).ravel()
    assert mod.confusion(y, pred) == {"tp": tp, "fp": fp, "tn": tn, "fn": fn}


def test_predicting_all_negative_looks_accurate_but_catches_nothing(mod):
    y, _ = mod.make_scores()
    r = mod.rates(mod.confusion(y, np.zeros_like(y)))
    assert r["accuracy"] > 0.85
    assert r["sensitivity"] == 0


def test_auc_matches_sklearn(mod):
    y, s = mod.make_scores()
    fpr, tpr = mod.roc_curve(y, s)
    assert fpr[0] == 0 and tpr[-1] == 1
    assert mod.area_under(fpr, tpr) == pytest.approx(roc_auc_score(y, s), abs=1e-9)


def test_lift(mod):
    y, s = mod.make_scores()
    assert mod.lift(y, s, 0.1) > 2.5
    assert mod.lift(y, s, 1.0) == pytest.approx(1.0)
