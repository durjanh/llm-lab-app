/*
  The maths behind the Maths for ML page: vectors, 2×2 matrices, a small layer, derivatives, loss surfaces, a chain
  rule graph and three optimisers. Pure functions, so the tests check exactly what the page draws.
*/

export type Vec2 = [number, number];

export const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);
export const norm = (a: number[]) => Math.sqrt(dot(a, a));

/** Cosine similarity: 1 when two vectors point the same way, 0 at right angles, -1 when opposite. */
export function cosine(a: number[], b: number[]): number {
  const n = norm(a) * norm(b);
  return n === 0 ? 0 : dot(a, b) / n;
}

/** The angle between two vectors in degrees. */
export const angleDeg = (a: number[], b: number[]) =>
  (Math.acos(Math.max(-1, Math.min(1, cosine(a, b)))) * 180) / Math.PI;

/** A 2×2 matrix as [[a, b], [c, d]], acting on column vectors. */
export type Mat2 = [[number, number], [number, number]];

export const apply2 = (m: Mat2, v: Vec2): Vec2 => [m[0][0] * v[0] + m[0][1] * v[1], m[1][0] * v[0] + m[1][1] * v[1]];

/** The determinant: how much the matrix scales areas, negative when it flips the plane over. */
export const det2 = (m: Mat2) => m[0][0] * m[1][1] - m[0][1] * m[1][0];

export const MATRIX_PRESETS: { name: string; m: Mat2; note: string }[] = [
  {
    name: 'Identity',
    m: [
      [1, 0],
      [0, 1],
    ],
    note: 'Changes nothing. Determinant 1.',
  },
  {
    name: 'Stretch',
    m: [
      [2, 0],
      [0, 0.5],
    ],
    note: 'Doubles width, halves height. Area is unchanged: determinant 1.',
  },
  {
    name: 'Rotate 30°',
    m: [
      [Math.cos(Math.PI / 6), -Math.sin(Math.PI / 6)],
      [Math.sin(Math.PI / 6), Math.cos(Math.PI / 6)],
    ],
    note: 'Turns everything about the origin. Lengths and areas are kept.',
  },
  {
    name: 'Shear',
    m: [
      [1, 1],
      [0, 1],
    ],
    note: 'Slides each row sideways by its height. Area is kept.',
  },
  {
    name: 'Mirror',
    m: [
      [-1, 0],
      [0, 1],
    ],
    note: 'Flips left and right. Determinant -1: the shape is turned over.',
  },
  {
    name: 'Squash flat',
    m: [
      [1, 2],
      [0.5, 1],
    ],
    note: 'Determinant 0: the whole plane lands on one line, so the step cannot be undone.',
  },
];

/** A dense layer with a ReLU: out = max(0, W·x + b), with the sums before the ReLU for showing the working. */
export function layer(w: number[][], x: number[], b: number[]): { pre: number[]; out: number[] } {
  const pre = w.map((row, i) => dot(row, x) + b[i]);
  return { pre, out: pre.map((z) => Math.max(0, z)) };
}

export interface Fn1 {
  id: string;
  name: string;
  f: (x: number) => number;
  /** The exact derivative, to compare with the slope of the secant. */
  df: (x: number) => number;
}

export const FUNCTIONS: Fn1[] = [
  { id: 'square', name: 'x²', f: (x) => x * x, df: (x) => 2 * x },
  { id: 'cubic', name: 'x³ − 3x', f: (x) => x ** 3 - 3 * x, df: (x) => 3 * x * x - 3 },
  { id: 'sin', name: 'sin x', f: Math.sin, df: Math.cos },
  {
    id: 'sigmoid',
    name: 'σ(x), the sigmoid',
    f: (x) => 1 / (1 + Math.exp(-x)),
    df: (x) => {
      const s = 1 / (1 + Math.exp(-x));
      return s * (1 - s);
    },
  },
];

/** The slope of the line through (x, f(x)) and (x + h, f(x + h)). It tends to the derivative as h shrinks. */
export const secantSlope = (f: (x: number) => number, x: number, h: number) => (f(x + h) - f(x)) / h;

export interface Surface {
  id: string;
  name: string;
  f: (x: number, y: number) => number;
  grad: (x: number, y: number) => Vec2;
  start: Vec2;
  /** What the surface is there to show. */
  lesson: string;
}

export const SURFACES: Surface[] = [
  {
    id: 'bowl',
    name: 'Round bowl',
    f: (x, y) => x * x + y * y,
    grad: (x, y) => [2 * x, 2 * y],
    start: [2.4, 1.8],
    lesson: 'Every direction curves the same amount, so the gradient points straight at the bottom.',
  },
  {
    id: 'ravine',
    name: 'Narrow ravine',
    f: (x, y) => 0.1 * x * x + 4 * y * y,
    grad: (x, y) => [0.2 * x, 8 * y],
    start: [-2.6, 0.9],
    lesson: 'Steep across, gentle along. A step big enough to make progress along the floor bounces from wall to wall.',
  },
  {
    id: 'saddle',
    name: 'Saddle',
    f: (x, y) => x * x - y * y,
    grad: (x, y) => [2 * x, -2 * y],
    start: [2.5, 0.02],
    lesson:
      'Downhill in x, uphill in y. Starting almost on the ridge, plain descent creeps towards the flat middle before sliding off.',
  },
  {
    id: 'two',
    name: 'Two valleys',
    f: (x, y) => (x * x - 1) ** 2 + 0.5 * y * y + 0.3 * x,
    grad: (x, y) => [4 * x * (x * x - 1) + 0.3, y],
    start: [2.2, 1.6],
    lesson: 'The left valley is deeper. Where you start decides which one you end in.',
  },
];

export const surfaceById = (id: string) => SURFACES.find((s) => s.id === id) ?? SURFACES[0];

export type Optimiser = 'gd' | 'momentum' | 'adam';

export interface DescentResult {
  path: Vec2[];
  losses: number[];
  diverged: boolean;
  /** The first step at which the loss stopped changing by more than the tolerance, or null. */
  settledAt: number | null;
}

const LIMIT = 50;

/**
 * Runs an optimiser on a surface. Momentum keeps a running velocity (β = 0.9); Adam scales each coordinate by a
 * running estimate of its gradient size (β1 = 0.9, β2 = 0.999), so steep and flat directions move at similar speeds.
 */
export function descend(s: Surface, opt: Optimiser, lr: number, steps: number, start: Vec2 = s.start): DescentResult {
  let [x, y] = start;
  const path: Vec2[] = [[x, y]];
  const losses = [s.f(x, y)];
  let vx = 0,
    vy = 0,
    mx = 0,
    my = 0,
    sx = 0,
    sy = 0;
  let diverged = false;
  let settledAt: number | null = null;
  for (let t = 1; t <= steps; t++) {
    const [gx, gy] = s.grad(x, y);
    if (opt === 'gd') {
      x -= lr * gx;
      y -= lr * gy;
    } else if (opt === 'momentum') {
      vx = 0.9 * vx + gx;
      vy = 0.9 * vy + gy;
      x -= lr * vx;
      y -= lr * vy;
    } else {
      mx = 0.9 * mx + 0.1 * gx;
      my = 0.9 * my + 0.1 * gy;
      sx = 0.999 * sx + 0.001 * gx * gx;
      sy = 0.999 * sy + 0.001 * gy * gy;
      const mhx = mx / (1 - 0.9 ** t),
        mhy = my / (1 - 0.9 ** t);
      const shx = sx / (1 - 0.999 ** t),
        shy = sy / (1 - 0.999 ** t);
      x -= (lr * mhx) / (Math.sqrt(shx) + 1e-8);
      y -= (lr * mhy) / (Math.sqrt(shy) + 1e-8);
    }
    if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > LIMIT || Math.abs(y) > LIMIT) {
      diverged = true;
      break;
    }
    path.push([x, y]);
    const loss = s.f(x, y);
    if (settledAt === null && Math.abs(loss - losses[losses.length - 1]) < 1e-6 && Math.hypot(gx, gy) < 1e-3)
      settledAt = t;
    losses.push(loss);
  }
  return { path, losses, diverged, settledAt };
}

/** The values and gradients of L = (w·x + b)² as a three-node graph: q = w·x, r = q + b, L = r². */
export interface ChainGraph {
  q: number;
  r: number;
  L: number;
  dL_dr: number;
  dL_dq: number;
  dL_dw: number;
  dL_dx: number;
  dL_db: number;
}

export function chainGraph(w: number, x: number, b: number): ChainGraph {
  const q = w * x;
  const r = q + b;
  const L = r * r;
  const dL_dr = 2 * r; // the last node's local derivative
  const dL_dq = dL_dr * 1; // r = q + b passes the gradient straight through
  return { q, r, L, dL_dr, dL_dq, dL_dw: dL_dq * x, dL_dx: dL_dq * w, dL_db: dL_dr * 1 };
}

/** A grid of loss values for drawing a surface as shaded bands. */
export function surfaceGrid(s: Surface, n: number, range = 3): { x: number; y: number; v: number }[] {
  const out: { x: number; y: number; v: number }[] = [];
  const step = (2 * range) / n;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      const x = -range + (i + 0.5) * step;
      const y = -range + (j + 0.5) * step;
      out.push({ x, y, v: s.f(x, y) });
    }
  return out;
}
