# Your work goes here. Generated from solution.py by make_exercises.py; run the tests with pytest.
"""Week 24: reinforcement learning.

Learn from rewards rather than labels. Balance exploring and exploiting on a multi-armed bandit, solve a small
grid world exactly by value iteration when its rules are known, then learn the same policy by Q-learning from
experience alone.
"""

import numpy as np

# A 4 x 4 grid. S start, G goal (+10, ends), X hole (-10, ends), every other step costs 1.
GRID = ["S...", ".X..", "...X", "X..G"]
ACTIONS = [(-1, 0), (1, 0), (0, -1), (0, 1)]  # up, down, left, right


def step(state: tuple[int, int], action: int) -> tuple[tuple[int, int], float, bool]:
    """The grid's rules: move (walls stop you), then return (next state, reward, finished)."""
    r = min(max(state[0] + ACTIONS[action][0], 0), 3)
    c = min(max(state[1] + ACTIONS[action][1], 0), 3)
    cell = GRID[r][c]
    if cell == "G":
        return (r, c), 10.0, True
    if cell == "X":
        return (r, c), -10.0, True
    return (r, c), -1.0, False


# EXERCISE
def epsilon_greedy_bandit(means: list[float], steps: int, epsilon: float, seed: int) -> tuple[np.ndarray, float]:
    """Play arms with normal rewards (sd 1) around `means`: with probability epsilon a random arm, otherwise the
    arm with the best average so far (untried arms count as 0, ties to the lowest index). Returns (pulls per
    arm, total reward)."""
    raise NotImplementedError("TODO: write epsilon_greedy_bandit")


# EXERCISE
def value_iteration(gamma: float = 0.95, tol: float = 1e-8) -> tuple[np.ndarray, np.ndarray]:
    """State values V (4 x 4, 0 at the goal and the holes) and the greedy policy (action index per cell),
    by repeating V(s) = max_a [reward + gamma * V(next)] (no future after a finishing move) until it settles."""
    raise NotImplementedError("TODO: write value_iteration")


# EXERCISE
def q_learning(episodes: int, alpha: float, gamma: float, epsilon: float, seed: int) -> np.ndarray:
    """Q-learning from the start cell with epsilon-greedy moves (ties to the lowest index), at most 100 steps per
    episode. Returns Q of shape (4, 4, 4). Update: Q += alpha * (reward + gamma * max Q(next) - Q), with no
    future term after a finishing move."""
    raise NotImplementedError("TODO: write q_learning")


def greedy_path(Q_or_policy: np.ndarray, limit: int = 20) -> list[tuple[int, int]]:
    """The cells visited from the start by always taking the best action, until the episode ends or `limit`."""
    s, path = (0, 0), [(0, 0)]
    for _ in range(limit):
        a = int(Q_or_policy[s]) if Q_or_policy.ndim == 2 else int(np.argmax(Q_or_policy[s]))
        s, _, done = step(s, a)
        path.append(s)
        if done:
            break
    return path
