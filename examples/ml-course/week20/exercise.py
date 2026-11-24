# Your work goes here. Generated from solution.py by make_exercises.py; run the tests with pytest.
"""Week 20: language models II, scaling, few-shot prompting and fine-tuning.

Fit a scaling law to invented (model size, loss) results and use it to predict a bigger model, build a few-shot
prompt, count what LoRA saves when fine-tuning, and (with PyTorch) train a tiny character model and watch its
loss fall. No downloads and no API keys.
"""

import numpy as np

# Invented results: parameters against validation loss, shaped like published scaling curves.
SIZES = np.array([1e6, 4e6, 1.6e7, 6.4e7, 2.56e8])
LOSSES = 1.7 + 410 * SIZES**-0.34


# EXERCISE
def fit_power_law(sizes: np.ndarray, losses: np.ndarray, floor: float) -> tuple[float, float]:
    """Fit loss = floor + a * size^-b by a straight line through log(loss - floor) against log(size).
    Returns (a, b)."""
    raise NotImplementedError("TODO: write fit_power_law")


# EXERCISE
def predict_loss(size: float, a: float, b: float, floor: float) -> float:
    """The loss the fitted law predicts at `size`."""
    raise NotImplementedError("TODO: write predict_loss")


# EXERCISE
def few_shot_prompt(examples: list[tuple[str, str]], query: str, instruction: str) -> str:
    """The instruction, a blank line, each example as "Input: ...\nOutput: ..." separated by blank lines, then
    "Input: <query>\nOutput:" for the model to complete."""
    raise NotImplementedError("TODO: write few_shot_prompt")


# EXERCISE
def lora_params(d_in: int, d_out: int, rank: int) -> tuple[int, int]:
    """(full fine-tuning parameters, LoRA parameters) for one d_in x d_out weight matrix."""
    raise NotImplementedError("TODO: write lora_params")


# EXERCISE
def train_char_model(text: str, steps: int = 300, seed: int = 0) -> tuple[float, float]:
    """PyTorch: an embedding (vocab x 32) then a linear layer back to the vocabulary, predicting each next
    character from the current one, trained with Adam (lr 0.05) on cross-entropy. Returns (first loss, last
    loss)."""
    raise NotImplementedError("TODO: write train_char_model")
