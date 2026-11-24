import { gaussian, mulberry32 } from '../tuning/gp';

/*
  The capstone's black boxes: invented functions of 2 to 6 inputs, each a sum of Gaussian bumps, some with noise.
  Every input is scaled to [0, 1] and rounded to three decimals before it is used; higher outputs are better.

  The definitions are deliberately plain so examples/ml-course/capstone/ can port them to Python exactly:

    clean(x)  = Σ_k h_k · exp( −Σ_i (x_i − c_ki)² / (2 · w_k²) )
    noisy(x, n) = clean(x) + noiseSd · z_n,  where z_n is one Box–Muller draw from mulberry32(seed · 1000 + n),
                  n being the query's position in the history (the starting points are 0, 1, …)
    starting points: mulberry32(seed), drawn row by row, `initial` rows of `dims` uniforms, each rounded to 3 places

  mulberry32 and the Box–Muller step are in ../tuning/gp.ts; Box–Muller takes u1 = max(rand(), 1e-12) first, then
  u2 = rand(), and returns sqrt(−2 ln u1) · cos(2π u2).
*/

export interface Bump {
  /** Height of the bump. */
  h: number;
  /** Its centre, one value per input. */
  c: number[];
  /** Its width (standard deviation in every direction). */
  w: number;
}

export interface BlackBox {
  id: string;
  name: string;
  story: string;
  /** Names of the inputs, each scaled to [0, 1]. */
  inputs: string[];
  output: string;
  bumps: Bump[];
  noiseSd: number;
  seed: number;
  /** Starting points given before round 1. */
  initial: number;
  rounds: number;
  perRound: number;
}

export const BLACK_BOXES: BlackBox[] = [
  {
    id: 'oven',
    name: 'The bakery oven',
    story:
      'A bakery is moving its sourdough to a new oven. Two dials, oven temperature and bake time, set the crust. A taster scores each loaf; the score is consistent, with a little day-to-day wobble.',
    inputs: ['temperature', 'bake time'],
    output: 'crust score',
    bumps: [
      { h: 1.0, c: [0.62, 0.35], w: 0.12 },
      { h: 0.7, c: [0.18, 0.78], w: 0.08 },
    ],
    noiseSd: 0.01,
    seed: 11,
    initial: 4,
    rounds: 10,
    perRound: 2,
  },
  {
    id: 'greenhouse',
    name: 'The greenhouse',
    story:
      'A grower tests climate settings for a new tomato variety: temperature, humidity and hours of light. Each trial is a few weeks of growth, scored as yield per plant. Plants vary, so repeats differ a little.',
    inputs: ['temperature', 'humidity', 'light hours'],
    output: 'yield',
    bumps: [
      { h: 1.0, c: [0.3, 0.7, 0.55], w: 0.15 },
      { h: 0.8, c: [0.75, 0.25, 0.4], w: 0.1 },
      { h: 0.5, c: [0.5, 0.5, 0.9], w: 0.07 },
    ],
    noiseSd: 0.02,
    seed: 23,
    initial: 5,
    rounds: 10,
    perRound: 2,
  },
  {
    id: 'coldbrew',
    name: 'The cold brew recipe',
    story:
      'A café wants a cold brew for summer: grind size, water temperature, steeping time and coffee-to-water ratio. A panel scores each batch. A forgiving, pleasant recipe is easy to find; the best one is narrow and hides elsewhere.',
    inputs: ['grind', 'water temperature', 'steep time', 'ratio'],
    output: 'panel score',
    bumps: [
      { h: 0.9, c: [0.2, 0.4, 0.8, 0.6], w: 0.18 },
      { h: 1.0, c: [0.7, 0.65, 0.3, 0.35], w: 0.09 },
    ],
    noiseSd: 0.03,
    seed: 37,
    initial: 6,
    rounds: 10,
    perRound: 3,
  },
  {
    id: 'concrete',
    name: 'The concrete mix',
    story:
      'A builder tunes a mix for a footbridge: cement, water, sand, gravel and curing time. Each test cube is crushed after curing and its strength recorded.',
    inputs: ['cement', 'water', 'sand', 'gravel', 'curing time'],
    output: 'strength',
    bumps: [
      { h: 1.0, c: [0.55, 0.3, 0.6, 0.45, 0.8], w: 0.2 },
      { h: 0.75, c: [0.2, 0.7, 0.3, 0.8, 0.3], w: 0.15 },
    ],
    noiseSd: 0.02,
    seed: 41,
    initial: 7,
    rounds: 10,
    perRound: 3,
  },
  {
    id: 'drone',
    name: 'The drone controller',
    story:
      'A delivery drone wobbles in gusts. Six controller gains are tuned on a test rig that scores how steadily it holds position. Gusts make every run a little different.',
    inputs: ['roll P', 'roll D', 'pitch P', 'pitch D', 'yaw P', 'throttle filter'],
    output: 'steadiness',
    bumps: [
      { h: 1.0, c: [0.4, 0.6, 0.25, 0.7, 0.5, 0.35], w: 0.22 },
      { h: 0.85, c: [0.8, 0.2, 0.7, 0.3, 0.6, 0.75], w: 0.16 },
      { h: 0.6, c: [0.15, 0.15, 0.85, 0.5, 0.2, 0.6], w: 0.12 },
    ],
    noiseSd: 0.05,
    seed: 53,
    initial: 8,
    rounds: 10,
    perRound: 3,
  },
];

/** Clamps each input to [0, 1] and rounds it to three decimals, as every query is. */
export const tidy = (x: number[]) => x.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 1000) / 1000);

/** The function without noise. Revealed to the reader only at the end. */
export function clean(box: BlackBox, x: number[]): number {
  let s = 0;
  for (const b of box.bumps) {
    let d2 = 0;
    for (let i = 0; i < x.length; i++) d2 += (x[i] - b.c[i]) ** 2;
    s += b.h * Math.exp(-d2 / (2 * b.w * b.w));
  }
  return s;
}

/** One measurement: the clean value plus this query's fixed noise draw. */
export function measure(box: BlackBox, x: number[], queryIndex: number): number {
  const z = gaussian(mulberry32(box.seed * 1000 + queryIndex));
  return clean(box, tidy(x)) + box.noiseSd * z;
}

/** The starting points everyone gets, the same every time. */
export function startingPoints(box: BlackBox): number[][] {
  const rand = mulberry32(box.seed);
  return Array.from({ length: box.initial }, () => tidy(box.inputs.map(() => rand())));
}

/**
 * The best point and its clean value, taken as the bump centre with the highest clean value. With overlapping bumps
 * that need not be the tallest bump's centre; a test checks that no sampled point beats it.
 */
export function optimum(box: BlackBox): { x: number[]; value: number } {
  return box.bumps.map((b) => ({ x: b.c, value: clean(box, b.c) })).reduce((a, b) => (b.value > a.value ? b : a));
}

/* ---------- A reader's progress ---------- */

export interface Progress {
  /** The reader's own queries, in order. */
  queries: number[][];
  ys: number[];
  /** One note per finished round: what was tried and why. */
  notes: string[];
}

export const EMPTY: Progress = { queries: [], ys: [], notes: [] };

/** Every observation so far: the starting points and then the reader's queries, with their measured outputs. */
export function history(box: BlackBox, p: Progress): { x: number[]; y: number; round: number }[] {
  const start = startingPoints(box).map((x, i) => ({ x, y: measure(box, x, i), round: 0 }));
  return [...start, ...p.queries.map((x, i) => ({ x, y: p.ys[i], round: Math.floor(i / box.perRound) + 1 }))];
}

export const roundsDone = (box: BlackBox, p: Progress) => Math.floor(p.queries.length / box.perRound);
export const finished = (box: BlackBox, p: Progress) => roundsDone(box, p) >= box.rounds;

/**
 * Adds one round of queries and the note about it. Refuses the wrong number of points, a finished challenge, or a
 * point outside [0, 1] in any input or with the wrong number of inputs.
 */
export function submitRound(box: BlackBox, p: Progress, points: number[][], note: string): Progress {
  if (finished(box, p)) throw new Error('All rounds are used.');
  if (points.length !== box.perRound) throw new Error(`Each round takes ${box.perRound} points.`);
  for (const x of points) {
    if (x.length !== box.inputs.length || x.some((v) => !Number.isFinite(v) || v < 0 || v > 1))
      throw new Error(`Each point needs ${box.inputs.length} values between 0 and 1.`);
  }
  const queries = [...p.queries];
  const ys = [...p.ys];
  for (const raw of points) {
    const x = tidy(raw);
    ys.push(measure(box, x, box.initial + queries.length));
    queries.push(x);
  }
  return { queries, ys, notes: [...p.notes, note.trim()] };
}

/** Best measured value after the starting points and after each round. */
export function bestByRound(box: BlackBox, p: Progress): number[] {
  const h = history(box, p);
  const out: number[] = [];
  let best = -Infinity;
  for (let r = 0; r <= roundsDone(box, p); r++) {
    for (const o of h) if (o.round === r) best = Math.max(best, o.y);
    out.push(best);
  }
  return out;
}

/**
 * Regret after each round: how far the clean value of the best-measured point so far is below the optimum. It
 * uses clean values, so a lucky noisy reading does not count as success.
 */
export function regretByRound(box: BlackBox, p: Progress): number[] {
  const h = history(box, p);
  const opt = optimum(box).value;
  const out: number[] = [];
  let bestY = -Infinity;
  let bestX: number[] = h[0].x;
  for (let r = 0; r <= roundsDone(box, p); r++) {
    for (const o of h)
      if (o.round === r && o.y > bestY) {
        bestY = o.y;
        bestX = o.x;
      }
    out.push(Math.max(0, opt - clean(box, bestX)));
  }
  return out;
}

const fmt = (x: number[]) => x.map((v) => v.toFixed(3)).join(', ');

/** The reader's work as Markdown for a portfolio README: the problem, the rounds and notes, and the result. */
export function toMarkdown(box: BlackBox, p: Progress): string {
  const h = history(box, p);
  const done = finished(box, p);
  const best = h.reduce((a, b) => (b.y > a.y ? b : a));
  const lines = [
    `# Capstone: ${box.name}`,
    '',
    box.story,
    '',
    `Inputs (each scaled to 0–1): ${box.inputs.join(', ')}. Output: ${box.output} (higher is better).`,
    `Budget: ${box.initial} starting points, then ${box.rounds} rounds of ${box.perRound} queries.`,
    '',
    '## Result',
    '',
    `Best measured ${box.output}: **${best.y.toFixed(3)}** at (${fmt(best.x)}), found in ${best.round ? `round ${best.round}` : 'the starting points'}.`,
  ];
  if (done) {
    const opt = optimum(box);
    lines.push(
      `Known optimum (revealed at the end): ${opt.value.toFixed(3)} at (${fmt(opt.x)}). Regret of the best point: ${Math.max(0, opt.value - clean(box, best.x)).toFixed(3)}.`,
    );
  }
  lines.push('', '## Rounds', '');
  for (let r = 1; r <= roundsDone(box, p); r++) {
    lines.push(`### Round ${r}`, '');
    for (const o of h.filter((q) => q.round === r)) lines.push(`- (${fmt(o.x)}) → ${o.y.toFixed(3)}`);
    lines.push('', p.notes[r - 1] ? p.notes[r - 1] : '_No note written._', '');
  }
  lines.push(
    '## Method',
    '',
    'Describe the surrogate model, the acquisition function and its settings, and how the balance between exploring and exploiting changed over the rounds.',
    '',
  );
  return lines.join('\n');
}

/** Reads saved progress defensively: anything malformed becomes an empty start. */
export function parseSaved(text: string | null): Record<string, Progress> {
  if (!text) return {};
  try {
    const raw = JSON.parse(text) as Record<string, Progress>;
    const out: Record<string, Progress> = {};
    for (const box of BLACK_BOXES) {
      const p = raw?.[box.id];
      if (
        p &&
        Array.isArray(p.queries) &&
        Array.isArray(p.ys) &&
        Array.isArray(p.notes) &&
        p.queries.length === p.ys.length &&
        p.queries.length % box.perRound === 0 &&
        p.queries.length <= box.rounds * box.perRound &&
        p.queries.every(
          (x) => Array.isArray(x) && x.length === box.inputs.length && x.every((v) => typeof v === 'number'),
        )
      )
        // Recompute the outputs, so an edited save cannot change what the black box said.
        out[box.id] = {
          queries: p.queries.map(tidy),
          ys: p.queries.map((x, i) => measure(box, tidy(x), box.initial + i)),
          notes: p.notes.map(String),
        };
    }
    return out;
  } catch {
    return {};
  }
}
