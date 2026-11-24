# Your work goes here. Generated from solution.py by make_exercises.py; run the tests with pytest.
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
    raise NotImplementedError("TODO: write forward")


# EXERCISE
def loss(prob: np.ndarray, y: np.ndarray) -> float:
    """Mean binary cross-entropy."""
    raise NotImplementedError("TODO: write loss")


# EXERCISE
def backward(p: dict[str, np.ndarray], cache: dict, y: np.ndarray) -> dict[str, np.ndarray]:
    """Gradients of `loss` with respect to each parameter, with the same keys and shapes as p."""
    raise NotImplementedError("TODO: write backward")


# EXERCISE
def train(hidden: int, lr: float, steps: int, seed: int) -> tuple[dict, list[float]]:
    """Gradient descent on XOR. Returns (parameters, loss after each step)."""
    raise NotImplementedError("TODO: write train")


# EXERCISE
def train_torch(hidden: int, lr: float, steps: int, seed: int) -> float:
    """The same network on XOR in PyTorch (nn.Sequential, BCELoss, SGD). Returns the final loss."""
    raise NotImplementedError("TODO: write train_torch")
