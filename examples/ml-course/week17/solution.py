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
    kh, kw = kernel.shape
    h, w = image.shape[0] - kh + 1, image.shape[1] - kw + 1
    out = np.zeros((h, w))
    for i in range(h):
        for j in range(w):
            out[i, j] = np.sum(image[i : i + kh, j : j + kw] * kernel)
    return out


# EXERCISE
def max_pool(x: np.ndarray, size: int = 2) -> np.ndarray:
    """Non-overlapping max pooling; rows and columns that do not fill a window are dropped."""
    # Pooling keeps the strongest response in each patch, so a feature shifted by a pixel gives the same output.
    h, w = x.shape[0] // size, x.shape[1] // size
    return x[: h * size, : w * size].reshape(h, size, w, size).max(axis=(1, 3))


VERTICAL_EDGE = np.array([[1.0, 0.0, -1.0], [1.0, 0.0, -1.0], [1.0, 0.0, -1.0]])


# EXERCISE
def weights_saved(height: int, width: int, filters: int, k: int) -> tuple[int, int]:
    """Weights (no biases) of a conv layer with `filters` k-by-k filters on one channel, against a dense layer
    mapping the same height x width image to a same-sized output for each filter. Returns (conv, dense)."""
    out_cells = (height - k + 1) * (width - k + 1)
    return filters * k * k, height * width * out_cells * filters


# EXERCISE
def train_cnn(epochs: int = 40, seed: int = 0) -> float:
    """PyTorch: Conv2d(1, 16, 3, padding=1) - ReLU - MaxPool2d(2) - Conv2d(16, 32, 3, padding=1) - ReLU -
    MaxPool2d(2) - Flatten - Linear(32*2*2, 10), Adam lr 1e-2, minibatches of 64, on digits scaled to [0, 1] with
    the first 1,200 shuffled rows for training. Returns test accuracy."""
    import torch

    torch.manual_seed(seed)
    X, y = load_digits(return_X_y=True)
    order = np.random.default_rng(seed).permutation(len(y))
    X = torch.tensor(X[order] / 16.0, dtype=torch.float32).reshape(-1, 1, 8, 8)
    y = torch.tensor(y[order])
    model = torch.nn.Sequential(
        torch.nn.Conv2d(1, 16, 3, padding=1), torch.nn.ReLU(), torch.nn.MaxPool2d(2),
        torch.nn.Conv2d(16, 32, 3, padding=1), torch.nn.ReLU(), torch.nn.MaxPool2d(2),
        torch.nn.Flatten(), torch.nn.Linear(32 * 2 * 2, 10),
    )
    opt = torch.optim.Adam(model.parameters(), lr=1e-2)
    for _ in range(epochs):
        for i in range(0, 1200, 64):
            end = min(i + 64, 1200)  # the last batch stops at the training rows
            opt.zero_grad()
            torch.nn.functional.cross_entropy(model(X[i:end]), y[i:end]).backward()
            opt.step()
    with torch.no_grad():
        return float((model(X[1200:]).argmax(1) == y[1200:]).float().mean())
