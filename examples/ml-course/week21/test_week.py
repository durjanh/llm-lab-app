"""Week 21 checks: importance ranks the real drivers first, the fairness gaps show, the card is complete."""

import numpy as np
import pytest


def test_importance_finds_the_drivers(mod):
    X, y, _ = mod.make_loans()
    model = mod.fit_model(X, y)
    imp = mod.permutation_importance(model, X[1500:], y[1500:], seed=0)
    assert imp[0] > imp[2] and imp[1] > imp[2]  # income and debt matter, noise does not
    assert abs(imp[2]) < 0.02


def test_group_never_used_but_gap_appears(mod):
    # The model never sees `group`, yet approvals differ, because income differs between the groups.
    X, y, group = mod.make_loans()
    pred = mod.fit_model(X, y).predict(X[1500:])
    assert mod.approval_rate_gap(pred, group[1500:]) > 0.1
    assert abs(mod.true_positive_rate_gap(y[1500:], pred, group[1500:])) < mod.approval_rate_gap(pred, group[1500:])


def test_gaps_by_hand(mod):
    y = np.array([1, 1, 0, 1, 1, 0])
    pred = np.array([1, 0, 0, 1, 1, 1])
    group = np.array([0, 0, 0, 1, 1, 1])
    assert mod.approval_rate_gap(pred, group) == pytest.approx(1 - 1 / 3)
    assert mod.true_positive_rate_gap(y, pred, group) == pytest.approx(0.5)


def test_model_card(mod):
    info = {
        "name": "Loan screen v3",
        "intended_use": "First-pass ranking for a human reviewer.",
        "out_of_scope": "Automatic refusals.",
        "training_data": "Invented applications, 2,000 rows.",
        "evaluation": "Accuracy 0.85 on 500 held-out rows.",
        "fairness": "Approval gap 0.2 between groups, from income differences.",
        "limitations": "Not tested on self-employed applicants.",
    }
    card = mod.model_card(info)
    assert card.startswith("# Loan screen v3\n\n## Intended use\n\nFirst-pass")
    assert card.index("## Out of scope") < card.index("## Limitations")
    with pytest.raises(ValueError, match="limitations"):
        mod.model_card({**info, "limitations": ""})
