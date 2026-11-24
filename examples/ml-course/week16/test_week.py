"""Week 16 checks: parameter counting, and regularisation narrows the train-test gap."""

from conftest import need_torch


def test_count_params(mod):
    assert mod.count_params([64, 32, 10]) == 64 * 32 + 32 + 32 * 10 + 10
    assert mod.count_params([2, 1]) == 3


def test_big_network_memorises_small_data(mod):
    train, test = mod.mlp_scores(alpha=1e-6)
    assert train == 1.0
    assert test < train


def test_torch_dropout_and_decay_help(mod):
    need_torch()
    plain_train, plain_test = mod.torch_scores(dropout=0.0, weight_decay=0.0)
    reg_train, reg_test = mod.torch_scores(dropout=0.5, weight_decay=1e-3)
    assert plain_train == 1.0
    assert reg_test >= plain_test - 0.01  # at least as good on new digits
    assert reg_test > 0.85
