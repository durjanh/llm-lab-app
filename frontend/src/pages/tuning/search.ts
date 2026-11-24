import { fitGP, gaussian, mulberry32, suggest, type Acquisition } from './gp';

/*
  The tuning page's simulations, on invented functions in the unit square. Lower is better for the validation loss
  in the grid-against-random demo; higher is better for the hidden function Bayesian optimisation searches.
*/

export type Point = [number, number];

/**
 * An invented validation loss over two hyperparameters scaled to [0, 1]: the learning rate (on a log scale) matters a
 * great deal, the dropout rate hardly at all. That shape is common, and it is why random search beats a grid.
 */
export function validationLoss([lr, dropout]: Point): number {
  return 0.15 + 1.2 * (lr - 0.71) ** 2 + 0.02 * (dropout - 0.4) ** 2;
}

/** A side × side grid, at the centres of equal cells. */
export function gridPoints(side: number): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < side; i++) for (let j = 0; j < side; j++) out.push([(i + 0.5) / side, (j + 0.5) / side]);
  return out;
}

export function randomPoints(n: number, seed: number): Point[] {
  const rand = mulberry32(seed);
  return Array.from({ length: n }, () => [rand(), rand()] as Point);
}

/** The lowest loss among the points. */
export const bestLoss = (pts: Point[]) => Math.min(...pts.map(validationLoss));

/** How many different learning rates a set of trials actually tests (to three decimals). */
export const distinctFirst = (pts: Point[]) => new Set(pts.map((p) => p[0].toFixed(3))).size;

/** Average best loss of random search over many seeds, to compare with one grid of the same size. */
export function randomVersusGrid(side: number, seeds = 200): { grid: number; random: number; randomWins: number } {
  const n = side * side;
  const grid = bestLoss(gridPoints(side));
  let sum = 0;
  let wins = 0;
  for (let s = 1; s <= seeds; s++) {
    const b = bestLoss(randomPoints(n, s));
    sum += b;
    if (b < grid) wins++;
  }
  return { grid, random: sum / seeds, randomWins: wins / seeds };
}

/* ---------- Successive halving ---------- */

export interface Config {
  id: number;
  /** The loss it would reach if trained to the end. Hidden from the search. */
  final: number;
  /** How many epochs it takes to get most of the way there: a slow starter has a large one. */
  tau: number;
}

/** Invented configurations with different final losses and different speeds of learning. */
export function makeConfigs(n: number, seed: number): Config[] {
  const rand = mulberry32(seed);
  return Array.from({ length: n }, (_, id) => ({ id, final: 0.1 + 0.5 * rand(), tau: 2 + 13 * rand() }));
}

/** Validation loss after some epochs: falls from 1.0 towards the final loss, with a little noise. */
export function lossAt(c: Config, epochs: number, seed: number): number {
  const noise = 0.01 * gaussian(mulberry32(seed * 7919 + c.id * 31 + epochs));
  return c.final + (1 - c.final) * Math.exp(-epochs / c.tau) + noise;
}

export interface HalvingRound {
  epochs: number;
  survivors: number[];
  losses: number[];
}

export interface HalvingResult {
  rounds: HalvingRound[];
  totalEpochs: number;
  chosen: Config;
  bestPossible: Config;
}

/**
 * Successive halving: train every configuration briefly, keep the best 1/η, give the survivors η times more epochs,
 * and repeat until one is left or the maximum is reached. Most of the budget goes to the promising ones.
 */
export function successiveHalving(configs: Config[], minEpochs: number, eta: number, maxEpochs: number, seed: number) {
  let alive = configs.map((c) => c.id);
  let epochs = minEpochs;
  let used = 0;
  let spent = 0; // epochs already given to each survivor
  const rounds: HalvingRound[] = [];
  for (;;) {
    const losses = alive.map((id) => lossAt(configs[id], epochs, seed));
    used += alive.length * (epochs - spent);
    spent = epochs;
    rounds.push({ epochs, survivors: [...alive], losses });
    if (alive.length === 1 || epochs >= maxEpochs) break;
    const keep = Math.max(1, Math.floor(alive.length / eta));
    alive = alive
      .map((id, i) => [id, losses[i]] as const)
      .sort((a, b) => a[1] - b[1])
      .slice(0, keep)
      .map(([id]) => id);
    epochs = Math.min(maxEpochs, epochs * eta);
  }
  const last = rounds[rounds.length - 1];
  const winner = last.survivors[last.losses.indexOf(Math.min(...last.losses))];
  const bestPossible = configs.reduce((a, b) => (b.final < a.final ? b : a));
  return { rounds, totalEpochs: used, chosen: configs[winner], bestPossible } satisfies HalvingResult;
}

/** The same budget spent training whole configurations, as many as it pays for, chosen at random. */
export function fullTraining(configs: Config[], budget: number, maxEpochs: number) {
  const count = Math.max(1, Math.min(configs.length, Math.floor(budget / maxEpochs)));
  const tried = configs.slice(0, count);
  const chosen = tried.reduce((a, b) => (b.final < a.final ? b : a));
  return { count, chosen };
}

/* ---------- Bayesian optimisation in two dimensions ---------- */

/** The hidden function: a broad hill, a taller narrow peak, and a gentle slope. Its maximum is about 1.0 near (0.78, 0.27). */
export function hidden2d([x, y]: Point): number {
  const broad = 0.75 * Math.exp(-((x - 0.25) ** 2 + (y - 0.7) ** 2) / (2 * 0.18 ** 2));
  const narrow = 1.0 * Math.exp(-((x - 0.78) ** 2 + (y - 0.27) ** 2) / (2 * 0.07 ** 2));
  return broad + narrow + 0.05 * y;
}

export interface SearchTrace {
  points: Point[];
  values: number[];
  /** The best value found after each evaluation. */
  bestSoFar: number[];
}

const trace = (points: Point[], f: (p: Point) => number): SearchTrace => {
  const values = points.map(f);
  const bestSoFar: number[] = [];
  values.forEach((v, i) => bestSoFar.push(i ? Math.max(bestSoFar[i - 1], v) : v));
  return { points, values, bestSoFar };
};

export function randomSearch(budget: number, seed: number, f = hidden2d): SearchTrace {
  return trace(randomPoints(budget, seed), f);
}

/** Bayesian optimisation: a few random starting points, then each next point chosen by the acquisition function. */
export function bayesSearch(
  budget: number,
  seed: number,
  kind: Acquisition = 'ei',
  f = hidden2d,
  init = 4,
  lengthScale = 0.12,
  kappa = 2,
): SearchTrace {
  const pts: Point[] = randomPoints(Math.min(init, budget), seed);
  const vals = pts.map(f);
  while (pts.length < budget) {
    const gp = fitGP(pts, vals, { lengthScale, signalVar: 1, noise: 1e-4 });
    const next = suggest(gp, 2, kind, seed * 1000 + pts.length, { candidates: 500, exclude: pts, kappa }) as Point;
    pts.push(next);
    vals.push(f(next));
  }
  return trace(pts, f);
}

/** The mean best-so-far curve over several seeds. */
export function meanCurve(traces: SearchTrace[]): number[] {
  const n = traces[0].bestSoFar.length;
  return Array.from({ length: n }, (_, i) => traces.reduce((s, t) => s + t.bestSoFar[i], 0) / traces.length);
}
