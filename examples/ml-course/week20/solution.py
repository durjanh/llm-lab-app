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
    # A power law is a straight line on log-log axes, so ordinary least squares on the logs fits it.
    slope, intercept = np.polyfit(np.log(sizes), np.log(losses - floor), 1)
    return float(np.exp(intercept)), float(-slope)


# EXERCISE
def predict_loss(size: float, a: float, b: float, floor: float) -> float:
    """The loss the fitted law predicts at `size`."""
    return floor + a * size**-b


# EXERCISE
def few_shot_prompt(examples: list[tuple[str, str]], query: str, instruction: str) -> str:
    """The instruction, a blank line, each example as "Input: ...\nOutput: ..." separated by blank lines, then
    "Input: <query>\nOutput:" for the model to complete."""
    # Examples show the format and the task more precisely than a description; the trailing "Output:" makes the
    # next tokens the answer.
    shots = "\n\n".join(f"Input: {i}\nOutput: {o}" for i, o in examples)
    return f"{instruction}\n\n{shots}\n\nInput: {query}\nOutput:"


# EXERCISE
def lora_params(d_in: int, d_out: int, rank: int) -> tuple[int, int]:
    """(full fine-tuning parameters, LoRA parameters) for one d_in x d_out weight matrix."""
    # LoRA freezes W and learns a low-rank change B @ A, with A (rank x d_in) and B (d_out x rank).
    return d_in * d_out, rank * (d_in + d_out)


# EXERCISE
def train_char_model(text: str, steps: int = 300, seed: int = 0) -> tuple[float, float]:
    """PyTorch: an embedding (vocab x 32) then a linear layer back to the vocabulary, predicting each next
    character from the current one, trained with Adam (lr 0.05) on cross-entropy. Returns (first loss, last
    loss)."""
    # This is a neural bigram model: the same job as week 19's counts, learned by gradient descent, which is
    # how a transformer learns too, only with far more context.
    import torch

    torch.manual_seed(seed)
    vocab = sorted(set(text))
    ids = torch.tensor([vocab.index(c) for c in text])
    model = torch.nn.Sequential(torch.nn.Embedding(len(vocab), 32), torch.nn.Linear(32, len(vocab)))
    opt = torch.optim.Adam(model.parameters(), lr=0.05)
    losses = []
    for _ in range(steps):
        opt.zero_grad()
        loss = torch.nn.functional.cross_entropy(model(ids[:-1]), ids[1:])
        loss.backward()
        opt.step()
        losses.append(loss.item())
    return losses[0], losses[-1]
