import { describe, expect, it } from 'vitest';
import { QUIZ } from './quiz';
import {
  ARMS,
  CLIFF,
  CLIFF_RUN,
  CLIFF_SEED,
  DEFAULT_GRID,
  DEFAULT_WORLD,
  banditRace,
  betaSample,
  discounted,
  greedyPath,
  greedyPolicy,
  gridEnv,
  horizon,
  isCliff,
  learn,
  move,
  outcomes,
  rng,
  runBandit,
  smooth,
  valueIteration,
  valueStep,
  zeros,
  type Grid,
} from './rl';

describe('discounting', () => {
  it('values a reward t steps away at gamma to the t', () => {
    expect(discounted(0.9, 0)).toBe(1);
    expect(discounted(0.9, 2)).toBeCloseTo(0.81);
    expect(horizon(0.9)).toBeCloseTo(10);
    expect(horizon(1)).toBe(Infinity);
  });
});

describe('bandits', () => {
  it('repeats exactly for the same seed', () => {
    const o = { steps: 300, epsilon: 0.1, c: 0.5 };
    expect(runBandit('thompson', o, 9)).toEqual(runBandit('thompson', o, 9));
  });

  it('draws Beta samples with the right mean', () => {
    const r = rng(4);
    let s = 0;
    for (let i = 0; i < 4000; i++) s += betaSample(r, 3, 7);
    expect(s / 4000).toBeCloseTo(0.3, 1);
  });

  it('over 3,000 visitors, UCB and Thompson sampling beat a fixed epsilon', () => {
    const race = banditRace({ steps: 3000, epsilon: 0.1, c: 0.5 });
    const end = (k: 'greedy' | 'ucb' | 'thompson') => race[k].regret[2999];
    expect(end('ucb')).toBeLessThan(end('greedy'));
    expect(end('thompson')).toBeLessThan(end('greedy'));
    // Fixed epsilon keeps paying for exploration; Thompson's regret flattens.
    const late = (k: 'greedy' | 'thompson') => race[k].regret[2999] - race[k].regret[1999];
    expect(late('thompson')).toBeLessThan(late('greedy') / 2);
    const best = ARMS.findIndex((a) => a.p === Math.max(...ARMS.map((x) => x.p)));
    expect(race.thompson.pulls.indexOf(Math.max(...race.thompson.pulls))).toBe(best);
  });

  it('UCB1 with the textbook bonus of √2 over-explores at this horizon', () => {
    const wide = banditRace({ steps: 3000, epsilon: 0.1, c: Math.SQRT2 });
    const narrow = banditRace({ steps: 3000, epsilon: 0.1, c: 0.5 });
    expect(wide.ucb.regret[2999]).toBeGreaterThan(narrow.ucb.regret[2999] * 2);
  });
});

describe('grid world', () => {
  it('walls and edges stop a move', () => {
    expect(move(DEFAULT_GRID, 0, 0, 0)).toEqual([0, 0]);
    expect(move(DEFAULT_GRID, 0, 1, 2)).toEqual([0, 1]);
    expect(move(DEFAULT_GRID, 4, 0, 1)).toEqual([4, 1]);
  });

  it('outcome probabilities sum to one', () => {
    const total = outcomes(DEFAULT_GRID, 2, 2, 1, 0.3).reduce((s, [p]) => s + p, 0);
    expect(total).toBeCloseTo(1);
  });

  it('value iteration converges and the policy leads from the start to the goal without the pit', () => {
    const { V, sweeps } = valueIteration(DEFAULT_GRID, DEFAULT_WORLD);
    expect(sweeps).toBeLessThan(100);
    expect(valueStep(DEFAULT_GRID, V, DEFAULT_WORLD).delta).toBeLessThan(1e-5);
    const policy = greedyPolicy(DEFAULT_GRID, V, DEFAULT_WORLD);
    let [r, c] = [4, 0];
    const seen = new Set<string>();
    while (DEFAULT_GRID[r][c] !== 'goal') {
      expect(DEFAULT_GRID[r][c]).not.toBe('pit');
      expect(seen.has(`${r},${c}`)).toBe(false);
      seen.add(`${r},${c}`);
      [r, c] = move(DEFAULT_GRID, r, c, policy[r][c]!);
    }
  });

  it('with more slip, the cell left of the pit stops going up past it', () => {
    const policyAt = (slip: number, stepReward: number) => {
      const o = { ...DEFAULT_WORLD, slip, stepReward };
      return greedyPolicy(DEFAULT_GRID, valueIteration(DEFAULT_GRID, o).V, o);
    };
    expect(policyAt(0, -0.04)[1][4]).toBe(0); // up, then right to the goal
    expect(policyAt(0.4, -0.04)[1][4]).toBe(3); // left: going up could slip right into the pit
    expect(policyAt(0.4, -0.4)[1][4]).toBe(0); // steps so costly that the risk is worth it again
    expect(policyAt(0.4, -0.4)[2][5]).toBe(0); // and below the pit, ending the episode in it beats wandering
  });

  it('more slip makes every cell worth less', () => {
    const safe = valueIteration(DEFAULT_GRID, { ...DEFAULT_WORLD, slip: 0 }).V;
    const risky = valueIteration(DEFAULT_GRID, { ...DEFAULT_WORLD, slip: 0.4 }).V;
    expect(risky[4][0]).toBeLessThan(safe[4][0]);
  });

  it('handles a grid with no start by starting bottom left', () => {
    const g: Grid = [
      ['empty', 'goal'],
      ['empty', 'empty'],
    ];
    expect(gridEnv(g, DEFAULT_WORLD).start).toEqual([1, 0]);
    expect(zeros(g)).toEqual([
      [0, 0],
      [0, 0],
    ]);
  });
});

describe('learning from experience', () => {
  it('Q-learning on the grid world improves on its first episodes', () => {
    const g = learn(gridEnv(DEFAULT_GRID, DEFAULT_WORLD), 'q', {
      alpha: 0.2,
      gamma: 0.9,
      epsilon: 0.2,
      episodes: 300,
      maxSteps: 100,
    });
    const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
    expect(mean(g.returns.slice(-50))).toBeGreaterThan(mean(g.returns.slice(0, 50)) + 0.5);
  });

  it('on the cliff, Q-learning finds the edge path and SARSA a safer, longer one that earns more while exploring', () => {
    const q = learn(CLIFF, 'q', CLIFF_RUN, CLIFF_SEED);
    const s = learn(CLIFF, 'sarsa', CLIFF_RUN, CLIFF_SEED);
    const qPath = greedyPath(CLIFF, q.Q);
    const sPath = greedyPath(CLIFF, s.Q);
    expect(qPath.length - 1).toBe(13);
    expect(sPath[sPath.length - 1]).toEqual([3, 11]);
    expect(sPath.length).toBeGreaterThan(qPath.length);
    expect(sPath.every(([r, c]) => !isCliff(r, c))).toBe(true);
    const mean = (xs: number[]) => xs.slice(-100).reduce((t, x) => t + x, 0) / 100;
    expect(mean(s.returns)).toBeGreaterThan(mean(q.returns));
  });

  it('with no exploration, SARSA and Q-learning make the same updates', () => {
    const o = { ...CLIFF_RUN, epsilon: 0, episodes: 200 };
    const q = learn(CLIFF, 'q', o, CLIFF_SEED);
    const s = learn(CLIFF, 'sarsa', o, CLIFF_SEED);
    expect(s.returns).toEqual(q.returns);
    expect(greedyPath(CLIFF, q.Q).at(-1)).toEqual([3, 11]);
  });

  it('smooths with a trailing window', () => {
    expect(smooth([2, 4, 6, 8], 2)).toEqual([2, 3, 5, 7]);
  });
});

describe('quiz', () => {
  it('has six week-24 questions, each with a valid answer', () => {
    expect(QUIZ).toHaveLength(6);
    for (const q of QUIZ) {
      expect(q.week).toBe(24);
      expect(Number.isInteger(q.answer) && q.answer >= 0 && q.answer < q.options.length).toBe(true);
    }
  });
});

describe('the start cell', () => {
  it('with the start painted out, starts on an open cell rather than inside a wall', async () => {
    const { findStart } = await import('./rl');
    const grid = [
      ['empty', 'empty', 'goal'],
      ['wall', 'pit', 'empty'],
      ['wall', 'empty', 'empty'],
    ] as Parameters<typeof findStart>[0];
    const [r, c] = findStart(grid);
    expect(grid[r][c]).toBe('empty');
    expect([r, c]).toEqual([2, 1]);
  });
});
