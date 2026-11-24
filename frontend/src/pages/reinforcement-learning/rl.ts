/*
  The reinforcement learning page's simulations: discounting, bandits (epsilon-greedy, UCB1, Thompson sampling),
  a grid world with value iteration, and Q-learning and SARSA. Every random draw comes from a seeded generator, so
  runs repeat exactly and the tests cover what the page shows.
*/

/** A small seeded random number generator (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** What a reward of 1 received `steps` from now is worth today. */
export const discounted = (gamma: number, steps: number) => gamma ** steps;

/** The rough number of steps ahead an agent with this discount still cares about: 1 / (1 − γ). */
export const horizon = (gamma: number) => (gamma >= 1 ? Infinity : 1 / (1 - gamma));

/* ---------- Bandits ---------- */

export interface Arm {
  name: string;
  /** The true chance this arm pays out. The agent never sees it. */
  p: number;
}

/** Five invented versions of a sign-up page; each visitor either signs up (1) or not (0). */
export const ARMS: Arm[] = [
  { name: 'Page A', p: 0.1 },
  { name: 'Page B', p: 0.25 },
  { name: 'Page C', p: 0.4 },
  { name: 'Page D', p: 0.32 },
  { name: 'Page E', p: 0.18 },
];

export type BanditAlgo = 'greedy' | 'ucb' | 'thompson';

export interface BanditOptions {
  steps: number;
  epsilon: number;
  /** UCB1's exploration weight; √2 is the textbook choice. */
  c: number;
}

export interface BanditRun {
  /** Expected regret so far after each step: what the best arm would have paid, minus what the chosen arm pays. */
  regret: number[];
  pulls: number[];
  reward: number;
}

function normalSample(r: () => number): number {
  const u = Math.max(r(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}

/** A Gamma(shape, 1) draw (Marsaglia and Tsang), used to draw from a Beta distribution. */
export function gammaSample(r: () => number, shape: number): number {
  if (shape < 1) return gammaSample(r, shape + 1) * Math.max(r(), 1e-12) ** (1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = normalSample(r);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = r();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(Math.max(u, 1e-300)) < 0.5 * x * x + d * (1 - v + Math.log(v)))
      return d * v;
  }
}

export const betaSample = (r: () => number, a: number, b: number) => {
  const x = gammaSample(r, a);
  return x / (x + gammaSample(r, b));
};

const argmax = (xs: number[]) => xs.reduce((best, x, i) => (x > xs[best] ? i : best), 0);

/**
 * One run of one bandit algorithm. The payouts are drawn from `seed` alone, so every algorithm faces exactly the
 * same visitors: if page C would have signed visitor 412 up, it does so whichever algorithm shows it.
 */
export function runBandit(algo: BanditAlgo, opts: BanditOptions, seed: number, arms: Arm[] = ARMS): BanditRun {
  const world = rng(seed);
  const payout: boolean[][] = Array.from({ length: opts.steps }, () => arms.map((a) => world() < a.p));
  const choose = rng(seed * 31 + 17);
  const k = arms.length;
  const pulls = Array(k).fill(0);
  const wins = Array(k).fill(0);
  const best = Math.max(...arms.map((a) => a.p));
  const regret: number[] = [];
  let total = 0;
  let reward = 0;
  for (let t = 0; t < opts.steps; t++) {
    let a: number;
    if (algo === 'thompson') {
      a = argmax(arms.map((_, i) => betaSample(choose, 1 + wins[i], 1 + pulls[i] - wins[i])));
    } else if (t < k) {
      a = t; // try every arm once before trusting any average
    } else if (algo === 'greedy') {
      a = choose() < opts.epsilon ? Math.floor(choose() * k) : argmax(wins.map((w, i) => w / pulls[i]));
    } else {
      a = argmax(wins.map((w, i) => w / pulls[i] + opts.c * Math.sqrt(Math.log(t + 1) / pulls[i])));
    }
    const won = payout[t][a];
    pulls[a]++;
    if (won) {
      wins[a]++;
      reward++;
    }
    total += best - arms[a].p;
    regret.push(total);
  }
  return { regret, pulls, reward };
}

/** The three algorithms averaged over several seeds, so one lucky run does not decide the race. */
export function banditRace(
  opts: BanditOptions,
  runs = 20,
  seed = 1,
): Record<BanditAlgo, { regret: number[]; pulls: number[] }> {
  const out = {} as Record<BanditAlgo, { regret: number[]; pulls: number[] }>;
  for (const algo of ['greedy', 'ucb', 'thompson'] as BanditAlgo[]) {
    const regret = Array(opts.steps).fill(0);
    const pulls = Array(ARMS.length).fill(0);
    for (let r = 0; r < runs; r++) {
      const run = runBandit(algo, opts, seed + r);
      run.regret.forEach((x, i) => (regret[i] += x / runs));
      run.pulls.forEach((x, i) => (pulls[i] += x / runs));
    }
    out[algo] = { regret, pulls };
  }
  return out;
}

/* ---------- Grid worlds ---------- */

export type Cell = 'empty' | 'wall' | 'goal' | 'pit' | 'start';
export type Grid = Cell[][];
/** Up, right, down, left. */
export const ACTIONS = [
  [-1, 0],
  [0, 1],
  [1, 0],
  [0, -1],
] as const;
export const ARROWS = ['↑', '→', '↓', '←'];

/** The page's starting grid world: a goal in the top right with a pit just below it, and two walls. */
export const DEFAULT_GRID: Grid = [
  ['empty', 'empty', 'empty', 'empty', 'empty', 'goal'],
  ['empty', 'wall', 'empty', 'wall', 'empty', 'pit'],
  ['empty', 'wall', 'empty', 'empty', 'empty', 'empty'],
  ['empty', 'empty', 'empty', 'wall', 'empty', 'empty'],
  ['start', 'empty', 'empty', 'empty', 'empty', 'empty'],
];

export interface WorldOptions {
  gamma: number;
  /** Chance of slipping sideways instead of moving as intended, split between the two sides. */
  slip: number;
  /** The reward for every ordinary step, usually a small cost. */
  stepReward: number;
}

export const DEFAULT_WORLD: WorldOptions = { gamma: 0.9, slip: 0.2, stepReward: -0.04 };

const terminal = (c: Cell) => c === 'goal' || c === 'pit';
const rewardOf = (c: Cell, o: WorldOptions) => (c === 'goal' ? 1 : c === 'pit' ? -1 : o.stepReward);

/** Where an action leads from a cell: off the edge or into a wall means staying put. */
export function move(grid: Grid, r: number, c: number, a: number): [number, number] {
  const nr = r + ACTIONS[a][0];
  const nc = c + ACTIONS[a][1];
  if (nr < 0 || nc < 0 || nr >= grid.length || nc >= grid[0].length || grid[nr][nc] === 'wall') return [r, c];
  return [nr, nc];
}

/** The possible outcomes of an action: the intended move, or a slip to either side. */
export function outcomes(grid: Grid, r: number, c: number, a: number, slip: number): [number, number, number][] {
  const out: [number, number, number][] = [[1 - slip, ...move(grid, r, c, a)]];
  if (slip > 0) {
    out.push([slip / 2, ...move(grid, r, c, (a + 1) % 4)]);
    out.push([slip / 2, ...move(grid, r, c, (a + 3) % 4)]);
  }
  return out;
}

/** The expected return of taking action `a` in a cell, given the current values. */
function actionValue(grid: Grid, V: number[][], r: number, c: number, a: number, o: WorldOptions): number {
  return outcomes(grid, r, c, a, o.slip).reduce((s, [p, nr, nc]) => {
    const cell = grid[nr][nc];
    return s + p * (rewardOf(cell, o) + (terminal(cell) ? 0 : o.gamma * V[nr][nc]));
  }, 0);
}

export const zeros = (grid: Grid) => grid.map((row) => row.map(() => 0));

/** One sweep of value iteration: every cell's value becomes its best action's expected return. */
export function valueStep(grid: Grid, V: number[][], o: WorldOptions): { V: number[][]; delta: number } {
  let delta = 0;
  const next = grid.map((row, r) =>
    row.map((cell, c) => {
      if (cell === 'wall' || terminal(cell)) return 0;
      const v = Math.max(...[0, 1, 2, 3].map((a) => actionValue(grid, V, r, c, a, o)));
      delta = Math.max(delta, Math.abs(v - V[r][c]));
      return v;
    }),
  );
  return { V: next, delta };
}

/** Sweeps until the values stop changing by more than `tol`, or `max` sweeps. */
export function valueIteration(grid: Grid, o: WorldOptions, tol = 1e-6, max = 500): { V: number[][]; sweeps: number } {
  let V = zeros(grid);
  for (let i = 1; i <= max; i++) {
    const s = valueStep(grid, V, o);
    V = s.V;
    if (s.delta < tol) return { V, sweeps: i };
  }
  return { V, sweeps: max };
}

/** The greedy action in each cell (null for walls and end cells). */
export function greedyPolicy(grid: Grid, V: number[][], o: WorldOptions): (number | null)[][] {
  return grid.map((row, r) =>
    row.map((cell, c) =>
      cell === 'wall' || terminal(cell) ? null : argmax([0, 1, 2, 3].map((a) => actionValue(grid, V, r, c, a, o))),
    ),
  );
}

/** The start cell; with none marked, the first open cell from the bottom-left, so learning never starts in a wall. */
export function findStart(grid: Grid): [number, number] {
  for (let r = 0; r < grid.length; r++)
    for (let c = 0; c < grid[r].length; c++) if (grid[r][c] === 'start') return [r, c];
  for (let r = grid.length - 1; r >= 0; r--)
    for (let c = 0; c < grid[r].length; c++) if (grid[r][c] === 'empty') return [r, c];
  return [grid.length - 1, 0];
}

/* ---------- Learning from experience: Q-learning and SARSA ---------- */

/** An environment the learners can step through without knowing its rules. */
export interface Env {
  rows: number;
  cols: number;
  start: [number, number];
  step(r: number, c: number, a: number, rand: () => number): { r: number; c: number; reward: number; done: boolean };
}

export function gridEnv(grid: Grid, o: WorldOptions): Env {
  return {
    rows: grid.length,
    cols: grid[0].length,
    start: findStart(grid),
    step(r, c, a, rand) {
      let u = rand();
      let next: [number, number] = [r, c];
      for (const [p, nr, nc] of outcomes(grid, r, c, a, o.slip)) {
        next = [nr, nc];
        if ((u -= p) < 0) break;
      }
      const cell = grid[next[0]][next[1]];
      return { r: next[0], c: next[1], reward: rewardOf(cell, o), done: terminal(cell) };
    },
  };
}

/**
 * The cliff walk: a 4 × 12 grid, start bottom left, goal bottom right, and the cells between them along the bottom
 * are a cliff. Each step costs 1; stepping off the cliff costs 100 and sends you back to the start.
 */
export const CLIFF: Env = {
  rows: 4,
  cols: 12,
  start: [3, 0],
  step(r, c, a) {
    const nr = Math.min(3, Math.max(0, r + ACTIONS[a][0]));
    const nc = Math.min(11, Math.max(0, c + ACTIONS[a][1]));
    if (nr === 3 && nc > 0 && nc < 11) return { r: 3, c: 0, reward: -100, done: false };
    return { r: nr, c: nc, reward: -1, done: nr === 3 && nc === 11 };
  },
};
export const isCliff = (r: number, c: number) => r === 3 && c > 0 && c < 11;

export interface LearnOptions {
  alpha: number;
  gamma: number;
  epsilon: number;
  episodes: number;
  /** Episodes stop after this many steps, so a bad policy cannot loop forever. */
  maxSteps: number;
}

export interface LearnResult {
  /** Q[r][c][a]: the learned value of each action in each cell. */
  Q: number[][][];
  /** The total reward of each episode, while still exploring. */
  returns: number[];
}

/** The cliff walk settings the page starts with, and the seed it shows. */
export const CLIFF_RUN: LearnOptions = { alpha: 0.5, gamma: 1, epsilon: 0.1, episodes: 500, maxSteps: 500 };
export const CLIFF_SEED = 5;

function pick(Q: number[], epsilon: number, rand: () => number): number {
  if (rand() < epsilon) return Math.floor(rand() * 4);
  // Break ties at random, so an untrained agent does not always walk the same way.
  const best = Math.max(...Q);
  const ties = [0, 1, 2, 3].filter((a) => Q[a] === best);
  return ties[Math.floor(rand() * ties.length)];
}

/**
 * Tabular TD control. Q-learning updates towards the best next action (off-policy); SARSA updates towards the
 * action it will actually take next, exploration included (on-policy).
 */
export function learn(env: Env, method: 'q' | 'sarsa', o: LearnOptions, seed = 3): LearnResult {
  const rand = rng(seed);
  const Q = Array.from({ length: env.rows }, () => Array.from({ length: env.cols }, () => [0, 0, 0, 0]));
  const returns: number[] = [];
  for (let ep = 0; ep < o.episodes; ep++) {
    let [r, c] = env.start;
    let a = pick(Q[r][c], o.epsilon, rand);
    let total = 0;
    for (let t = 0; t < o.maxSteps; t++) {
      const s = env.step(r, c, a, rand);
      total += s.reward;
      const a2 = pick(Q[s.r][s.c], o.epsilon, rand);
      const next = s.done ? 0 : method === 'q' ? Math.max(...Q[s.r][s.c]) : Q[s.r][s.c][a2];
      Q[r][c][a] += o.alpha * (s.reward + o.gamma * next - Q[r][c][a]);
      [r, c, a] = [s.r, s.c, a2];
      if (s.done) break;
    }
    returns.push(total);
  }
  return { Q, returns };
}

/** The path the learned values pick from the start, with no exploration, up to `max` steps. */
export function greedyPath(env: Env, Q: number[][][], max = 60): [number, number][] {
  let [r, c] = env.start;
  const path: [number, number][] = [[r, c]];
  const noSlip = () => 0; // the first outcome is always the intended move
  for (let t = 0; t < max; t++) {
    const a = argmax(Q[r][c]);
    const s = env.step(r, c, a, noSlip);
    path.push([s.r, s.c]);
    [r, c] = [s.r, s.c];
    if (s.done) break;
  }
  return path;
}

/** A moving average, for smoothing a noisy learning curve. */
export function smooth(xs: number[], window: number): number[] {
  return xs.map((_, i) => {
    const from = Math.max(0, i - window + 1);
    const part = xs.slice(from, i + 1);
    return part.reduce((s, x) => s + x, 0) / part.length;
  });
}
