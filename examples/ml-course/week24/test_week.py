"""Week 24 checks: exploration pays on the bandit, planning and learning both reach the goal by the short route."""

import numpy as np


def test_exploration_finds_the_best_arm(mod):
    means = [0.5, 1.0, 2.0]
    pulls, _ = mod.epsilon_greedy_bandit(means, 2000, 0.1, seed=0)
    assert pulls.argmax() == 2
    greedy_totals = [mod.epsilon_greedy_bandit(means, 2000, 0.0, seed=s)[1] for s in range(10)]
    explore_totals = [mod.epsilon_greedy_bandit(means, 2000, 0.1, seed=s)[1] for s in range(10)]
    assert np.mean(explore_totals) > np.mean(greedy_totals)


def test_value_iteration_reaches_the_goal(mod):
    V, policy = mod.value_iteration()
    path = mod.greedy_path(policy)
    assert path[-1] == (3, 3)
    assert len(path) - 1 == 6  # the shortest safe route takes six moves
    assert V[0, 0] > 0 and V[3, 3] == 0


def test_q_learning_learns_the_same_route(mod):
    Q = mod.q_learning(episodes=2000, alpha=0.5, gamma=0.95, epsilon=0.1, seed=0)
    path = mod.greedy_path(Q)
    assert path[-1] == (3, 3)
    assert len(path) - 1 == 6
    assert not any(mod.GRID[r][c] == "X" for r, c in path)
