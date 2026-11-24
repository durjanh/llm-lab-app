"""Week 15 checks: gradient checking, and the network learns XOR."""

import numpy as np

from conftest import need_torch


def test_gradients_match_numerical(mod):
    p = mod.init_params(3, seed=1)
    _, cache = mod.forward(p, mod.XOR_X)
    grads = mod.backward(p, cache, mod.XOR_Y)
    h = 1e-6
    for key in p:
        for idx in np.ndindex(p[key].shape):
            old = p[key][idx]
            p[key][idx] = old + h
            up = mod.loss(mod.forward(p, mod.XOR_X)[0], mod.XOR_Y)
            p[key][idx] = old - h
            down = mod.loss(mod.forward(p, mod.XOR_X)[0], mod.XOR_Y)
            p[key][idx] = old
            assert abs((up - down) / (2 * h) - grads[key][idx]) < 1e-6


def test_learns_xor(mod):
    # With 4 hidden units an unlucky start can stall in a flat region; 8 gives the network room to escape.
    p, history = mod.train(hidden=8, lr=1.0, steps=2000, seed=0)
    assert history[-1] < 0.05
    assert np.array_equal(mod.forward(p, mod.XOR_X)[0] > 0.5, mod.XOR_Y == 1)


def test_torch_learns_xor(mod):
    need_torch()
    assert mod.train_torch(hidden=8, lr=1.0, steps=2000, seed=0) < 0.1
