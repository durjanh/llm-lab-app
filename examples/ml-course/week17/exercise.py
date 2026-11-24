# Your work goes here. Generated from solution.py by make_exercises.py; run the tests with pytest.
"""Week 17: convolutional networks.

A convolution slides one small filter over the whole image, so the same feature detector works everywhere and
needs few weights. Write convolution and max pooling in NumPy, see an edge filter light up, count the weights
saved, then train a small CNN on the 8 by 8 digits in PyTorch if it is installed.
"""

import numpy as np
from sklearn.datasets import load_digits


# EXERCISE
def conv2d(image: np.ndarray, kernel: np.ndarray) -> np.ndarray:
    """Valid 2-D cross-correlation (what deep-learning libraries call convolution), stride 1, no padding."""
    raise NotImplementedError("TODO: write conv2d")


# EXERCISE
def max_pool(x: np.ndarray, size: int = 2) -> np.ndarray:
    """Non-overlapping max pooling; rows and columns that do not fill a window are dropped."""
    raise NotImplementedError("TODO: write max_pool")


VERTICAL_EDGE = np.array([[1.0, 0.0, -1.0], [1.0, 0.0, -1.0], [1.0, 0.0, -1.0]])


# EXERCISE
def weights_saved(height: int, width: int, filters: int, k: int) -> tuple[int, int]:
    """Weights (no biases) of a conv layer with `filters` k-by-k filters on one channel, against a dense layer
    mapping the same height x width image to a same-sized output for each filter. Returns (conv, dense)."""
    raise NotImplementedError("TODO: write weights_saved")


# EXERCISE
def train_cnn(epochs: int = 40, seed: int = 0) -> float:
    """PyTorch: Conv2d(1, 16, 3, padding=1) - ReLU - MaxPool2d(2) - Conv2d(16, 32, 3, padding=1) - ReLU -
    MaxPool2d(2) - Flatten - Linear(32*2*2, 10), Adam lr 1e-2, minibatches of 64, on digits scaled to [0, 1] with
    the first 1,200 shuffled rows for training. Returns test accuracy."""
    raise NotImplementedError("TODO: write train_cnn")
