/*
  The probability and statistics behind the course's weeks 3, 4, 5, 10 and 12: Bayes' rule, distributions, Monte
  Carlo, summaries and outliers, likelihood, regression, the bootstrap, missing data, entropy and naive Bayes. Pure
  functions with a seeded random source, so the page repeats and the tests check what it shows. All data is invented.
*/

/** A small seeded random source (mulberry32). */
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

/** A standard normal draw by the Box-Muller method. */
export function normal(r: () => number): number {
  const u = Math.max(r(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}

export const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
export function sd(xs: number[], sample = true): number {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - (sample ? 1 : 0)));
}

/** The q-quantile by linear interpolation between sorted values (the usual spreadsheet method). */
export function quantile(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (pos - lo);
}
export const median = (xs: number[]) => quantile(xs, 0.5);

/* ---------- Week 4: Bayes' rule on a screening test ---------- */

export interface Screening {
  /** Out of the population: true positives, false negatives, false positives, true negatives. */
  tp: number;
  fn: number;
  fp: number;
  tn: number;
  /** P(condition | positive test), exactly. */
  ppv: number;
  /** P(no condition | negative test), exactly. */
  npv: number;
}

export function screening(prevalence: number, sensitivity: number, specificity: number, population = 1000): Screening {
  const sick = prevalence * population;
  const well = population - sick;
  const tp = sick * sensitivity;
  const fp = well * (1 - specificity);
  const tn = well * specificity;
  const fn = sick - tp;
  return {
    tp,
    fn,
    fp,
    tn,
    ppv: tp + fp > 0 ? tp / (tp + fp) : 0,
    npv: tn + fn > 0 ? tn / (tn + fn) : 0,
  };
}

/* ---------- Week 4: distributions ---------- */

export function binomialPmf(n: number, p: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let c = 1;
  for (let i = 1; i <= k; i++) c = (c * (n - k + i)) / i;
  return c * p ** k * (1 - p) ** (n - k);
}

export function poissonPmf(lambda: number, k: number): number {
  let p = Math.exp(-lambda);
  for (let i = 1; i <= k; i++) p *= lambda / i;
  return p;
}

export const normalPdf = (x: number, mu: number, sigma: number) =>
  Math.exp(-0.5 * ((x - mu) / sigma) ** 2) / (sigma * Math.sqrt(2 * Math.PI));

/* ---------- Week 4: Monte Carlo ---------- */

/** Throws n darts at a unit square; the share inside the quarter circle, times 4, estimates π. */
export function monteCarloPi(n: number, seed = 5): { estimate: number; points: [number, number, boolean][] } {
  const r = rng(seed);
  let inside = 0;
  const points: [number, number, boolean][] = [];
  for (let i = 0; i < n; i++) {
    const x = r(),
      y = r();
    const hit = x * x + y * y <= 1;
    if (hit) inside++;
    if (i < 3000) points.push([x, y, hit]);
  }
  return { estimate: (4 * inside) / n, points };
}

/** The exact chance that three fair dice total more than 12: 56 of the 216 outcomes. */
export const THREE_DICE_OVER_12 = 56 / 216;

export function threeDiceOver12(n: number, seed = 9): number {
  const r = rng(seed);
  let hits = 0;
  for (let i = 0; i < n; i++) {
    const total = 3 + Math.floor(r() * 6) + Math.floor(r() * 6) + Math.floor(r() * 6);
    if (total > 12) hits++;
  }
  return hits / n;
}

/** The average absolute error of the π estimate over several seeds, for each sample size. It falls like 1/√n. */
export function piErrorCurve(sizes: number[], seeds = 20): { n: number; error: number }[] {
  return sizes.map((n) => {
    let total = 0;
    for (let s = 1; s <= seeds; s++) total += Math.abs(monteCarloPi(n, 100 + s).estimate - Math.PI);
    return { n, error: total / seeds };
  });
}

/* ---------- Week 5: summaries and outliers ---------- */

/** Invented: minutes a delivery van spent at each of 15 stops on one round. */
export const STOP_MINUTES = [4, 6, 5, 7, 5, 8, 6, 4, 9, 5, 6, 7, 5, 6, 8];

export interface Summary {
  mean: number;
  median: number;
  sd: number;
  q1: number;
  q3: number;
  iqr: number;
  /** Values outside [q1 − 1.5·IQR, q3 + 1.5·IQR]. */
  iqrOutliers: number[];
  /** Values more than `zLimit` standard deviations from the mean. */
  zOutliers: number[];
}

export function summarise(xs: number[], zLimit = 2.5): Summary {
  const m = mean(xs);
  const s = sd(xs);
  const q1 = quantile(xs, 0.25);
  const q3 = quantile(xs, 0.75);
  const iqr = q3 - q1;
  return {
    mean: m,
    median: median(xs),
    sd: s,
    q1,
    q3,
    iqr,
    iqrOutliers: xs.filter((x) => x < q1 - 1.5 * iqr || x > q3 + 1.5 * iqr),
    zOutliers: s > 0 ? xs.filter((x) => Math.abs(x - m) / s > zLimit) : [],
  };
}

/* ---------- Week 5: likelihood ---------- */

/** Log-likelihood of independent coin flips with `heads` out of `n` under heads-probability p. */
export function coinLogLik(heads: number, n: number, p: number): number {
  if (p <= 0 || p >= 1) return -Infinity;
  return heads * Math.log(p) + (n - heads) * Math.log(1 - p);
}

export function normalLogLik(xs: number[], mu: number, sigma: number): number {
  return xs.reduce((s, x) => s + Math.log(normalPdf(x, mu, sigma)), 0);
}

/** Invented: the weights in grams of 12 loaves from one bakery batch. */
export const LOAF_GRAMS = [802, 795, 811, 798, 806, 790, 815, 801, 799, 808, 793, 804];

/** The maximum-likelihood normal: the mean, and the standard deviation dividing by n rather than n − 1. */
export const normalMle = (xs: number[]) => ({ mu: mean(xs), sigma: sd(xs, false) });

/* ---------- Week 5: regression ---------- */

export interface Fit {
  slope: number;
  intercept: number;
  residuals: number[];
  r2: number;
  /** The maximum-likelihood noise level, √(SSE / n). */
  sigma: number;
}

/** Least squares, which is also the maximum-likelihood line when the noise is normal. */
export function linearFit(xs: number[], ys: number[]): Fit {
  const mx = mean(xs),
    my = mean(ys);
  let sxy = 0,
    sxx = 0;
  xs.forEach((x, i) => {
    sxy += (x - mx) * (ys[i] - my);
    sxx += (x - mx) ** 2;
  });
  const slope = sxx === 0 ? 0 : sxy / sxx;
  const intercept = my - slope * mx;
  const residuals = ys.map((y, i) => y - (intercept + slope * xs[i]));
  const sse = residuals.reduce((s, e) => s + e * e, 0);
  const sst = ys.reduce((s, y) => s + (y - my) ** 2, 0);
  return { slope, intercept, residuals, r2: sst === 0 ? 0 : 1 - sse / sst, sigma: Math.sqrt(sse / xs.length) };
}

/** Invented: outdoor temperature (°C) and hot drinks sold at a kiosk on 14 mornings. */
export const KIOSK = {
  temp: [2, 4, 5, 7, 8, 9, 11, 12, 13, 15, 16, 18, 19, 21],
  drinks: [118, 112, 109, 101, 104, 96, 90, 92, 84, 80, 77, 69, 70, 62],
};

/** Squared error of a hand-placed line, so the page can show the least-squares line has the smallest. */
export const sse = (xs: number[], ys: number[], slope: number, intercept: number) =>
  xs.reduce((s, x, i) => s + (ys[i] - (intercept + slope * x)) ** 2, 0);

/* ---------- Week 5: the bootstrap ---------- */

/** Invented: days taken to settle 17 insurance claims, skewed by a few slow ones. */
export const CLAIM_DAYS = [6, 9, 4, 12, 7, 31, 8, 5, 10, 6, 44, 9, 7, 11, 8, 26, 6];

/** Resamples with replacement B times; returns each resample's median and the 95% percentile interval. */
export function bootstrapMedian(
  xs: number[],
  b: number,
  seed = 21,
): { medians: number[]; lo: number; hi: number; observed: number } {
  const r = rng(seed);
  const medians: number[] = [];
  for (let i = 0; i < b; i++) {
    const sample = xs.map(() => xs[Math.floor(r() * xs.length)]);
    medians.push(median(sample));
  }
  return { medians, lo: quantile(medians, 0.025), hi: quantile(medians, 0.975), observed: median(xs) };
}

/* ---------- Week 3: missing data ---------- */

export type Mechanism = 'MCAR' | 'MAR' | 'MNAR';

export interface Person {
  age: number;
  /** Income in thousands of pounds a year. */
  income: number;
  missing: boolean;
}

/**
 * Invented survey: 400 people, income rising with age. A third of incomes go missing, and the mechanism decides
 * which: at random (MCAR), more often for younger people (MAR, explained by age, which we see), or more often for
 * higher earners (MNAR, explained by the missing value itself).
 */
export function survey(mech: Mechanism, seed = 13, n = 400): Person[] {
  const r = rng(seed);
  const people: Person[] = [];
  for (let i = 0; i < n; i++) {
    const age = 22 + Math.floor(r() * 44);
    const income = 18 + 0.9 * (age - 22) + normal(r) * 7;
    const p =
      mech === 'MCAR'
        ? 0.33
        : mech === 'MAR'
          ? age < 35
            ? 0.6
            : 0.15
          : Math.min(0.9, Math.max(0.05, (income - 25) / 30));
    people.push({ age, income, missing: r() < p });
  }
  return people;
}

export interface Imputation {
  method: string;
  mean: number;
  sd: number;
  /** Estimated mean minus the true mean. */
  bias: number;
}

/** Compares complete-case analysis, mean imputation and regression imputation on age against the truth. */
export function compareImputation(people: Person[]): { trueMean: number; trueSd: number; rows: Imputation[] } {
  const all = people.map((p) => p.income);
  const trueMean = mean(all);
  const seen = people.filter((p) => !p.missing);
  const seenIncome = seen.map((p) => p.income);
  const cc = mean(seenIncome);
  const meanFilled = people.map((p) => (p.missing ? cc : p.income));
  const fit = linearFit(
    seen.map((p) => p.age),
    seenIncome,
  );
  const regFilled = people.map((p) => (p.missing ? fit.intercept + fit.slope * p.age : p.income));
  const row = (method: string, xs: number[]): Imputation => ({
    method,
    mean: mean(xs),
    sd: sd(xs),
    bias: mean(xs) - trueMean,
  });
  return {
    trueMean,
    trueSd: sd(all),
    rows: [
      row('Drop the missing rows', seenIncome),
      row('Fill with the mean', meanFilled),
      row('Predict from age', regFilled),
    ],
  };
}

/* ---------- Week 10: entropy, Gini and information gain ---------- */

/** Entropy in bits of a class mix: 0 when pure, 1 for a 50/50 split of two classes. */
export function entropy(counts: number[]): number {
  const n = counts.reduce((s, c) => s + c, 0);
  if (n === 0) return 0;
  // Subtracting from 0 rather than negating keeps a pure node at 0, not -0.
  return 0 - counts.reduce((s, c) => (c === 0 ? s : s + (c / n) * Math.log2(c / n)), 0);
}

/** Gini impurity: the chance two members drawn at random (with replacement) are in different classes. */
export function gini(counts: number[]): number {
  const n = counts.reduce((s, c) => s + c, 0);
  if (n === 0) return 0;
  return 1 - counts.reduce((s, c) => s + (c / n) ** 2, 0);
}

export interface Member {
  visits: 'rarely' | 'weekly';
  plan: 'monthly' | 'annual';
  classes: 'yes' | 'no';
  renewed: boolean;
}

/** Invented: 16 members of a climbing wall and whether they renewed. */
export const MEMBERS: Member[] = [
  { visits: 'weekly', plan: 'annual', classes: 'yes', renewed: true },
  { visits: 'weekly', plan: 'monthly', classes: 'no', renewed: true },
  { visits: 'weekly', plan: 'annual', classes: 'no', renewed: true },
  { visits: 'weekly', plan: 'monthly', classes: 'yes', renewed: true },
  { visits: 'weekly', plan: 'annual', classes: 'yes', renewed: true },
  { visits: 'weekly', plan: 'monthly', classes: 'no', renewed: false },
  { visits: 'weekly', plan: 'annual', classes: 'no', renewed: true },
  { visits: 'weekly', plan: 'monthly', classes: 'yes', renewed: true },
  { visits: 'rarely', plan: 'annual', classes: 'yes', renewed: true },
  { visits: 'rarely', plan: 'monthly', classes: 'no', renewed: false },
  { visits: 'rarely', plan: 'annual', classes: 'no', renewed: false },
  { visits: 'rarely', plan: 'monthly', classes: 'yes', renewed: false },
  { visits: 'rarely', plan: 'annual', classes: 'no', renewed: false },
  { visits: 'rarely', plan: 'monthly', classes: 'no', renewed: false },
  { visits: 'rarely', plan: 'annual', classes: 'yes', renewed: true },
  { visits: 'rarely', plan: 'monthly', classes: 'no', renewed: false },
];

export type Feature = 'visits' | 'plan' | 'classes';

export interface SplitScore {
  feature: Feature;
  /** [renewed, left] counts on each branch, by branch value. */
  branches: { value: string; counts: [number, number] }[];
  infoGain: number;
  giniDrop: number;
}

const mix = (ms: Member[]): [number, number] => [
  ms.filter((m) => m.renewed).length,
  ms.filter((m) => !m.renewed).length,
];

/** Scores splitting the members on one feature: how much it lowers entropy (information gain) and Gini impurity. */
export function scoreSplit(members: Member[], feature: Feature): SplitScore {
  const parent = mix(members);
  const values = [...new Set(members.map((m) => m[feature]))];
  const branches = values.map((value) => ({ value, counts: mix(members.filter((m) => m[feature] === value)) }));
  const n = members.length;
  const weighted = (f: (c: number[]) => number) =>
    branches.reduce((s, b) => s + ((b.counts[0] + b.counts[1]) / n) * f(b.counts), 0);
  return {
    feature,
    branches,
    infoGain: entropy(parent) - weighted(entropy),
    giniDrop: gini(parent) - weighted(gini),
  };
}

/* ---------- Week 12: naive Bayes ---------- */

/** Invented training messages, each as the set of words from the vocabulary it contains. */
export const VOCAB = ['winner', 'free', 'click', 'meeting', 'invoice', 'lunch'] as const;
export type Word = (typeof VOCAB)[number];

export const MESSAGES: { words: Word[]; spam: boolean }[] = [
  { words: ['winner', 'free', 'click'], spam: true },
  { words: ['free', 'click'], spam: true },
  { words: ['winner', 'click'], spam: true },
  { words: ['free', 'invoice', 'click'], spam: true },
  { words: ['winner', 'free'], spam: true },
  { words: ['meeting', 'lunch'], spam: false },
  { words: ['invoice', 'meeting'], spam: false },
  { words: ['lunch', 'free'], spam: false },
  { words: ['meeting'], spam: false },
  { words: ['invoice'], spam: false },
  { words: ['lunch', 'meeting', 'invoice'], spam: false },
  { words: ['meeting', 'click'], spam: false },
];

export interface NaiveBayesResult {
  prior: number;
  /** For each vocabulary word: P(word | spam) and P(word | not spam), with add-one smoothing. */
  likelihood: Record<Word, [number, number]>;
  /** P(spam | the words present), using only the words present. */
  posterior: number;
}

/**
 * Bayes' rule with one simplifying assumption: given the class, each word appears independently of the others. Each
 * present word multiplies the odds by P(word | spam) ÷ P(word | not spam). Add-one smoothing stops an unseen word
 * from setting a probability to zero.
 */
export function naiveBayes(present: Word[]): NaiveBayesResult {
  const spam = MESSAGES.filter((m) => m.spam);
  const ham = MESSAGES.filter((m) => !m.spam);
  const prior = spam.length / MESSAGES.length;
  const likelihood = Object.fromEntries(
    VOCAB.map((w) => [
      w,
      [
        (spam.filter((m) => m.words.includes(w)).length + 1) / (spam.length + 2),
        (ham.filter((m) => m.words.includes(w)).length + 1) / (ham.length + 2),
      ],
    ]),
  ) as Record<Word, [number, number]>;
  let logOdds = Math.log(prior / (1 - prior));
  for (const w of present) logOdds += Math.log(likelihood[w][0] / likelihood[w][1]);
  return { prior, likelihood, posterior: 1 / (1 + Math.exp(-logOdds)) };
}
