"""Week 12 checks against scikit-learn's GaussianNB and unpenalised LogisticRegression."""

import numpy as np
import pytest
from sklearn.linear_model import LogisticRegression
from sklearn.naive_bayes import GaussianNB


def test_nb_matches_sklearn(mod):
    X, y, Xt, yt = mod.make_data()
    ours = mod.gaussian_nb_predict(mod.gaussian_nb_fit(X, y), Xt)
    theirs = GaussianNB(var_smoothing=0).fit(X, y).predict(Xt)
    assert np.array_equal(ours, theirs)


def test_sigmoid_and_loss(mod):
    assert mod.sigmoid(np.array([0.0]))[0] == 0.5
    assert mod.log_loss(np.array([1, 0]), np.array([0.5, 0.5])) == pytest.approx(np.log(2))
    assert mod.log_loss(np.array([1]), np.array([0.0])) > 20  # a confident miss costs a lot


def test_logistic_matches_sklearn(mod):
    X, y, Xt, yt = mod.make_data()
    w, b = mod.logistic_fit(X, y)
    ref = LogisticRegression(C=np.inf, max_iter=5000).fit(X, y)  # C=inf: no penalty, like ours
    assert np.allclose(w, ref.coef_[0], atol=0.05)
    assert b == pytest.approx(ref.intercept_[0], abs=0.05)
    assert np.mean((mod.sigmoid(Xt @ w + b) > 0.5) == yt) > 0.8
