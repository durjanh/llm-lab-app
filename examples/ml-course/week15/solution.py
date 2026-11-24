"""Week 15: neural networks I, from one neuron to backpropagation.

Build a two-layer network in NumPy: a forward pass, the loss, and the backward pass that sends the error back
through each layer by the chain rule. Check the gradients against slow numerical ones, then train it on XOR, the
problem one neuron cannot solve. The optional last function does the same in PyTorch.
"""

import numpy as np

XOR_X = np.array([[0.0, 0.0], [0.0, 1.0], [1.0, 0.0], [1.0, 1.0]])
XOR_Y = np.array([0.0, 1.0, 1.0, 0.0])


def init_params(hidden: int, seed: int) -> dict[str, np.ndarray]:
    """Small random weights for a 2-input, `hidden`-unit, 1-output network."""
    rng = np.random.default_rng(seed)
    return {
        "W1": rng.normal(0, 1, (2, hidden)),
        "b1": np.zeros(hidden),
        "W2": rng.normal(0, 1, (hidden, 1)),
        "b2": np.zeros(1),
    }


# EXERCISE
def forward(p: dict[str, np.ndarray], X: np.ndarray) -> tuple[np.ndarray, dict]:
    """tanh hidden layer, sigmoid output. Returns (probabilities of shape (n,), cache of what backward needs)."""
    h = np.tanh(X @ p["W1"] + p["b1"])
    out = 1 / (1 + np.exp(-(h @ p["W2"] + p["b2"])))
    return out[:, 0], {"X": X, "h": h, "out": out[:, 0]}


# EXERCISE
def loss(prob: np.ndarray, y: np.ndarray) -> float:
    """Mean binary cross-entropy."""
    prob = np.clip(prob, 1e-12, 1 - 1e-12)
    return float(-np.mean(y * np.log(prob) + (1 - y) * np.log(1 - prob)))


# EXERCISE
def backward(p: dict[str, np.ndarray], cache: dict, y: np.ndarray) -> dict[str, np.ndarray]:
    """Gradients of `loss` with respect to each parameter, with the same keys and shapes as p."""
    # Sigmoid with cross-entropy has the neat output error (prob - y). Each layer then passes its error back
    # through its weights, and through tanh's derivative (1 - h^2).
    n = len(y)
    d_out = (cache["out"] - y)[:, None] / n
    d_h = d_out @ p["W2"].T * (1 - cache["h"] ** 2)
    return {
        "W2": cache["h"].T @ d_out,
        "b2": d_out.sum(axis=0),
        "W1": cache["X"].T @ d_h,
        "b1": d_h.sum(axis=0),
    }


# EXERCISE
def train(hidden: int, lr: float, steps: int, seed: int) -> tuple[dict, list[float]]:
    """Gradient descent on XOR. Returns (parameters, loss after each step)."""
    p = init_params(hidden, seed)
    history = []
    for _ in range(steps):
        prob, cache = forward(p, XOR_X)
        grads = backward(p, cache, XOR_Y)
        for k in p:
            p[k] -= lr * grads[k]
        history.append(loss(forward(p, XOR_X)[0], XOR_Y))
    return p, history


# EXERCISE
def train_torch(hidden: int, lr: float, steps: int, seed: int) -> float:
    """The same network on XOR in PyTorch (nn.Sequential, BCELoss, SGD). Returns the final loss."""
    # PyTorch builds the backward pass for you from the forward one; the sums are the ones written above.
    import torch

    torch.manual_seed(seed)
    model = torch.nn.Sequential(
        torch.nn.Linear(2, hidden), torch.nn.Tanh(), torch.nn.Linear(hidden, 1), torch.nn.Sigmoid()
    )
    opt = torch.optim.SGD(model.parameters(), lr=lr)
    X = torch.tensor(XOR_X, dtype=torch.float32)
    y = torch.tensor(XOR_Y, dtype=torch.float32)[:, None]
    for _ in range(steps):
        opt.zero_grad()
        out = torch.nn.functional.binary_cross_entropy(model(X), y)
        out.backward()
        opt.step()
    return out.item()
