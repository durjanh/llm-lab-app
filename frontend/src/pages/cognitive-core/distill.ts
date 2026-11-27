/* Knowledge distillation, small enough to run in the browser (Hinton, Vinyals and Dean, 2015).

A teacher, with curved class boundaries, sorts points in a square into three classes. A much smaller student, a
straight-line classifier, learns from only a few labelled points, two ways: from the bare labels (one class per point)
and from the teacher's full probabilities, softened by a temperature. The soft targets carry what the teacher knows
about how close each point is to the other classes ("dark knowledge"), so the student learns more from the same few
points. Everything is seeded, so the same settings always draw the same picture. */

export const CLASSES = 3;
const STUDENT_FEATURES = 3; // x, y and a bias: a straight-line classifier

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

export function softmax(z: number[], temperature = 1): number[] {
  const scaled = z.map((v) => v / temperature);
  const top = Math.max(...scaled);
  const e = scaled.map((v) => Math.exp(v - top));
  const sum = e.reduce((a, b) => a + b, 0);
  return e.map((v) => v / sum);
}

const argmax = (v: number[]) => v.reduce((best, x, i) => (x > v[best] ? i : best), 0);

/** The teacher's raw scores (logits) for a point: curved boundaries, from squares and a cross term. */
export function teacherLogits(x: number, y: number): number[] {
  return [2.4 * x + 1.6 * y * y - 0.6, -2.2 * x + 1.4 * x * y + 0.4, 2.6 * y - 1.2 * x * x + 0.2].map((v) => v * 1.5);
}

export const teacherClass = (x: number, y: number) => argmax(teacherLogits(x, y));

export interface Point {
  x: number;
  y: number;
  label: number;
}

/** `n` points drawn evenly from the square from -1 to 1, labelled by the teacher. */
export function points(n: number, seed: number): Point[] {
  const r = rng(seed);
  return Array.from({ length: n }, () => {
    const x = r() * 2 - 1;
    const y = r() * 2 - 1;
    return { x, y, label: teacherClass(x, y) };
  });
}

export type Weights = number[][]; // [class][feature]

const features = (x: number, y: number) => [x, y, 1];

export function studentProbs(w: Weights, x: number, y: number): number[] {
  const f = features(x, y);
  return softmax(w.map((row) => row.reduce((s, v, i) => s + v * f[i], 0)));
}

export const studentClass = (w: Weights, x: number, y: number) => argmax(studentProbs(w, x, y));

export function accuracy(w: Weights, test: Point[]): number {
  return test.filter((p) => studentClass(w, p.x, p.y) === p.label).length / test.length;
}

export interface TrainOptions {
  train: Point[];
  test: Point[];
  /** 0 for the bare labels; otherwise the temperature of the teacher's soft targets. */
  temperature: number;
  steps: number;
  rate?: number;
}

/** Gradient descent on cross-entropy against the targets. Returns the weights and test accuracy after each step. */
export function train({ train: data, test, temperature, steps, rate = 0.5 }: TrainOptions): {
  weights: Weights;
  history: number[];
} {
  const targets = data.map((p) =>
    temperature > 0
      ? softmax(teacherLogits(p.x, p.y), temperature)
      : Array.from({ length: CLASSES }, (_, c) => (c === p.label ? 1 : 0)),
  );
  const w: Weights = Array.from({ length: CLASSES }, () => new Array(STUDENT_FEATURES).fill(0));
  const history: number[] = [];
  for (let step = 0; step < steps; step++) {
    const grad: Weights = Array.from({ length: CLASSES }, () => new Array(STUDENT_FEATURES).fill(0));
    data.forEach((p, n) => {
      const f = features(p.x, p.y);
      const probs = studentProbs(w, p.x, p.y);
      for (let c = 0; c < CLASSES; c++) {
        const err = probs[c] - targets[n][c];
        for (let i = 0; i < STUDENT_FEATURES; i++) grad[c][i] += (err * f[i]) / data.length;
      }
    });
    for (let c = 0; c < CLASSES; c++) for (let i = 0; i < STUDENT_FEATURES; i++) w[c][i] -= rate * grad[c][i];
    history.push(accuracy(w, test));
  }
  return { weights: w, history };
}

export interface Comparison {
  train: Point[];
  hard: { weights: Weights; history: number[] };
  soft: { weights: Weights; history: number[] };
  test: Point[];
}

/** The same few points, learned from bare labels and from the teacher's soft targets at `temperature`. */
export function compare(samples: number, temperature: number, steps = 300, seed = 7): Comparison {
  const trainSet = points(samples, seed);
  const test = points(400, 1000 + seed);
  return {
    train: trainSet,
    test,
    hard: train({ train: trainSet, test, temperature: 0, steps }),
    soft: train({ train: trainSet, test, temperature, steps }),
  };
}
