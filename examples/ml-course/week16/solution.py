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
    # Each layer has (inputs x outputs) weights and one bias per output.
    return sum(a * b + b for a, b in zip(layers, layers[1:]))


# EXERCISE
def mlp_scores(alpha: float) -> tuple[float, float]:
    """Train MLPClassifier((256, 256), alpha=alpha, max_iter=2000, random_state=0) on make_data's training set.
    Returns (train accuracy, test accuracy). alpha is L2 weight decay."""
    X, y, Xt, yt = make_data()
    model = MLPClassifier((256, 256), alpha=alpha, max_iter=2000, random_state=0).fit(X, y)
    return model.score(X, y), model.score(Xt, yt)


# EXERCISE
def torch_scores(dropout: float, weight_decay: float, epochs: int = 300, seed: int = 0) -> tuple[float, float]:
    """A PyTorch MLP 64-256-256-10 with ReLU and the given dropout after each hidden layer, trained full-batch
    with Adam (lr 1e-3, the given weight_decay) and cross-entropy. Returns (train accuracy, test accuracy)."""
    # Dropout switches off a random share of units at each step, so no unit can rely on another; model.eval()
    # turns it off for scoring.
    import torch

    torch.manual_seed(seed)
    X, y, Xt, yt = (torch.tensor(a) for a in make_data())
    X, Xt = X.float(), Xt.float()
    model = torch.nn.Sequential(
        torch.nn.Linear(64, 256), torch.nn.ReLU(), torch.nn.Dropout(dropout),
        torch.nn.Linear(256, 256), torch.nn.ReLU(), torch.nn.Dropout(dropout),
        torch.nn.Linear(256, 10),
    )
    opt = torch.optim.Adam(model.parameters(), lr=1e-3, weight_decay=weight_decay)
    for _ in range(epochs):
        model.train()
        opt.zero_grad()
        torch.nn.functional.cross_entropy(model(X), y).backward()
        opt.step()
    model.eval()
    with torch.no_grad():
        return (
            float((model(X).argmax(1) == y).float().mean()),
            float((model(Xt).argmax(1) == yt).float().mean()),
        )
