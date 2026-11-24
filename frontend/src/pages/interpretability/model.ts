/*
  The interpretability page's invented loan model and every calculation shown on the page: the population, the
  scoring model, permutation importance, partial dependence and ICE curves, exact Shapley values, counterfactuals,
  group fairness metrics and calibration. All of it is deterministic, so the tests cover the numbers the page shows.
*/

export const FEATURES = ['income', 'debt', 'years', 'missed'] as const;
export type Feature = (typeof FEATURES)[number];
export type Group = 'North' | 'South';

export interface Applicant {
  id: number;
  /** Yearly income in thousands of pounds. */
  income: number;
  /** Monthly debt repayments as a share of income, 0 to 1. */
  debt: number;
  /** Years at the current address. */
  years: number;
  /** Missed payments in the last two years. */
  missed: number;
  /** Which branch area the applicant lives in. The model never sees it. */
  group: Group;
  /** What actually happened: true when the loan was repaid. */
  repaid: boolean;
}

export const FEATURE_INFO: Record<Feature, { label: string; unit: string; min: number; max: number; step: number }> = {
  income: { label: 'Income', unit: '£k a year', min: 15, max: 110, step: 1 },
  debt: { label: 'Debt ratio', unit: 'of income', min: 0, max: 0.85, step: 0.01 },
  years: { label: 'Years at address', unit: 'years', min: 0, max: 25, step: 0.5 },
  missed: { label: 'Missed payments', unit: 'in 2 years', min: 0, max: 5, step: 1 },
};

/** A small seeded random number generator (mulberry32), so every run of the page shows the same people. */
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

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;
export const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));
export const logit = (p: number) => Math.log(p / (1 - p));

function normal(r: () => number, mean: number, sd: number): number {
  const u = Math.max(r(), 1e-12);
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}

/**
 * The true chance of repaying, which the applicants' outcomes are drawn from. Years at the address barely matters
 * here; the model below weighs it four times more, which is how it picks up the branch area as a proxy.
 */
function trueRepay(a: Omit<Applicant, 'repaid' | 'id' | 'group'>): number {
  return sigmoid(0.9 + 0.045 * (a.income - 42) - 4.2 * (a.debt - 0.32) + 0.02 * (a.years - 5) - 0.75 * a.missed);
}

/** 600 invented applicants. South has lower incomes and more renters (fewer years at one address). */
export function makePopulation(n = 600, seed = 21): Applicant[] {
  const r = rng(seed);
  const missedDist = [0.58, 0.2, 0.11, 0.06, 0.03, 0.02];
  const out: Applicant[] = [];
  for (let id = 0; id < n; id++) {
    const group: Group = r() < 0.5 ? 'North' : 'South';
    const income = round(clamp(normal(r, group === 'North' ? 47 : 39, 14), 15, 110), 1);
    const debt = round(clamp(normal(r, 0.32, 0.12), 0.02, 0.85), 2);
    const years = round(clamp(-Math.log(Math.max(r(), 1e-9)) * (group === 'North' ? 7.5 : 3.5), 0, 25), 1);
    let u = r();
    let missed = 0;
    while (missed < missedDist.length - 1 && u > missedDist[missed]) u -= missedDist[missed++];
    const repaid = r() < trueRepay({ income, debt, years, missed });
    out.push({ id, income, debt, years, missed, group, repaid });
  }
  return out;
}

export const POPULATION = makePopulation();

/** The scoring model: a logistic regression with fixed, published weights. */
export interface Model {
  intercept: number;
  weights: Record<Feature, number>;
  /** The value each feature is measured from, so the intercept is the log-odds of a typical applicant. */
  centre: Record<Feature, number>;
}

export const MODEL: Model = {
  intercept: 0.8,
  weights: { income: 0.04, debt: -4.0, years: 0.08, missed: -0.7 },
  centre: { income: 42, debt: 0.32, years: 5, missed: 0 },
};

export type Point = Record<Feature, number>;

export function logOdds(x: Point, m: Model = MODEL): number {
  return FEATURES.reduce((z, f) => z + m.weights[f] * (x[f] - m.centre[f]), m.intercept);
}

/** The model's probability that this applicant repays. */
export const predict = (x: Point, m: Model = MODEL) => sigmoid(logOdds(x, m));

/** Area under the ROC curve: the chance a random repayer scores above a random defaulter (ties count half). */
export function auc(scores: number[], labels: boolean[]): number {
  const idx = scores.map((s, i) => i).sort((a, b) => scores[a] - scores[b]);
  let rankSum = 0;
  let pos = 0;
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && scores[idx[j + 1]] === scores[idx[i]]) j++;
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++)
      if (labels[idx[k]]) {
        rankSum += avgRank;
        pos++;
      }
    i = j + 1;
  }
  const neg = labels.length - pos;
  if (pos === 0 || neg === 0) return 0.5;
  return (rankSum - (pos * (pos + 1)) / 2) / (pos * neg);
}

export function accuracy(rows: Applicant[], threshold = 0.5, m: Model = MODEL): number {
  return rows.filter((a) => predict(a, m) >= threshold === a.repaid).length / rows.length;
}

export interface Importance {
  feature: Feature;
  /** Fall in AUC when the feature is shuffled, averaged over the repeats. */
  drop: number;
  /** The smallest and largest fall across repeats, to show the spread. */
  min: number;
  max: number;
}

/** Permutation importance: shuffle one column, keep the rest, and see how far the model's AUC falls. */
export function permutationImportance(rows: Applicant[] = POPULATION, repeats = 5, seed = 7): Importance[] {
  const labels = rows.map((a) => a.repaid);
  const base = auc(
    rows.map((a) => predict(a)),
    labels,
  );
  return FEATURES.map((feature, fi) => {
    const drops: number[] = [];
    for (let k = 0; k < repeats; k++) {
      const r = rng(seed * 100 + fi * 10 + k);
      const col = rows.map((a) => a[feature]);
      for (let i = col.length - 1; i > 0; i--) {
        const j = Math.floor(r() * (i + 1));
        [col[i], col[j]] = [col[j], col[i]];
      }
      const scores = rows.map((a, i) => predict({ ...a, [feature]: col[i] }));
      drops.push(base - auc(scores, labels));
    }
    return {
      feature,
      drop: drops.reduce((s, d) => s + d, 0) / drops.length,
      min: Math.min(...drops),
      max: Math.max(...drops),
    };
  }).sort((a, b) => b.drop - a.drop);
}

/** Evenly spaced values across a feature's range. */
export function grid(feature: Feature, n = 21): number[] {
  const { min, max } = FEATURE_INFO[feature];
  return Array.from({ length: n }, (_, i) => min + ((max - min) * i) / (n - 1));
}

/** Partial dependence: set everyone's feature to each value in turn and average the predictions. */
export function partialDependence(feature: Feature, rows: Applicant[] = POPULATION, n = 21): [number, number][] {
  return grid(feature, n).map((v) => [v, rows.reduce((s, a) => s + predict({ ...a, [feature]: v }), 0) / rows.length]);
}

/** ICE curves: the same sweep, one line per applicant, so a spread hidden by the average shows. */
export function iceCurves(feature: Feature, rows: Applicant[], n = 21): [number, number][][] {
  return rows.map((a) => grid(feature, n).map((v): [number, number] => [v, predict({ ...a, [feature]: v })]));
}

export interface Coalition {
  /** Features taken from the applicant; the rest are filled in from the background rows. */
  members: Feature[];
  value: number;
}

export interface ShapleyResult {
  /** The average prediction over the background rows: where every explanation starts. */
  base: number;
  prediction: number;
  phi: Record<Feature, number>;
  coalitions: Coalition[];
}

/**
 * Exact Shapley values for one applicant. A coalition's value is the average prediction when the coalition's
 * features come from the applicant and the others from each background row in turn. With four features there are
 * sixteen coalitions, so nothing is sampled; SHAP's estimators approximate this sum when there are too many.
 */
export function shapley(
  x: Point,
  background: Applicant[] = POPULATION.slice(0, 150),
  output: 'probability' | 'logOdds' = 'probability',
  m: Model = MODEL,
): ShapleyResult {
  const f = (p: Point) => (output === 'probability' ? predict(p, m) : logOdds(p, m));
  const n = FEATURES.length;
  const value = new Map<number, number>();
  const coalitions: Coalition[] = [];
  for (let mask = 0; mask < 1 << n; mask++) {
    let sum = 0;
    for (const b of background) {
      const p = { ...b } as Point;
      FEATURES.forEach((feat, i) => {
        if (mask & (1 << i)) p[feat] = x[feat];
      });
      sum += f(p);
    }
    const v = sum / background.length;
    value.set(mask, v);
    coalitions.push({ members: FEATURES.filter((_, i) => mask & (1 << i)), value: v });
  }
  const fact = (k: number): number => (k <= 1 ? 1 : k * fact(k - 1));
  const phi = {} as Record<Feature, number>;
  FEATURES.forEach((feat, i) => {
    let total = 0;
    for (let mask = 0; mask < 1 << n; mask++) {
      if (mask & (1 << i)) continue;
      let size = 0;
      for (let b = 0; b < n; b++) if (mask & (1 << b)) size++;
      const weight = (fact(size) * fact(n - size - 1)) / fact(n);
      total += weight * (value.get(mask | (1 << i))! - value.get(mask)!);
    }
    phi[feat] = total;
  });
  coalitions.sort((a, b) => a.members.length - b.members.length);
  return { base: value.get(0)!, prediction: f(x), phi, coalitions };
}

export interface Counterfactual {
  feature: Feature;
  /** The value the feature would need, all else equal, to reach the threshold. */
  needed: number;
  change: number;
  /** False when the value is outside the feature's range. */
  possible: boolean;
  /** Whether the applicant could act on it, and why not when they cannot. */
  actionable: boolean;
  note: string;
}

/** For each feature alone, the value that would move this applicant to the threshold. */
export function counterfactuals(x: Point, threshold = 0.5, m: Model = MODEL): Counterfactual[] {
  const gap = logit(threshold) - logOdds(x, m);
  return FEATURES.map((feature) => {
    const change = gap / m.weights[feature];
    const needed = x[feature] + change;
    const { min, max } = FEATURE_INFO[feature];
    const possible = needed >= min - 1e-9 && needed <= max + 1e-9;
    const notes: Record<Feature, [boolean, string]> = {
      income: [true, 'Possible over time, but rarely quickly.'],
      debt: [true, 'The most practical lever: paying down a card or a loan.'],
      years: [false, 'Only time changes it, and moving house makes it worse. A model should not hinge on it.'],
      missed: [false, 'Past missed payments cannot be undone; they only age out of the two-year window.'],
    };
    const [actionable, note] = notes[feature];
    return { feature, needed, change, possible, actionable, note };
  });
}

export interface GroupStats {
  group: Group;
  n: number;
  /** Share who actually repaid. */
  baseRate: number;
  /** Share approved: demographic parity compares this. */
  selection: number;
  /** Approved among those who repaid: equal opportunity compares this. */
  tpr: number;
  /** Approved among those who defaulted: equalised odds adds this. */
  fpr: number;
  /** Repaid among those approved: predictive parity compares this. */
  ppv: number;
}

export function groupStats(rows: Applicant[], thresholds: Record<Group, number>, m: Model = MODEL): GroupStats[] {
  return (['North', 'South'] as Group[]).map((group) => {
    const g = rows.filter((a) => a.group === group);
    const approved = g.filter((a) => predict(a, m) >= thresholds[group]);
    const repaid = g.filter((a) => a.repaid);
    const defaulted = g.filter((a) => !a.repaid);
    const ratio = (a: number, b: number) => (b === 0 ? 0 : a / b);
    return {
      group,
      n: g.length,
      baseRate: ratio(repaid.length, g.length),
      selection: ratio(approved.length, g.length),
      tpr: ratio(approved.filter((a) => a.repaid).length, repaid.length),
      fpr: ratio(approved.filter((a) => !a.repaid).length, defaulted.length),
      ppv: ratio(approved.filter((a) => a.repaid).length, approved.length),
    };
  });
}

export interface FairnessGaps {
  parity: number;
  opportunity: number;
  /** The larger of the TPR and FPR gaps. */
  odds: number;
  predictive: number;
}

export function gaps(stats: GroupStats[]): FairnessGaps {
  const [a, b] = stats;
  return {
    parity: Math.abs(a.selection - b.selection),
    opportunity: Math.abs(a.tpr - b.tpr),
    odds: Math.max(Math.abs(a.tpr - b.tpr), Math.abs(a.fpr - b.fpr)),
    predictive: Math.abs(a.ppv - b.ppv),
  };
}

const THRESHOLDS = Array.from({ length: 81 }, (_, i) => round(0.1 + i * 0.01, 2));

/** South's threshold that best closes one gap, with North's held where it is. */
export function matchThreshold(
  target: keyof FairnessGaps,
  north: number,
  rows: Applicant[] = POPULATION,
  m: Model = MODEL,
): number {
  let best = north;
  let bestGap = Infinity;
  for (const t of THRESHOLDS) {
    const g = gaps(groupStats(rows, { North: north, South: t }, m))[target];
    if (g < bestGap - 1e-12) {
      bestGap = g;
      best = t;
    }
  }
  return best;
}

/**
 * Over every pair of thresholds, the smallest possible worst gap among predictive parity, the TPR gap and the FPR
 * gap. When the groups' base rates differ, this never reaches zero: those three cannot all hold at once for
 * an imperfect model.
 */
export function bestOfAllThree(
  rows: Applicant[] = POPULATION,
  m: Model = MODEL,
): { gap: number; north: number; south: number } {
  // Score everyone once; the search below then only counts, which keeps 6,500 threshold pairs fast.
  const rates = (group: Group) => {
    const g = rows.filter((a) => a.group === group).map((a) => ({ p: predict(a, m), y: a.repaid }));
    const pos = g.filter((r) => r.y).length;
    return new Map(
      THRESHOLDS.map((t) => {
        const approved = g.filter((r) => r.p >= t);
        const tp = approved.filter((r) => r.y).length;
        return [
          t,
          {
            selection: approved.length / g.length,
            tpr: pos ? tp / pos : 0,
            fpr: g.length - pos ? (approved.length - tp) / (g.length - pos) : 0,
            ppv: approved.length ? tp / approved.length : 0,
          },
        ];
      }),
    );
  };
  const north = rates('North');
  const south = rates('South');
  let best = { gap: Infinity, north: 0.5, south: 0.5 };
  for (const tn of THRESHOLDS)
    for (const ts of THRESHOLDS) {
      const a = north.get(tn)!;
      const b = south.get(ts)!;
      // Thresholds that approve almost nobody make every rate meaningless; require at least a fifth approved.
      if (a.selection < 0.2 || b.selection < 0.2) continue;
      const worst = Math.max(Math.abs(a.ppv - b.ppv), Math.abs(a.tpr - b.tpr), Math.abs(a.fpr - b.fpr));
      if (worst < best.gap) best = { gap: worst, north: tn, south: ts };
    }
  return best;
}

export interface CalibrationBin {
  lo: number;
  hi: number;
  /** Mean predicted chance and observed repay rate per group; null where the bin has fewer than 8 people. */
  predicted: Record<Group, number | null>;
  observed: Record<Group, number | null>;
}

/** Calibration by group: within each band of predicted chance, how often each group actually repaid. */
export function calibration(rows: Applicant[] = POPULATION, bins = 5, m: Model = MODEL): CalibrationBin[] {
  return Array.from({ length: bins }, (_, i) => {
    const lo = i / bins;
    const hi = (i + 1) / bins;
    const predicted = {} as Record<Group, number | null>;
    const observed = {} as Record<Group, number | null>;
    for (const group of ['North', 'South'] as Group[]) {
      const inBin = rows.filter((a) => {
        const p = predict(a, m);
        return a.group === group && p >= lo && (p < hi || (i === bins - 1 && p <= hi));
      });
      predicted[group] = inBin.length >= 8 ? inBin.reduce((s, a) => s + predict(a, m), 0) / inBin.length : null;
      observed[group] = inBin.length >= 8 ? inBin.filter((a) => a.repaid).length / inBin.length : null;
    }
    return { lo, hi, predicted, observed };
  });
}

/** Pearson correlation, used to show how strongly a harmless-looking feature tracks the branch area. */
export function correlation(xs: number[], ys: number[]): number {
  const n = xs.length;
  const mx = xs.reduce((s, x) => s + x, 0) / n;
  const my = ys.reduce((s, y) => s + y, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  return sxx === 0 || syy === 0 ? 0 : sxy / Math.sqrt(sxx * syy);
}

/** The same model with one feature's weight set to zero, keeping the average log-odds where it was. */
export function withoutFeature(feature: Feature, rows: Applicant[] = POPULATION, m: Model = MODEL): Model {
  const mean = rows.reduce((s, a) => s + a[feature], 0) / rows.length;
  return {
    intercept: m.intercept + m.weights[feature] * (mean - m.centre[feature]),
    weights: { ...m.weights, [feature]: 0 },
    centre: m.centre,
  };
}

export interface ProxyReport {
  /** Correlation between living in South (1) and each feature. */
  correlations: Record<Feature, number>;
  approvalGap: number;
  approvalGapWithout: number;
  aucWith: number;
  aucWithout: number;
}

/** How far the branch area leaks into the model through other features, and what dropping one proxy does. */
export function proxyReport(feature: Feature = 'years', rows: Applicant[] = POPULATION): ProxyReport {
  const south = rows.map((a) => (a.group === 'South' ? 1 : 0));
  const correlations = {} as Record<Feature, number>;
  for (const f of FEATURES)
    correlations[f] = correlation(
      rows.map((a) => a[f]),
      south,
    );
  const reduced = withoutFeature(feature, rows);
  const labels = rows.map((a) => a.repaid);
  const gapOf = (m: Model) => {
    const [n, s] = groupStats(rows, { North: 0.5, South: 0.5 }, m);
    return n.selection - s.selection;
  };
  return {
    correlations,
    approvalGap: gapOf(MODEL),
    approvalGapWithout: gapOf(reduced),
    aucWith: auc(
      rows.map((a) => predict(a)),
      labels,
    ),
    aucWithout: auc(
      rows.map((a) => predict(a, reduced)),
      labels,
    ),
  };
}

/** The applicant the page explains first: declined, with a mixed picture. */
export const SAMPLE: Point = { income: 34, debt: 0.46, years: 2, missed: 1 };
