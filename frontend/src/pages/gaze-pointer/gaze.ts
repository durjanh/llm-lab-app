/* The maths behind the hands-free pointer, kept free of the camera so it can be tested on its own: a least-squares
   fit from gaze features to a place on the screen, a One Euro filter that steadies the pointer, and detectors that
   turn a face signal (or keeping still) into a single click. */

export type Point = [number, number];

/** One calibration sample: the gaze features measured while the person looked at a known place. */
export interface Sample {
  features: number[];
  target: Point;
}

/** A fitted mapping: features are standardised with mean and spread, then each axis is a weighted sum. */
export interface Mapping {
  mean: number[];
  spread: number[];
  wx: number[];
  wy: number[];
}

/** Solves A w = b by Gaussian elimination with partial pivoting. A is square. */
function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const k = M[r][c] / d;
      for (let j = c; j <= n; j++) M[r][j] -= k * M[c][j];
    }
  }
  return M.map((row, i) => row[n] / (row[i] || 1e-12));
}

/** Ridge least squares: the weights w that minimise |X w − y|² + ridge·|w|² (the intercept is not penalised). */
export function leastSquares(X: number[][], y: number[], ridge = 0): number[] {
  const n = X[0].length;
  const A = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => X.reduce((s, row) => s + row[i] * row[j], 0) + (i === j && i > 0 ? ridge : 0)),
  );
  const b = Array.from({ length: n }, (_, i) => X.reduce((s, row, k) => s + row[i] * y[k], 0));
  return solve(A, b);
}

const row = (m: Pick<Mapping, 'mean' | 'spread'>, f: number[]) => [
  1,
  ...f.map((v, i) => (v - m.mean[i]) / m.spread[i]),
];

/** Fits screen position = weighted sum of the (standardised) features, one set of weights per axis. */
export function fitMapping(samples: Sample[], ridge = 0.01): Mapping {
  const k = samples[0].features.length;
  const mean = Array.from({ length: k }, (_, i) => samples.reduce((s, x) => s + x.features[i], 0) / samples.length);
  const spread = mean.map(
    (m, i) => Math.sqrt(samples.reduce((s, x) => s + (x.features[i] - m) ** 2, 0) / samples.length) || 1,
  );
  const X = samples.map((s) => row({ mean, spread }, s.features));
  return {
    mean,
    spread,
    wx: leastSquares(
      X,
      samples.map((s) => s.target[0]),
      ridge,
    ),
    wy: leastSquares(
      X,
      samples.map((s) => s.target[1]),
      ridge,
    ),
  };
}

export function applyMapping(m: Mapping, features: number[]): Point {
  const r = row(m, features);
  return [r.reduce((s, v, i) => s + v * m.wx[i], 0), r.reduce((s, v, i) => s + v * m.wy[i], 0)];
}

export const distance = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** The One Euro filter (Casiez, Roussel and Vogel, 2012): heavy smoothing when still, little lag when moving fast. */
export class OneEuro {
  private x: number | null = null;
  private dx = 0;
  private t = 0;
  constructor(
    public minCutoff = 1.0,
    public beta = 0.02,
    private dCutoff = 1.0,
  ) {}

  private static alpha(cutoff: number, dt: number) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  filter(value: number, tMs: number): number {
    if (this.x === null) {
      this.x = value;
      this.t = tMs;
      return value;
    }
    const dt = Math.max(1e-3, (tMs - this.t) / 1000);
    this.t = tMs;
    const d = (value - this.x) / dt;
    this.dx += OneEuro.alpha(this.dCutoff, dt) * (d - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += OneEuro.alpha(cutoff, dt) * (value - this.x);
    return this.x;
  }

  reset() {
    this.x = null;
    this.dx = 0;
  }
}

/** A One Euro filter for each axis of a point. */
export class PointFilter {
  private fx: OneEuro;
  private fy: OneEuro;
  constructor(minCutoff = 1.0, beta = 0.02) {
    this.fx = new OneEuro(minCutoff, beta);
    this.fy = new OneEuro(minCutoff, beta);
  }
  tune(minCutoff: number, beta: number) {
    for (const f of [this.fx, this.fy]) {
      f.minCutoff = minCutoff;
      f.beta = beta;
    }
  }
  filter(p: Point, tMs: number): Point {
    return [this.fx.filter(p[0], tMs), this.fy.filter(p[1], tMs)];
  }
  reset() {
    this.fx.reset();
    this.fy.reset();
  }
}

export interface ClickOptions {
  /** The signal must rise above this… */
  threshold: number;
  /** …and stay there this long, so a passing twitch or an ordinary blink does not click. */
  holdMs: number;
  /** After a click, the signal must fall below threshold × this before the next one can start. */
  releaseRatio: number;
  /** And no second click within this time. */
  refractoryMs: number;
}

/** Turns a signal between 0 and 1 (jaw open, lips pressed, eyes shut) into single clicks: hold, fire once, release. */
export class ClickDetector {
  private above: number | null = null;
  private fired = false;
  private last = -Infinity;
  constructor(public options: ClickOptions) {}

  /** True on the one frame a click happens. */
  update(signal: number, tMs: number): boolean {
    const o = this.options;
    if (this.fired) {
      if (signal < o.threshold * o.releaseRatio) {
        this.fired = false;
        this.above = null;
      }
      return false;
    }
    if (signal < o.threshold) {
      this.above = null;
      return false;
    }
    this.above ??= tMs;
    if (tMs - this.above >= o.holdMs && tMs - this.last >= o.refractoryMs) {
      this.fired = true;
      this.last = tMs;
      return true;
    }
    return false;
  }

  /** How far through the hold the current press is, 0 to 1, for the meter. */
  progress(tMs: number): number {
    if (this.fired) return 1;
    return this.above === null ? 0 : Math.min(1, (tMs - this.above) / this.options.holdMs);
  }

  reset() {
    this.above = null;
    this.fired = false;
  }
}

/** A click by keeping the pointer still: it fires once the pointer has stayed within radius for ms. */
export class DwellDetector {
  private anchor: Point | null = null;
  private since = 0;
  private fired = false;
  constructor(
    public radius: number,
    public ms: number,
  ) {}

  update(p: Point, tMs: number): boolean {
    if (!this.anchor || distance(p, this.anchor) > this.radius) {
      this.anchor = p;
      this.since = tMs;
      this.fired = false;
      return false;
    }
    if (!this.fired && tMs - this.since >= this.ms) {
      this.fired = true;
      return true;
    }
    return false;
  }

  progress(tMs: number): number {
    return this.anchor && !this.fired ? Math.min(1, (tMs - this.since) / this.ms) : 0;
  }

  reset() {
    this.anchor = null;
    this.fired = false;
  }
}

const quantile = (xs: number[], q: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))];
};

/**
 * The person's own click threshold, from the signal at rest and while they made their click a few times: halfway
 * between the top of resting (95th percentile) and a typical peak (90th percentile). Too small a gap means the
 * camera cannot tell the two apart, so the click would be unreliable.
 */
export function thresholdFrom(rest: number[], action: number[]) {
  const restTop = quantile(rest, 0.95);
  const peak = quantile(action, 0.9);
  const gap = peak - restTop;
  return { threshold: restTop + gap / 2, restTop, peak, ok: gap >= 0.15 };
}

/** The nine calibration places, as fractions of the practice area: corners, edges and the middle. */
export const NINE: Point[] = [0.1, 0.5, 0.9].flatMap((y) => [0.1, 0.5, 0.9].map((x) => [x, y] as Point));

/** The places the accuracy test asks the person to look at: not the calibration places. */
export const TESTS: Point[] = [
  [0.3, 0.3],
  [0.7, 0.3],
  [0.3, 0.7],
  [0.7, 0.7],
];
