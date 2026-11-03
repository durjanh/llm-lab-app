/* A toy policy trained with GRPO or plain REINFORCE. Not a language model: each "problem type" has a few solution
   strategies, one of which is right, and the policy is a softmax over trainable logits per type. The mechanics are
   the real ones: sample a group, score each answer with a verifiable reward, normalise within the group, and push
   up the probability of the above-average answers. */
import { rng, softmax } from '../deep-learning/kit';

export interface Task {
  name: string;
  strategies: string[];
  correct: number[]; // which strategies give a right answer
  init: number[]; // starting logits: the right strategy starts out unlikely
}

export const TASKS: Task[] = [
  { name: 'Two-digit addition', strategies: ['add columns with carries', 'add without carrying', 'round and estimate', 'add left to right'], correct: [0], init: [0, 1.0, 0.8, 0.5] },
  { name: 'Word problem', strategies: ['set up the equation, then solve', 'add every number in the text', 'copy the last number', 'guess a round number'], correct: [0], init: [0, 0.6, 1.2, 0.9] },
  { name: 'Percentage change', strategies: ['(new − old) ÷ old', '(new − old) ÷ new', 'new − old', 'new ÷ old'], correct: [0], init: [0, 1.4, 0.4, 0.7] },
  { name: 'Units conversion', strategies: ['convert, then calculate', 'calculate, ignore units', 'multiply by 100', 'divide by 1,000'], correct: [0], init: [0, 0.9, 1.0, 1.1] },
];

export type Algo = 'grpo' | 'reinforce';

export interface Settings {
  group: number; // G: answers sampled per problem
  lr: number;
  beta: number; // KL penalty towards the starting policy
  batch: number; // problems per step
}

export interface Sample {
  task: number;
  picks: number[];
  rewards: number[];
  advantages: number[];
}

/** One training run. step() advances one update; accuracy() is exact, from the policy's probabilities. */
export class Trainer {
  logits: number[][];
  readonly ref: number[][];
  private rand: () => number;
  history: number[] = [];
  zeroSignal: number[] = []; // fraction of groups whose advantages were all zero, per step
  last: Sample | null = null;

  private readonly tasks: Task[];

  constructor(readonly algo: Algo, seed: number, tasks: Task[] = TASKS) {
    this.tasks = tasks;
    this.logits = tasks.map((t) => [...t.init]);
    this.ref = tasks.map((t) => [...t.init]);
    this.rand = rng(seed);
    this.history.push(this.accuracy());
  }

  accuracy(): number {
    return this.tasks.reduce((s, t, i) => s + t.correct.reduce((a, c) => a + softmax(this.logits[i])[c], 0), 0) / this.tasks.length;
  }

  private sample(p: number[]): number {
    let u = this.rand();
    for (let i = 0; i < p.length; i++) {
      u -= p[i];
      if (u <= 0) return i;
    }
    return p.length - 1;
  }

  step(s: Settings, reward: (task: number, pick: number) => number = (t, a) => (this.tasks[t].correct.includes(a) ? 1 : 0)) {
    const grads = this.logits.map((row) => row.map(() => 0));
    let zero = 0;
    for (let b = 0; b < s.batch; b++) {
      const t = Math.floor(this.rand() * this.tasks.length);
      const p = softmax(this.logits[t]);
      const picks = Array.from({ length: s.group }, () => this.sample(p));
      const rewards = picks.map((a) => reward(t, a));
      let adv: number[];
      if (this.algo === 'grpo') {
        const m = rewards.reduce((x, y) => x + y, 0) / rewards.length;
        const sd = Math.sqrt(rewards.reduce((x, r) => x + (r - m) ** 2, 0) / rewards.length);
        adv = sd > 0 ? rewards.map((r) => (r - m) / (sd + 1e-4)) : rewards.map(() => 0);
        if (sd === 0) zero++;
      } else adv = rewards; // REINFORCE without a baseline: the raw reward
      // Policy gradient for a softmax: d log π(a) / d logits = onehot(a) − π
      picks.forEach((a, i) => p.forEach((pj, j) => (grads[t][j] += (adv[i] * ((j === a ? 1 : 0) - pj)) / s.group)));
      this.last = { task: t, picks, rewards, advantages: adv };
    }
    this.logits = this.logits.map((row, t) => row.map((v, j) => v + (s.lr * grads[t][j]) / s.batch));
    if (s.beta > 0) {
      // Gradient of KL(π ‖ π_ref) with respect to the logits: π_j (log π_j − log ref_j − KL)
      this.logits = this.logits.map((row, t) => {
        const p = softmax(row);
        const q = softmax(this.ref[t]);
        const kl = p.reduce((x, pj, j) => x + pj * Math.log(pj / q[j]), 0);
        return row.map((v, j) => v - s.lr * s.beta * p[j] * (Math.log(p[j] / q[j]) - kl));
      });
    }
    this.history.push(this.accuracy());
    this.zeroSignal.push(zero / s.batch);
  }
}
