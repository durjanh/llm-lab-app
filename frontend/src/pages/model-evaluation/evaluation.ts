import { cholesky, gaussian, mulberry32, solveLower, solveUpper } from '../tuning/gp';

/*
  The model evaluation page's calculations, on invented data: a screening test's scores, polynomial fits for
  learning and complexity curves, cross-validation folds, and an imbalanced dataset for the resampling demos.
*/

/* ---------- A scored screening dataset ---------- */

export interface Scored {
  scores: number[];
  /** 1 for a person who has the condition, 0 otherwise. */
  labels: number[];
}

/**
 * An invented screening test: people with the condition score around 0.66, people without around 0.38, both with
 * the same spread, so the classes overlap. Exactly round(n × prevalence) people have the condition.
 */
export function screening(n: number, prevalence: number, seed: number, spread = 0.15): Scored {
  const rand = mulberry32(seed);
  const positives = Math.round(n * prevalence);
  const scores: number[] = [];
  const labels: number[] = [];
  for (let i = 0; i < n; i++) {
    const y = i < positives ? 1 : 0;
    const s = (y ? 0.66 : 0.38) + spread * gaussian(rand);
    scores.push(Math.min(0.999, Math.max(0.001, s)));
    labels.push(y);
  }
  return { scores, labels };
}

export interface Confusion {
  tp: number;
  fp: number;
  tn: number;
  fn: number;
}

/** Counts at a threshold: a score at or above it is called positive. */
export function confusion({ scores, labels }: Scored, threshold: number): Confusion {
  const c = { tp: 0, fp: 0, tn: 0, fn: 0 };
  scores.forEach((s, i) => {
    const pos = s >= threshold;
    if (labels[i]) {
      if (pos) c.tp++;
      else c.fn++;
    } else if (pos) c.fp++;
    else c.tn++;
  });
  return c;
}

export interface Metrics {
  accuracy: number;
  /** Sensitivity, also called recall or the true positive rate. */
  sensitivity: number;
  specificity: number;
  /** Null when nothing was called positive. */
  precision: number | null;
  f1: number | null;
}

const ratio = (a: number, b: number) => (b ? a / b : 0);

export function metrics(c: Confusion): Metrics {
  const precision = c.tp + c.fp ? c.tp / (c.tp + c.fp) : null;
  const sensitivity = ratio(c.tp, c.tp + c.fn);
  const f1 =
    precision !== null && precision + sensitivity > 0
      ? (2 * precision * sensitivity) / (precision + sensitivity)
      : null;
  return {
    accuracy: ratio(c.tp + c.tn, c.tp + c.tn + c.fp + c.fn),
    sensitivity,
    specificity: ratio(c.tn, c.tn + c.fp),
    precision,
    f1,
  };
}

/** Thresholds from 1 down to 0 in steps of 0.01, so curves run from (0, 0) to (1, 1). */
export const THRESHOLDS = Array.from({ length: 101 }, (_, i) => 1 - i / 100);

/** The ROC curve as [false positive rate, true positive rate] for each threshold. */
export function rocCurve(d: Scored): [number, number][] {
  return [
    [0, 0],
    ...THRESHOLDS.map((t) => {
      const m = metrics(confusion(d, t));
      return [1 - m.specificity, m.sensitivity] as [number, number];
    }),
    [1, 1],
  ];
}

/**
 * Area under the ROC curve, computed exactly as the chance that a random positive scores above a random negative
 * (ties count half). It does not depend on any threshold.
 */
export function auc({ scores, labels }: Scored): number {
  const pos = scores.filter((_, i) => labels[i]);
  const neg = scores.filter((_, i) => !labels[i]);
  let wins = 0;
  for (const p of pos) for (const n of neg) wins += p > n ? 1 : p === n ? 0.5 : 0;
  return ratio(wins, pos.length * neg.length);
}

/** The precision–recall curve as [recall, precision], skipping thresholds where nothing is called positive. */
export function prCurve(d: Scored): [number, number][] {
  const out: [number, number][] = [];
  for (const t of THRESHOLDS) {
    const m = metrics(confusion(d, t));
    if (m.precision !== null) out.push([m.sensitivity, m.precision]);
  }
  return out;
}

/**
 * Cumulative gains: sort people by score, highest first, and for each share contacted give the share of all
 * positives found. Lift is that share divided by the share contacted: how many times better than picking at random.
 */
export function gains({ scores, labels }: Scored, steps = 20): { contacted: number; captured: number; lift: number }[] {
  const order = scores.map((s, i) => [s, labels[i]]).sort((a, b) => b[0] - a[0]);
  const total = labels.reduce((a, b) => a + b, 0) || 1;
  const out = [{ contacted: 0, captured: 0, lift: 1 }];
  for (let k = 1; k <= steps; k++) {
    const n = Math.round((order.length * k) / steps);
    const found = order.slice(0, n).reduce((a, [, y]) => a + y, 0);
    const contacted = k / steps;
    const captured = found / total;
    out.push({ contacted, captured, lift: captured / contacted });
  }
  return out;
}

export interface Costs {
  /** The cost of missing a person who has the condition. */
  fn: number;
  /** The cost of sending a well person for a follow-up test. */
  fp: number;
}

export const totalCost = (c: Confusion, costs: Costs) => c.fn * costs.fn + c.fp * costs.fp;

/** The threshold with the lowest total cost, scanning the same grid of thresholds. */
export function cheapestThreshold(d: Scored, costs: Costs): { threshold: number; cost: number } {
  let best = { threshold: 0.5, cost: Infinity };
  for (const t of THRESHOLDS) {
    const cost = totalCost(confusion(d, t), costs);
    if (cost < best.cost) best = { threshold: t, cost };
  }
  return best;
}

/* ---------- Learning and complexity curves ---------- */

/** The true curve the polynomial fits try to learn. */
export const truth = (x: number) => Math.sin(3 * x) + 0.3 * x;

/** n points with x uniform in [-1, 1] and the true curve plus noise. */
export function curveData(n: number, seed: number, noise = 0.3): { x: number[]; y: number[] } {
  const rand = mulberry32(seed);
  const x = Array.from({ length: n }, () => 2 * rand() - 1);
  return { x, y: x.map((v) => truth(v) + noise * gaussian(rand)) };
}

/** Least-squares polynomial fit with a tiny ridge so very flexible fits stay solvable. Returns the coefficients. */
export function fitPoly(x: number[], y: number[], degree: number, ridge = 1e-6): number[] {
  const p = degree + 1;
  const A = Array.from({ length: p }, () => new Array<number>(p).fill(0));
  const b = new Array<number>(p).fill(0);
  x.forEach((xi, n) => {
    const pw = Array.from({ length: p }, (_, k) => xi ** k);
    for (let i = 0; i < p; i++) {
      b[i] += pw[i] * y[n];
      for (let j = 0; j < p; j++) A[i][j] += pw[i] * pw[j];
    }
  });
  for (let i = 0; i < p; i++) A[i][i] += ridge;
  const L = cholesky(A);
  return solveUpper(L, solveLower(L, b));
}

export const polyAt = (coef: number[], x: number) => coef.reduce((s, c, k) => s + c * x ** k, 0);

export const mse = (coef: number[], x: number[], y: number[]) =>
  x.reduce((s, xi, i) => s + (polyAt(coef, xi) - y[i]) ** 2, 0) / x.length;

const VALIDATION = curveData(400, 999);

/** Mean training and validation error over several random training sets, for each training-set size. */
export function learningCurve(degree: number, sizes: number[], reps = 12) {
  return sizes.map((n) => {
    let train = 0;
    let val = 0;
    for (let r = 0; r < reps; r++) {
      const d = curveData(n, 100 + r * 37 + n);
      const coef = fitPoly(d.x, d.y, degree);
      train += mse(coef, d.x, d.y);
      val += mse(coef, VALIDATION.x, VALIDATION.y);
    }
    return { n, train: train / reps, val: val / reps };
  });
}

/** Mean training and validation error for each polynomial degree, at one training-set size. */
export function complexityCurve(n: number, degrees: number[], reps = 12) {
  return degrees.map((degree) => {
    let train = 0;
    let val = 0;
    for (let r = 0; r < reps; r++) {
      const d = curveData(n, 500 + r * 41);
      const coef = fitPoly(d.x, d.y, degree);
      train += mse(coef, d.x, d.y);
      val += mse(coef, VALIDATION.x, VALIDATION.y);
    }
    return { degree, train: train / reps, val: val / reps };
  });
}

/* ---------- Why three splits ---------- */

const binomialShare = (n: number, p: number, rand: () => number) => {
  let k = 0;
  for (let i = 0; i < n; i++) if (rand() < p) k++;
  return k / n;
};

/**
 * Many models that are all equally good (true accuracy p) are scored on one validation set, and the best is picked.
 * Its validation score is optimistic; a fresh test set shows the truth. Averaged over repeats.
 */
export function selectionOptimism(
  models: number,
  valSize: number,
  testSize: number,
  p: number,
  seed: number,
  reps = 40,
) {
  const rand = mulberry32(seed);
  let bestVal = 0;
  let test = 0;
  for (let r = 0; r < reps; r++) {
    let best = 0;
    for (let m = 0; m < models; m++) best = Math.max(best, binomialShare(valSize, p, rand));
    bestVal += best;
    test += binomialShare(testSize, p, rand);
  }
  return { bestVal: bestVal / reps, test: test / reps };
}

/* ---------- Cross-validation ---------- */

function shuffle<T>(xs: T[], rand: () => number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * The fold of each row. Plain k-fold shuffles all rows and cuts them into k equal blocks. Stratified k-fold deals
 * each class out in turn, so every fold has close to the same share of positives.
 */
export function assignFolds(labels: number[], k: number, stratified: boolean, seed: number): number[] {
  const rand = mulberry32(seed);
  const folds = new Array<number>(labels.length).fill(0);
  const idx = labels.map((_, i) => i);
  if (stratified) {
    let turn = 0;
    for (const cls of [1, 0])
      for (const i of shuffle(
        idx.filter((j) => labels[j] === cls),
        rand,
      ))
        folds[i] = turn++ % k;
  } else {
    const order = shuffle(idx, rand);
    const size = Math.ceil(labels.length / k);
    order.forEach((i, pos) => (folds[i] = Math.floor(pos / size)));
  }
  return folds;
}

export const positivesPerFold = (labels: number[], folds: number[], k: number) =>
  Array.from({ length: k }, (_, f) => labels.filter((y, i) => y && folds[i] === f).length);

/** Sensitivity of a fixed rule (score ≥ threshold) measured on each fold. Null for a fold with no positives. */
export function foldSensitivities(d: Scored, folds: number[], k: number, threshold = 0.5): (number | null)[] {
  return Array.from({ length: k }, (_, f) => {
    const keep = folds.map((g, i) => (g === f ? i : -1)).filter((i) => i >= 0);
    const sub = { scores: keep.map((i) => d.scores[i]), labels: keep.map((i) => d.labels[i]) };
    const c = confusion(sub, threshold);
    return c.tp + c.fn ? c.tp / (c.tp + c.fn) : null;
  });
}

export const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
export const sd = (xs: number[]) => {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length - 1));
};

/** Repeated k-fold: the fold scores of several differently shuffled runs, and the spread of each run's mean. */
export function repeatedCv(d: Scored, k: number, repeats: number, stratified: boolean) {
  const runMeans: number[] = [];
  const all: number[] = [];
  for (let r = 0; r < repeats; r++) {
    const scores = foldSensitivities(d, assignFolds(d.labels, k, stratified, 11 + r), k).filter(
      (s): s is number => s !== null,
    );
    all.push(...scores);
    runMeans.push(mean(scores));
  }
  return { all, runMeans, mean: mean(runMeans), sdOfRunMeans: sd(runMeans), sdOfFolds: sd(all) };
}

/** Expanding-window splits for data in time order: train on everything up to a point, test on the next block. */
export function timeSeriesSplits(n: number, k: number): { trainEnd: number; testEnd: number }[] {
  const block = Math.floor(n / (k + 1));
  return Array.from({ length: k }, (_, i) => ({ trainEnd: block * (i + 1), testEnd: block * (i + 2) }));
}

/* ---------- Class imbalance and resampling ---------- */

export interface Table {
  X: [number, number][];
  y: number[];
}

/** An invented imbalanced table with two features: rare positives sit up and to the right, overlapping negatives. */
export function imbalanced(n: number, prevalence: number, seed: number): Table {
  const rand = mulberry32(seed);
  const pos = Math.round(n * prevalence);
  const X: [number, number][] = [];
  const y: number[] = [];
  for (let i = 0; i < n; i++) {
    const isPos = i < pos;
    X.push(isPos ? [1.3 + 0.8 * gaussian(rand), 1.1 + 0.8 * gaussian(rand)] : [gaussian(rand), gaussian(rand)]);
    y.push(isPos ? 1 : 0);
  }
  return { X, y };
}

/** A stratified split of row indices into training and test. */
export function stratifiedSplit(y: number[], testShare: number, seed: number): { train: number[]; test: number[] } {
  const rand = mulberry32(seed);
  const train: number[] = [];
  const test: number[] = [];
  for (const cls of [1, 0]) {
    const rows = shuffle(
      y.map((_, i) => i).filter((i) => y[i] === cls),
      rand,
    );
    const cut = Math.round(rows.length * testShare);
    test.push(...rows.slice(0, cut));
    train.push(...rows.slice(cut));
  }
  return { train, test };
}

export type Method = 'none' | 'under' | 'over' | 'smote' | 'weights';

const dist2 = (a: [number, number], b: [number, number]) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;

/**
 * Balances a table. Undersampling drops negatives at random; oversampling copies positives; SMOTE makes new
 * positives on the line between a positive and one of its five nearest positive neighbours. Weights leave it as is.
 */
export function resample(t: Table, method: Method, seed: number): Table {
  const rand = mulberry32(seed);
  const posRows = t.y.map((_, i) => i).filter((i) => t.y[i] === 1);
  const negRows = t.y.map((_, i) => i).filter((i) => t.y[i] === 0);
  if (method === 'none' || method === 'weights' || posRows.length === 0) return t;
  if (method === 'under') {
    const keep = [...posRows, ...shuffle(negRows, rand).slice(0, posRows.length)];
    return { X: keep.map((i) => t.X[i]), y: keep.map((i) => t.y[i]) };
  }
  const need = negRows.length - posRows.length;
  const X = [...t.X];
  const y = [...t.y];
  for (let k = 0; k < need; k++) {
    const a = posRows[Math.floor(rand() * posRows.length)];
    if (method === 'over') {
      X.push(t.X[a]);
    } else {
      const near = posRows
        .filter((b) => b !== a)
        .sort((b, c) => dist2(t.X[a], t.X[b]) - dist2(t.X[a], t.X[c]))
        .slice(0, 5);
      const b = near.length ? near[Math.floor(rand() * near.length)] : a;
      const lam = rand();
      X.push([t.X[a][0] + lam * (t.X[b][0] - t.X[a][0]), t.X[a][1] + lam * (t.X[b][1] - t.X[a][1])]);
    }
    y.push(1);
  }
  return { X, y };
}

/** k-nearest neighbours with a weight on positive votes: a row is called positive when the weighted vote is half or more. */
export function knnPredict(train: Table, rows: [number, number][], k: number, posWeight = 1): number[] {
  return rows.map((r) => {
    const near = train.X.map((x, i) => [dist2(x, r), train.y[i]] as const)
      .sort((a, b) => a[0] - b[0])
      .slice(0, k);
    const pos = near.filter(([, y]) => y === 1).length * posWeight;
    const neg = near.filter(([, y]) => y === 0).length;
    return pos >= neg ? 1 : 0;
  });
}

export interface ImbalanceResult {
  sensitivity: number;
  precision: number | null;
  f1: number | null;
  /** How many test rows are exact copies of a training row. */
  copiesInTest: number;
  testRows: number;
  testPositives: number;
}

/**
 * Scores one way of handling imbalance on held-out data. Done right, the split comes first and only the training
 * rows are resampled. Done wrong (leaky), the whole table is resampled and then split, so copies or near-copies of
 * test rows sit in training, and an undersampled test set no longer has the real share of positives.
 */
export function imbalanceExperiment(t: Table, method: Method, leaky: boolean, seed = 4, k = 7): ImbalanceResult {
  let train: Table;
  let test: Table;
  if (leaky && method !== 'none' && method !== 'weights') {
    const all = resample(t, method, seed);
    const s = stratifiedSplit(all.y, 0.3, seed);
    train = { X: s.train.map((i) => all.X[i]), y: s.train.map((i) => all.y[i]) };
    test = { X: s.test.map((i) => all.X[i]), y: s.test.map((i) => all.y[i]) };
  } else {
    const s = stratifiedSplit(t.y, 0.3, seed);
    const raw = { X: s.train.map((i) => t.X[i]), y: s.train.map((i) => t.y[i]) };
    train = resample(raw, method, seed);
    test = { X: s.test.map((i) => t.X[i]), y: s.test.map((i) => t.y[i]) };
  }
  const posShare = train.y.filter((v) => v === 1).length / train.y.length;
  const weight = method === 'weights' ? (1 - posShare) / posShare : 1;
  const pred = knnPredict(train, test.X, k, weight);
  const c: Confusion = { tp: 0, fp: 0, tn: 0, fn: 0 };
  pred.forEach((p, i) => {
    const yv = test.y[i];
    if (yv && p) c.tp++;
    else if (yv) c.fn++;
    else if (p) c.fp++;
    else c.tn++;
  });
  const m = metrics(c);
  const seen = new Set(train.X.map((x) => `${x[0]},${x[1]}`));
  return {
    sensitivity: m.sensitivity,
    precision: m.precision,
    f1: m.f1,
    copiesInTest: test.X.filter((x) => seen.has(`${x[0]},${x[1]}`)).length,
    testRows: test.y.length,
    testPositives: test.y.filter((v) => v === 1).length,
  };
}
