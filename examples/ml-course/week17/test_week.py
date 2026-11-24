"""Week 17 checks against SciPy, an edge picture, the weight count and a trained CNN."""

import numpy as np
from scipy.signal import correlate2d

from conftest import need_torch


def test_conv_matches_scipy(mod):
    rng = np.random.default_rng(0)
    img, k = rng.normal(size=(7, 6)), rng.normal(size=(3, 3))
    assert np.allclose(mod.conv2d(img, k), correlate2d(img, k, mode="valid"))


def test_edge_filter_finds_the_edge(mod):
    img = np.zeros((6, 6))
    img[:, :3] = 1.0  # bright left half, dark right half
    out = mod.conv2d(img, mod.VERTICAL_EDGE)
    assert np.all(out[:, 1:3] == 3) and np.all(out[:, [0, 3]] == 0)


def test_max_pool(mod):
    x = np.arange(16.0).reshape(4, 4)
    assert np.array_equal(mod.max_pool(x), [[5, 7], [13, 15]])
    assert mod.max_pool(np.ones((5, 5))).shape == (2, 2)


def test_weights_saved(mod):
    conv, dense = mod.weights_saved(28, 28, 8, 3)
    assert conv == 72
    assert dense > 1_000_000 * conv / 72


def test_cnn_reads_digits(mod):
    need_torch()
    assert mod.train_cnn() > 0.93
