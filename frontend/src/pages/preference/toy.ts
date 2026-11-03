/* The toy world for Lab 31: answers described by three features, labellers who like length a little too much,
   a reward model fitted to their choices, and a policy over a fixed set of candidate answers. Everything is
   seeded, so the page shows the same numbers every time. */
import { rng, sigmoid, softmax } from '../deep-learning/kit';

export const FEATURES = ['correctness', 'helpfulness', 'length'] as const;

/** One prompt's candidate answers, each scored 0..1 on the three features. */
export const CANDIDATES: { name: string; x: [number, number, number] }[] = [
  { name: 'Short, correct', x: [0.95, 0.5, 0.15] },
  { name: 'Clear, correct, complete', x: [0.95, 0.85, 0.4] },
  { name: 'Correct but rambling', x: [0.9, 0.7, 0.7] },
  { name: 'Long, padded, mostly right', x: [0.75, 0.75, 1.0] },
  { name: 'Confident but wrong', x: [0.1, 0.6, 0.35] },
  { name: 'Unhelpful refusal', x: [0.5, 0.05, 0.1] },
  { name: 'Very long, mostly wrong', x: [0.3, 0.55, 1.0] },
  { name: 'Partly correct, short', x: [0.6, 0.4, 0.2] },
];

/** The SFT model we start from: already decent, it favours the good answers. Logits over the candidates. */
export const REFERENCE_LOGITS = [1.2, 1.4, 0.3, -0.4, -0.6, -0.3, -1.2, 0.0];
export const REFERENCE = softmax(REFERENCE_LOGITS);

/** What the answer is really worth: correctness and helpfulness, and padding beyond a point costs. Hidden from training. */
export const trueQuality = (x: readonly number[]) => 2.0 * x[0] + 1.2 * x[1] - 3.0 * Math.max(0, x[2] - 0.4);
export const QUALITY = CANDIDATES.map((c) => trueQuality(c.x));

/** The labellers' hidden taste: they value correctness and helpfulness, and (the bias) length. */
export const labellerWeights = (lengthBias: number): [number, number, number] => [2.0, 1.2, lengthBias];
const SHARPNESS = 3; // how consistently labellers pick the answer they like more

const dot = (w: readonly number[], x: readonly number[]) => w.reduce((s, v, i) => s + v * x[i], 0);

export interface FeaturePair {
  a: number[];
  b: number[];
  aWins: boolean;
}

/** 600 random pairs of answers, each judged by a labeller: 450 to train on, 150 held out. */
export function labelPairs(lengthBias: number, seed = 3): FeaturePair[] {
  const r = rng(seed);
  const w = labellerWeights(lengthBias);
  return Array.from({ length: 600 }, () => {
    const a = [r(), r(), r()];
    const b = [r(), r(), r()];
    return { a, b, aWins: r() < sigmoid(SHARPNESS * (dot(w, a) - dot(w, b))) };
  });
}

/** A Bradley–Terry reward model r(x) = w·x, fitted by gradient descent on P(A preferred) = σ(r(A) − r(B)). */
export function fitRewardModel(pairs: FeaturePair[], steps = 400, lr = 0.5) {
  const train = pairs.slice(0, 450);
  const test = pairs.slice(450);
  const w = [0, 0, 0];
  const losses: number[] = [];
  for (let t = 0; t < steps; t++) {
    const grad = [0, 0, 0];
    let loss = 0;
    for (const p of train) {
      const d = p.a.map((v, i) => v - p.b[i]);
      const s = sigmoid(dot(w, d));
      const y = p.aWins ? 1 : 0;
      loss -= y * Math.log(s + 1e-12) + (1 - y) * Math.log(1 - s + 1e-12);
      d.forEach((v, i) => (grad[i] += (y - s) * v));
    }
    losses.push(loss / train.length);
    grad.forEach((g, i) => (w[i] += (lr * g) / train.length));
  }
  const accuracy = test.filter((p) => dot(w, p.a) - dot(w, p.b) > 0 === p.aWins).length / test.length;
  return { w, losses, accuracy };
}

export interface Step {
  proxy: number;
  quality: number;
  kl: number;
}

const kl = (pi: number[], ref: number[]) => pi.reduce((s, p, i) => s + (p > 0 ? p * Math.log(p / ref[i]) : 0), 0);

/**
 * RLHF's objective on the toy policy: maximise E[reward] − β·KL(π ‖ π_ref), by gradient ascent on the policy's
 * logits. The gradient here is the exact expectation; PPO estimates the same thing from sampled answers, with its
 * clipping keeping each step small.
 */
export function rlhf(reward: number[], beta: number, steps = 300) {
  const lr = 2 / (1 + beta); // a stiffer KL term needs smaller steps, or training overshoots and oscillates
  const logits = [...REFERENCE_LOGITS];
  const history: Step[] = [];
  let pi = REFERENCE;
  for (let t = 0; t <= steps; t++) {
    pi = softmax(logits);
    const meanR = dot(pi, reward);
    const k = kl(pi, REFERENCE);
    history.push({ proxy: meanR, quality: dot(pi, QUALITY), kl: k });
    if (t === steps) break;
    pi.forEach((p, i) => (logits[i] += lr * (p * (reward[i] - meanR) - beta * p * (Math.log(p / REFERENCE[i]) - k))));
  }
  return { pi, history };
}

/** 200 labelled pairs of the candidate answers themselves, as DPO trains on: [chosen, rejected]. */
export function candidatePairs(lengthBias: number, seed = 11): [number, number][] {
  const r = rng(seed);
  const w = labellerWeights(lengthBias);
  const u = CANDIDATES.map((c) => dot(w, c.x));
  const pairs: [number, number][] = [];
  while (pairs.length < 200) {
    const i = Math.floor(r() * CANDIDATES.length);
    const j = Math.floor(r() * CANDIDATES.length);
    if (i === j) continue;
    pairs.push(r() < sigmoid(SHARPNESS * (u[i] - u[j])) ? [i, j] : [j, i]);
  }
  return pairs;
}

/**
 * DPO: minimise −log σ(β[(log π(y_w) − log π_ref(y_w)) − (log π(y_l) − log π_ref(y_l))]) over the pairs, directly
 * on the policy: no reward model, no RL. Trained to convergence (the step size scales with 1/β, so β changes where
 * it ends up, not how fast).
 */
export function dpo(pairs: [number, number][], beta: number, steps = 1500) {
  const logits = [...REFERENCE_LOGITS];
  const losses: number[] = [];
  const lr = 2 / beta;
  for (let t = 0; t < steps; t++) {
    const pi = softmax(logits);
    const ratio = pi.map((p, i) => Math.log(p) - Math.log(REFERENCE[i]));
    const grad = new Array(CANDIDATES.length).fill(0);
    let loss = 0;
    for (const [w, l] of pairs) {
      const u = beta * (ratio[w] - ratio[l]);
      const s = sigmoid(u);
      loss += Math.log1p(Math.exp(-u));
      grad[w] += (1 - s) * beta;
      grad[l] -= (1 - s) * beta;
    }
    if (t % 15 === 0) losses.push(loss / pairs.length);
    grad.forEach((g, i) => (logits[i] += (lr * g) / pairs.length));
  }
  const pi = softmax(logits);
  const ratio = pi.map((p, i) => Math.log(p) - Math.log(REFERENCE[i]));
  const wins = CANDIDATES.map((_, i) => {
    const involved = pairs.filter((p) => p[0] === i || p[1] === i);
    return involved.length ? involved.filter((p) => p[0] === i).length / involved.length : 0;
  });
  return { pi, ratio, losses, wins, quality: dot(pi, QUALITY), kl: kl(pi, REFERENCE) };
}

export const expectedQuality = (pi: number[]) => dot(pi, QUALITY);
