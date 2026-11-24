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
    # epsilon = 0 can lock on to whichever arm looked good first; a little exploration finds the best one.
    rng = np.random.default_rng(seed)
    pulls = np.zeros(len(means))
    totals = np.zeros(len(means))
    reward = 0.0
    for _ in range(steps):
        avg = np.divide(totals, pulls, out=np.zeros_like(totals), where=pulls > 0)
        arm = rng.integers(len(means)) if rng.random() < epsilon else int(np.argmax(avg))
        r = rng.normal(means[arm], 1)
        pulls[arm] += 1
        totals[arm] += r
        reward += r
    return pulls, reward


# EXERCISE
def value_iteration(gamma: float = 0.95, tol: float = 1e-8) -> tuple[np.ndarray, np.ndarray]:
    """State values V (4 x 4, 0 at the goal and the holes) and the greedy policy (action index per cell),
    by repeating V(s) = max_a [reward + gamma * V(next)] (no future after a finishing move) until it settles."""
    # With the rules known, planning needs no experience: values flow back from the goal one step per sweep.
    V = np.zeros((4, 4))
    while True:
        new = np.zeros_like(V)
        for r in range(4):
            for c in range(4):
                if GRID[r][c] in "GX":
                    continue
                new[r, c] = max(rew + (0 if done else gamma * V[s]) for s, rew, done in (step((r, c), a) for a in range(4)))
        if np.max(np.abs(new - V)) < tol:
            break
        V = new
    policy = np.zeros((4, 4), dtype=int)
    for r in range(4):
        for c in range(4):
            outs = [step((r, c), a) for a in range(4)]
            policy[r, c] = int(np.argmax([rew + (0 if done else gamma * V[s]) for s, rew, done in outs]))
    return V, policy


# EXERCISE
def q_learning(episodes: int, alpha: float, gamma: float, epsilon: float, seed: int) -> np.ndarray:
    """Q-learning from the start cell with epsilon-greedy moves (ties to the lowest index), at most 100 steps per
    episode. Returns Q of shape (4, 4, 4). Update: Q += alpha * (reward + gamma * max Q(next) - Q), with no
    future term after a finishing move."""
    # Q-learning never sees the rules, only (state, action, reward, next state); it learns the same values that
    # value iteration computes, by trial and error.
    rng = np.random.default_rng(seed)
    Q = np.zeros((4, 4, 4))
    for _ in range(episodes):
        s = (0, 0)
        for _ in range(100):
            a = rng.integers(4) if rng.random() < epsilon else int(np.argmax(Q[s]))
            nxt, rew, done = step(s, a)
            target = rew if done else rew + gamma * Q[nxt].max()
            Q[s][a] += alpha * (target - Q[s][a])
            s = nxt
            if done:
                break
    return Q


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
