/* An invented screening cohort, and the numbers a team needs before trusting an image-based risk model.

Every woman here is made up, from a seeded generator, so the same settings always give the same cohort. Each has an
age, a breast density category (A, fatty, to D, extremely dense), a family history or not, and a hidden "image signal":
what a deep model can see in a normal-looking mammogram beyond density. Her chance of a cancer appearing in each of the
next five years rises with all four. Two models then score her:

- a questionnaire model, from age, density and family history (the kind of model screening programmes use today);
- an image model, which adds a noisy reading of the image signal, and also sees any cancer that is already on the image
  but was missed by the readers. Those cancers are found within a year; a model that spots them looks as if it
  predicts the future, when it detects the present. That is the trap a "years in advance" headline can hide.

The rates are illustrative, chosen to sit near published figures (about 1.5% of women developing breast cancer within
five years of a normal screen; questionnaire models near 0.62 AUC, image models near 0.7 to 0.78), not fitted to any
real study. */

export const YEARS = 5;
export const DENSITY = ['A', 'B', 'C', 'D'] as const;
const DENSITY_SHARE = [0.1, 0.4, 0.4, 0.1];
const DENSITY_EFFECT = [-0.6, -0.2, 0.2, 0.6]; // log hazard ratio by category
const FAMILY_SHARE = 0.15;
const FAMILY_EFFECT = 0.6;
const AGE_EFFECT = 0.03; // per year from 55
const IMAGE_EFFECT = 0.75; // per standard deviation of the hidden image signal
const BASE_HAZARD = 0.0018; // a year, at the average of everything else
const MISSED_BOOST = 3; // how strongly an already-present cancer shows to the image model

/** A small seeded random number generator (mulberry32), so every run is the same. */
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

/** A standard normal draw (Box-Muller). */
function normal(r: () => number): number {
  const u = Math.max(r(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}

function pick(r: () => number, shares: number[]): number {
  let x = r();
  for (let i = 0; i < shares.length; i++) {
    if (x < shares[i]) return i;
    x -= shares[i];
  }
  return shares.length - 1;
}

export interface Woman {
  age: number;
  density: number; // index into DENSITY
  family: boolean;
  /** The year (1 to 5) a cancer was diagnosed, or 0 for none within five years. */
  year: number;
  /** A cancer already on today's image, missed by the readers, found within a year. */
  missed: boolean;
  questionnaire: number; // the questionnaire model's score (a log hazard)
  image: number; // the image model's score (a log hazard)
}

export interface CohortOptions {
  size?: number;
  seed?: number;
  /** Of the cancers found in the first year, the share already on today's image (0 to 1). */
  missedShare?: number;
  /** Another hospital: incidence this many times higher, and a scanner that reads the image signal less well. */
  site?: { incidence: number; scannerNoise: number };
}

/** The invented cohort, with both models' scores for every woman. */
export function cohort({ size = 20000, seed = 11, missedShare = 0.3, site }: CohortOptions = {}): Woman[] {
  const r = rng(seed);
  const noise = 0.6 + (site?.scannerNoise ?? 0);
  const incidence = site?.incidence ?? 1;
  return Array.from({ length: size }, () => {
    const age = 40 + Math.floor(r() * 35);
    const density = pick(r, DENSITY_SHARE);
    const family = r() < FAMILY_SHARE;
    const signal = normal(r);
    const known = AGE_EFFECT * (age - 55) + DENSITY_EFFECT[density] + (family ? FAMILY_EFFECT : 0);
    const hazard = BASE_HAZARD * incidence * Math.exp(known + IMAGE_EFFECT * signal);
    let year = 0;
    for (let y = 1; y <= YEARS && !year; y++) if (r() < 1 - Math.exp(-hazard)) year = y;
    const missed = year === 1 && r() < missedShare;
    // The questionnaire model knows the known risks, slightly mis-weighted, as real ones are.
    const questionnaire = 0.8 * known;
    const image = known + IMAGE_EFFECT * (signal + noise * normal(r)) + (missed ? MISSED_BOOST : 0);
    return { age, density, family, year, missed, questionnaire, image };
  });
}

/** The area under the ROC curve: the chance a woman who got cancer scored higher than one who did not (ties half). */
export function auc(scores: number[], positive: boolean[]): number {
  const order = scores.map((s, i) => [s, i] as const).sort((a, b) => a[0] - b[0]);
  const ranks = new Array<number>(scores.length);
  for (let i = 0; i < order.length;) {
    let j = i;
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
    for (let k = i; k <= j; k++) ranks[order[k][1]] = (i + j) / 2 + 1; // ties share their average rank
    i = j + 1;
  }
  let pos = 0;
  let rankSum = 0;
  positive.forEach((p, i) => {
    if (p) {
      pos++;
      rankSum += ranks[i];
    }
  });
  const neg = scores.length - pos;
  if (!pos || !neg) return NaN;
  return (rankSum - (pos * (pos + 1)) / 2) / (pos * neg);
}

export type Model = 'questionnaire' | 'image';

/** AUC for cancers diagnosed within `years`, against women with none in all five years (time-dependent AUC). */
export function aucWithin(women: Woman[], model: Model, years: number): number {
  const kept = women.filter((w) => w.year === 0 || w.year <= years);
  return auc(
    kept.map((w) => w[model]),
    kept.map((w) => w.year > 0),
  );
}

/** Turns scores into five-year risks, scaled so the average predicted risk matches what was observed in `fitOn`. */
export function calibrate(fitOn: Woman[], model: Model): (score: number) => number {
  const observed = fitOn.filter((w) => w.year > 0).length / fitOn.length;
  let lo = 1e-8;
  let hi = 1;
  for (let i = 0; i < 60; i++) {
    const mid = Math.sqrt(lo * hi);
    const mean = fitOn.reduce((s, w) => s + (1 - Math.exp(-mid * Math.exp(w[model]))), 0) / fitOn.length;
    if (mean < observed) lo = mid;
    else hi = mid;
  }
  const base = Math.sqrt(lo * hi);
  return (score) => 1 - Math.exp(-base * Math.exp(score));
}

export interface Bin {
  predicted: number;
  observed: number;
  women: number;
}

/** Predicted against observed five-year risk, in tenths of the cohort by predicted risk. */
export function calibrationBins(women: Woman[], model: Model, risk: (score: number) => number, bins = 10): Bin[] {
  const sorted = [...women].sort((a, b) => risk(a[model]) - risk(b[model]));
  return Array.from({ length: bins }, (_, b) => {
    const slice = sorted.slice(Math.floor((b * sorted.length) / bins), Math.floor(((b + 1) * sorted.length) / bins));
    return {
      predicted: slice.reduce((s, w) => s + risk(w[model]), 0) / slice.length,
      observed: slice.filter((w) => w.year > 0).length / slice.length,
      women: slice.length,
    };
  });
}

export interface Policy {
  offered: number; // women offered extra screening
  cancersInGroup: number; // of the five-year cancers, how many were in that group
  cancers: number;
  share: number; // the share of all five-year cancers in the group
  perThousand: number; // cancers in the group per 1,000 women offered
  screenedPerCancer: number; // women offered extra screening for each cancer among them
}

/** Offer extra screening (MRI, say) to the `topShare` of women with the highest score. */
export function policy(women: Woman[], model: Model, topShare: number): Policy {
  const offered = Math.round(women.length * topShare);
  const ranked = [...women].sort((a, b) => b[model] - a[model]).slice(0, offered);
  const cancers = women.filter((w) => w.year > 0).length;
  const inGroup = ranked.filter((w) => w.year > 0).length;
  return {
    offered,
    cancersInGroup: inGroup,
    cancers,
    share: cancers ? inGroup / cancers : 0,
    perThousand: offered ? (1000 * inGroup) / offered : 0,
    screenedPerCancer: inGroup ? offered / inGroup : Infinity,
  };
}

/** Five-year AUC for each density category: does the model work as well for every group? */
export function aucByDensity(women: Woman[], model: Model): { density: string; auc: number; women: number }[] {
  return DENSITY.map((d, i) => {
    const group = women.filter((w) => w.density === i);
    return { density: d, auc: aucWithin(group, model, YEARS), women: group.length };
  });
}
