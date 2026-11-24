"""A starter optimiser for the capstone: a Gaussian process with expected improvement, round by round.

It is deliberately plain, so improving it is the project: tune the length scale from the data, add a noise term
that matches the box, switch acquisition (UCB, Thompson sampling), pick a batch of points that are not all in the
same place, or shrink the search box once a good region is found. Week 14's notes explain each piece.

    .venv/bin/python capstone/starter.py oven          plays every remaining round of the oven
    .venv/bin/python capstone/starter.py drone --rounds 2
"""

import argparse

import numpy as np
from scipy.stats import norm

from blackbox import BLACK_BOXES, Challenge


def rbf(A: np.ndarray, B: np.ndarray, length: float) -> np.ndarray:
    """Squared-exponential covariance between the rows of A and B."""
    d2 = ((A[:, None, :] - B[None, :, :]) ** 2).sum(-1)
    return np.exp(-d2 / (2 * length**2))


def posterior(X: np.ndarray, y: np.ndarray, Xq: np.ndarray, length: float, noise: float):
    """GP mean and standard deviation at Xq, on outputs centred and scaled to unit spread."""
    mu, sd = y.mean(), y.std() or 1.0
    z = (y - mu) / sd
    L = np.linalg.cholesky(rbf(X, X, length) + noise * np.eye(len(X)))
    alpha = np.linalg.solve(L.T, np.linalg.solve(L, z))
    Ks = rbf(X, Xq, length)
    v = np.linalg.solve(L, Ks)
    return mu + sd * (Ks.T @ alpha), sd * np.sqrt(np.maximum(1 - (v**2).sum(0), 1e-12))


def expected_improvement(mean: np.ndarray, std: np.ndarray, best: float, xi: float = 0.01) -> np.ndarray:
    """How much each candidate is expected to beat `best` by."""
    z = (mean - best - xi) / std
    return (mean - best - xi) * norm.cdf(z) + std * norm.pdf(z)


def propose(X: np.ndarray, y: np.ndarray, k: int, seed: int, length: float = 0.15, noise: float = 1e-3):
    """k points to try next: the best of 5,000 random candidates by EI, then the next best that is at least 0.05
    away from those already chosen, so a round does not spend its budget in one spot."""
    rng = np.random.default_rng(seed)
    cand = rng.random((5000, X.shape[1]))
    mean, std = posterior(X, y, cand, length, noise)
    order = np.argsort(-expected_improvement(mean, std, y.max()))
    chosen: list[np.ndarray] = []
    for i in order:
        if all(np.linalg.norm(cand[i] - c) > 0.05 for c in chosen):
            chosen.append(cand[i])
        if len(chosen) == k:
            break
    return [c.tolist() for c in chosen]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("box", choices=sorted(BLACK_BOXES))
    parser.add_argument("--rounds", type=int, default=None, help="how many rounds to play (default: all left)")
    args = parser.parse_args()
    ch = Challenge(args.box)
    left = ch.box.rounds - ch.rounds_done
    for _ in range(left if args.rounds is None else min(args.rounds, left)):
        pts = propose(np.array(ch.xs), np.array(ch.ys), ch.box.per_round, seed=len(ch.xs))
        ys = ch.query_round(pts)
        print(f"round {ch.rounds_done}: " + "; ".join(f"{y:.3f}" for y in ys) + f"   best so far {ch.best()[1]:.3f}")
    print("log:", ch.log)


if __name__ == "__main__":
    main()
