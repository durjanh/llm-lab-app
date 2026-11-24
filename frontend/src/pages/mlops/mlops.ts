/* The MLOps page's calculations: drift statistics, a point-in-time join on invented churn data, a rollout simulation,
   the promotion gate and the retraining decision. Pure functions with a seeded random source, so the page and the
   tests see the same numbers. */

/** A small seeded random source (mulberry32), so every simulation is repeatable. */
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

/** A normally distributed draw (Box–Muller). */
export function normal(rand: () => number, mean = 0, sd = 1): number {
  const u = Math.max(rand(), 1e-12);
  const v = rand();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/* ---------- Drift ---------- */

/** Bin edges at the reference sample's deciles (or other quantiles), the usual way PSI is computed. */
export function quantileEdges(reference: number[], bins: number): number[] {
  const sorted = [...reference].sort((a, b) => a - b);
  const edges: number[] = [];
  for (let i = 1; i < bins; i++) edges.push(sorted[Math.floor((i / bins) * sorted.length)]);
  return edges;
}

function shares(sample: number[], edges: number[]): number[] {
  const counts = new Array(edges.length + 1).fill(0);
  for (const x of sample) {
    let i = 0;
    while (i < edges.length && x >= edges[i]) i++;
    counts[i]++;
  }
  return counts.map((c) => c / Math.max(1, sample.length));
}

/**
 * Population stability index: sum over bins of (actual − expected) × ln(actual ÷ expected). Bins come from the
 * reference sample's quantiles; empty bins get a tiny share so the logarithm stays finite.
 */
export function psi(reference: number[], current: number[], bins = 10): number {
  const edges = quantileEdges(reference, bins);
  const e = shares(reference, edges);
  const a = shares(current, edges);
  const eps = 1e-4;
  let total = 0;
  for (let i = 0; i < e.length; i++) {
    const ei = Math.max(e[i], eps);
    const ai = Math.max(a[i], eps);
    total += (ai - ei) * Math.log(ai / ei);
  }
  return total;
}

/** The two-sample Kolmogorov–Smirnov statistic: the largest gap between the two cumulative distributions. */
export function ks(a: number[], b: number[]): number {
  const x = [...a].sort((p, q) => p - q);
  const y = [...b].sort((p, q) => p - q);
  let i = 0;
  let j = 0;
  let d = 0;
  while (i < x.length && j < y.length) {
    const v = Math.min(x[i], y[j]);
    while (i < x.length && x[i] <= v) i++;
    while (j < y.length && y[j] <= v) j++;
    d = Math.max(d, Math.abs(i / x.length - j / y.length));
  }
  return d;
}

export type PsiBand = 'stable' | 'watch' | 'drift';

/** The common rule of thumb: under 0.1 stable, 0.1 to 0.25 worth watching, 0.25 and over a real shift. */
export function psiBand(value: number): PsiBand {
  if (value < 0.1) return 'stable';
  if (value < 0.25) return 'watch';
  return 'drift';
}

/** Monthly spend (£) at training time, and this month with the mean moved and the spread scaled. */
export function spendSamples(
  shift: number,
  spread: number,
  n = 2000,
  seed = 7,
): { reference: number[]; current: number[] } {
  const r1 = rng(seed);
  const r2 = rng(seed + 1);
  const reference = Array.from({ length: n }, () => Math.max(0, normal(r1, 42, 12)));
  const current = Array.from({ length: n }, () => Math.max(0, normal(r2, 42 + shift, 12 * spread)));
  return { reference, current };
}

/** Counts in equal-width bins between lo and hi, for drawing the two histograms. */
export function histogram(sample: number[], lo: number, hi: number, bins: number): number[] {
  const counts = new Array(bins).fill(0);
  const w = (hi - lo) / bins;
  for (const x of sample) {
    const i = Math.min(bins - 1, Math.max(0, Math.floor((x - lo) / w)));
    counts[i]++;
  }
  return counts;
}

export interface RetrainInput {
  psi: number;
  /** How far the live metric has fallen below the one at release, in AUC points; null when labels have not arrived. */
  aucDrop: number | null;
  /** Whether enough new labelled rows exist to train on. */
  freshLabels: boolean;
}

export interface RetrainDecision {
  action: 'leave' | 'investigate' | 'retrain' | 'wait';
  reason: string;
}

/**
 * What to do about a model in production. Drift alone is a reason to look, not to retrain: the inputs can move without
 * the model getting worse, and retraining on a broken feed bakes the fault in. Retraining needs a measured drop and
 * fresh labels.
 */
export function retrainDecision(i: RetrainInput): RetrainDecision {
  const band = psiBand(i.psi);
  if (i.aucDrop !== null && i.aucDrop >= 0.03) {
    if (!i.freshLabels)
      return {
        action: 'wait',
        reason:
          'Performance has fallen, but there are not enough new labelled rows to train on. Collect them first, and consider rolling back to an earlier version.',
      };
    return {
      action: 'retrain',
      reason:
        'Performance has fallen by a measured amount and fresh labels exist. Retrain through the pipeline, then send the new version through the same evaluation and promotion gate.',
    };
  }
  if (band === 'drift')
    return {
      action: 'investigate',
      reason:
        'The input has shifted a lot. First check the data feed (a unit change, a broken join, a new product) before deciding the world changed. Retraining on a broken feed teaches the model the fault.',
    };
  if (band === 'watch')
    return {
      action: 'investigate',
      reason: 'A moderate shift. Watch it, look at which segments moved, and check performance as labels arrive.',
    };
  if (i.aucDrop === null)
    return {
      action: 'leave',
      reason: 'Inputs look stable. Labels have not arrived yet, so keep watching drift as an early signal.',
    };
  return { action: 'leave', reason: 'Inputs are stable and performance holds. Retraining now would only add risk.' };
}

/* ---------- Point-in-time joins ---------- */

export interface PitRow {
  customer: string;
  labelDate: string;
  churned: boolean;
  /** Logins in the 30 days before the label date: what the model would have seen. */
  loginsAsOf: number;
  /** The latest value in the feature table, taken after the outcome was known. */
  loginsLatest: number;
}

export interface PitResult {
  rows: PitRow[];
  /** Offline accuracy when training and testing on the latest values (leaky). */
  leakyOffline: number;
  /** Offline accuracy with features as of each label date. */
  pitOffline: number;
  /** What the leaky model scores in production, where only current values exist (before anyone has churned). */
  leakyInProduction: number;
  leakyThreshold: number;
  pitThreshold: number;
}

/** Best single threshold on logins ("churn if logins < t") for a training set, and its accuracy. */
function bestThreshold(x: number[], y: boolean[]): number {
  let best = 0;
  let bestAcc = -1;
  for (let t = 0; t <= 40; t += 0.5) {
    const acc = accuracy(x, y, t);
    if (acc > bestAcc) {
      bestAcc = acc;
      best = t;
    }
  }
  return best;
}

function accuracy(x: number[], y: boolean[], t: number): number {
  let ok = 0;
  for (let i = 0; i < x.length; i++) if (x[i] < t === y[i]) ok++;
  return ok / Math.max(1, x.length);
}

const DATES = ['2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30'];

/**
 * Invented customers: churners logged in a little less before they left, and not at all afterwards. Joining the
 * latest snapshot hands the model the outcome; joining as of the label date does not.
 */
export function pitDemo(n = 3000, seed = 11): PitResult {
  const r = rng(seed);
  const asOf: number[] = [];
  const latest: number[] = [];
  const churned: boolean[] = [];
  const rows: PitRow[] = [];
  for (let i = 0; i < n; i++) {
    const c = r() < 0.3;
    const before = Math.max(0, Math.round(normal(r, c ? 9 : 14, 5)));
    const after = c ? 0 : Math.max(0, Math.round(normal(r, 14, 5)));
    asOf.push(before);
    latest.push(after);
    churned.push(c);
    if (i < 6)
      rows.push({
        customer: `C-${1040 + i * 7}`,
        labelDate: DATES[i % DATES.length],
        churned: c,
        loginsAsOf: before,
        loginsLatest: after,
      });
  }
  const half = Math.floor(n / 2);
  const leakyThreshold = bestThreshold(latest.slice(0, half), churned.slice(0, half));
  const pitThreshold = bestThreshold(asOf.slice(0, half), churned.slice(0, half));
  return {
    rows,
    leakyOffline: accuracy(latest.slice(half), churned.slice(half), leakyThreshold),
    pitOffline: accuracy(asOf.slice(half), churned.slice(half), pitThreshold),
    leakyInProduction: accuracy(asOf.slice(half), churned.slice(half), leakyThreshold),
    leakyThreshold,
    pitThreshold,
  };
}

/* ---------- Rollouts ---------- */

export type Strategy = 'shadow' | 'canary' | 'blue-green' | 'ab';

export interface RolloutInput {
  strategy: Strategy;
  /** Share of live traffic the new model starts with (canary, A/B), 0 to 100. */
  startShare: number;
  /** Error rates as fractions, e.g. 0.01 for 1%. */
  oldErrorRate: number;
  newErrorRate: number;
  oldLatencyMs: number;
  newLatencyMs: number;
  /** Roll back when the new model's error rate, over at least 100 requests, goes above this fraction. */
  rollbackAt: number;
  minutes?: number;
  requestsPerMinute?: number;
  seed?: number;
}

export interface RolloutMinute {
  minute: number;
  /** Share of users answered by the new model this minute, 0 to 1. */
  newShare: number;
  /** The new model's error rate so far (all its requests, shadow ones included). */
  newErrorRate: number;
}

export interface RolloutResult {
  series: RolloutMinute[];
  /** The minute the new model was taken out of service, or null if it never was. */
  rolledBackAt: number | null;
  userRequests: number;
  /** Errors users saw, from either model. */
  userErrors: number;
  /** Errors users saw that the new model caused. */
  newModelUserErrors: number;
  /** Requests the new model served, users' and shadow copies. */
  newModelRequests: number;
  meanLatencyMs: number;
  /** Extra model calls paid for, as a share of user requests (shadow traffic is paid for but never shown). */
  extraCalls: number;
}

/** Errors among k requests at rate p, drawn from a normal approximation and clamped. */
function errors(r: () => number, k: number, p: number): number {
  if (k <= 0) return 0;
  const e = Math.round(normal(r, k * p, Math.sqrt(Math.max(k * p * (1 - p), 1e-9))));
  return Math.min(k, Math.max(0, e));
}

/**
 * Release a new model version one of four ways and watch its error rate. A canary doubles its share every five
 * healthy minutes; blue-green switches everything at once; A/B holds a fixed split; shadow copies every request to
 * the new model and throws its answers away. All but shadow roll back when the new model's error rate crosses the
 * threshold.
 */
export function simulateRollout(i: RolloutInput): RolloutResult {
  const minutes = i.minutes ?? 30;
  const rpm = i.requestsPerMinute ?? 600;
  const r = rng(i.seed ?? 3);
  const start = Math.min(100, Math.max(0, i.startShare)) / 100;
  let share = i.strategy === 'shadow' ? 0 : i.strategy === 'blue-green' ? 1 : start;
  let rolledBackAt: number | null = null;
  let newReq = 0;
  let newErr = 0;
  let userErrors = 0;
  let newModelUserErrors = 0;
  let latencySum = 0;
  let extra = 0;
  const series: RolloutMinute[] = [];
  for (let m = 0; m < minutes; m++) {
    const toNew = Math.round(rpm * share);
    const toOld = rpm - toNew;
    const eNew = errors(r, toNew, i.newErrorRate);
    const eOld = errors(r, toOld, i.oldErrorRate);
    userErrors += eNew + eOld;
    newModelUserErrors += eNew;
    latencySum += toNew * i.newLatencyMs + toOld * i.oldLatencyMs;
    newReq += toNew;
    newErr += eNew;
    if (i.strategy === 'shadow' && rolledBackAt === null) {
      // Every request is copied to the new model; users never see its answers.
      newReq += rpm;
      newErr += errors(r, rpm, i.newErrorRate);
      extra += rpm;
    }
    const rate = newReq > 0 ? newErr / newReq : 0;
    series.push({ minute: m + 1, newShare: share, newErrorRate: rate });
    if (rolledBackAt === null && i.strategy !== 'shadow' && newReq >= 100 && rate > i.rollbackAt) {
      rolledBackAt = m + 1;
      share = 0;
      continue;
    }
    if (rolledBackAt === null && i.strategy === 'canary' && (m + 1) % 5 === 0)
      share = Math.min(1, Math.max(share * 2, 0.01));
  }
  const userRequests = minutes * rpm;
  return {
    series,
    rolledBackAt,
    userRequests,
    userErrors,
    newModelUserErrors,
    newModelRequests: newReq,
    meanLatencyMs: latencySum / userRequests,
    extraCalls: extra / userRequests,
  };
}

/* ---------- Experiment runs and the promotion gate ---------- */

export interface Run {
  id: string;
  algorithm: string;
  params: string;
  train: number;
  validation: number;
  test: number;
  dataVersion: string;
  commit: string;
}

/** The data version production trains on now. */
export const CURRENT_DATA = 'churn-v7';

/** Invented runs of a churn model, as a tracking server lists them. AUC on each split. */
export const RUNS: Run[] = [
  {
    id: 'run-a41',
    algorithm: 'Logistic regression',
    params: 'C=1.0',
    train: 0.781,
    validation: 0.774,
    test: 0.771,
    dataVersion: 'churn-v7',
    commit: '3f9c2e1',
  },
  {
    id: 'run-b07',
    algorithm: 'Random forest',
    params: 'trees=300, depth=6',
    train: 0.874,
    validation: 0.812,
    test: 0.806,
    dataVersion: 'churn-v7',
    commit: '3f9c2e1',
  },
  {
    id: 'run-c52',
    algorithm: 'Gradient boosting',
    params: 'trees=400, lr=0.05, depth=3',
    train: 0.861,
    validation: 0.823,
    test: 0.809,
    dataVersion: 'churn-v7',
    commit: 'a17d4b8',
  },
  {
    id: 'run-d19',
    algorithm: 'Gradient boosting',
    params: 'trees=1200, lr=0.1, depth=8',
    train: 0.991,
    validation: 0.809,
    test: 0.818,
    dataVersion: 'churn-v7',
    commit: 'a17d4b8',
  },
  {
    id: 'run-e88',
    algorithm: 'Gradient boosting',
    params: 'trees=400, lr=0.05, depth=3',
    train: 0.866,
    validation: 0.841,
    test: 0.835,
    dataVersion: 'churn-v6',
    commit: '8e02f6c',
  },
];

export interface Warning {
  level: 'ok' | 'warn' | 'bad';
  text: string;
}

/** What a reviewer would say about promoting this run. */
export function promotionWarnings(run: Run, runs: Run[] = RUNS): Warning[] {
  const out: Warning[] = [];
  const current = runs.filter((r) => r.dataVersion === CURRENT_DATA);
  // With no run on the current data there is nothing to compare against, so only the per-run checks apply.
  const bestVal = current.length ? current.reduce((a, b) => (b.validation > a.validation ? b : a)) : null;
  const bestTest = current.length ? current.reduce((a, b) => (b.test > a.test ? b : a)) : null;
  if (run.dataVersion !== CURRENT_DATA)
    out.push({
      level: 'bad',
      text: `Trained on ${run.dataVersion}, not ${CURRENT_DATA}. Its scores are on different data, so they cannot be compared with the other runs. Retrain it on ${CURRENT_DATA} first.`,
    });
  if (bestTest && bestVal && run.id === bestTest.id && run.id !== bestVal.id)
    out.push({
      level: 'bad',
      text: 'This run has the best test score but not the best validation score. Choosing by test score turns the test set into a second validation set, and the reported number is no longer an honest estimate.',
    });
  if (run.train - run.validation > 0.08)
    out.push({
      level: 'warn',
      text: `Train AUC ${run.train.toFixed(3)} against validation ${run.validation.toFixed(3)}: a gap this size means it is memorising the training data.`,
    });
  if (bestVal && bestTest && run.dataVersion === CURRENT_DATA) {
    if (run.id === bestVal.id)
      out.push({
        level: 'ok',
        text: 'Best validation score on the current data. The test score is read once, after choosing, as the estimate to report.',
      });
    else if (run.id !== bestTest.id)
      out.push({
        level: 'warn',
        text: `Another run on ${CURRENT_DATA} has a better validation score (${bestVal.id}).`,
      });
  }
  return out;
}

export interface GateInput {
  auc: number;
  minAuc: number;
  /** The largest gap in recall between customer segments, as a fraction. */
  sliceGap: number;
  maxSliceGap: number;
  p95LatencyMs: number;
  maxLatencyMs: number;
  /** AUC of the current champion; the challenger must not be worse. */
  championAuc: number;
  signedOff: boolean;
}

export interface GateCheck {
  name: string;
  pass: boolean;
  detail: string;
}

/** The checks a version must pass before the champion alias moves to it. */
export function promotionGate(g: GateInput): GateCheck[] {
  return [
    { name: 'Quality', pass: g.auc >= g.minAuc, detail: `AUC ${g.auc.toFixed(3)}, needs ${g.minAuc.toFixed(3)}` },
    {
      name: 'Beats the champion',
      pass: g.auc >= g.championAuc,
      detail: `${g.auc.toFixed(3)} against the champion's ${g.championAuc.toFixed(3)}`,
    },
    {
      name: 'Fair across segments',
      pass: g.sliceGap <= g.maxSliceGap,
      detail: `largest recall gap ${(g.sliceGap * 100).toFixed(0)} points, allowed ${(g.maxSliceGap * 100).toFixed(0)}`,
    },
    {
      name: 'Fast enough',
      pass: g.p95LatencyMs <= g.maxLatencyMs,
      detail: `p95 ${g.p95LatencyMs} ms, allowed ${g.maxLatencyMs} ms`,
    },
    {
      name: 'Signed off',
      pass: g.signedOff,
      detail: g.signedOff ? 'model owner approved' : 'waiting for the model owner',
    },
  ];
}
