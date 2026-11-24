# Your work goes here. Generated from solution.py by make_exercises.py; run the tests with pytest.
"""Week 16: neural networks II, depth, regularisation and libraries.

On handwritten digits (8 by 8 pixels, from scikit-learn), see a big network overfit a small training set, then
rein it in with weight decay and dropout. scikit-learn's MLPClassifier covers the first part; PyTorch, if
installed, the second.
"""

import numpy as np
from sklearn.datasets import load_digits
from sklearn.neural_network import MLPClassifier


def make_data() -> tuple[np.ndarray, ...]:
    """Digits scaled to [0, 1]: a deliberately small training set of 300 and a test set of the remaining 1,497."""
    X, y = load_digits(return_X_y=True)
    X = X / 16.0
    order = np.random.default_rng(0).permutation(len(y))
    X, y = X[order], y[order]
    return X[:300], y[:300], X[300:], y[300:]


# EXERCISE
def count_params(layers: list[int]) -> int:
    """Weights plus biases of a fully connected network with these layer sizes, e.g. [64, 32, 10]."""
    raise NotImplementedError("TODO: write count_params")


# EXERCISE
def mlp_scores(alpha: float) -> tuple[float, float]:
    """Train MLPClassifier((256, 256), alpha=alpha, max_iter=2000, random_state=0) on make_data's training set.
    Returns (train accuracy, test accuracy). alpha is L2 weight decay."""
    raise NotImplementedError("TODO: write mlp_scores")


# EXERCISE
def torch_scores(dropout: float, weight_decay: float, epochs: int = 300, seed: int = 0) -> tuple[float, float]:
    """A PyTorch MLP 64-256-256-10 with ReLU and the given dropout after each hidden layer, trained full-batch
    with Adam (lr 1e-3, the given weight_decay) and cross-entropy. Returns (train accuracy, test accuracy)."""
    raise NotImplementedError("TODO: write torch_scores")
