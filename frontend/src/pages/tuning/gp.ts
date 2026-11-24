/*
  A small Gaussian process for Bayesian optimisation, written out so the page needs no library: a squared-exponential
  kernel, a Cholesky solve, the posterior mean and spread, samples from the posterior, and three acquisition functions.
  The capstone page uses the same code for its helpers.
*/

/** mulberry32: a tiny seeded generator, so every simulation on these pages is repeatable. Returns numbers in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A standard normal draw from two uniforms (Box–Muller). */
export function gaussian(rand: () => number): number {
  const u1 = Math.max(rand(), 1e-12);
  const u2 = rand();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** The standard normal density. */
export const normPdf = (z: number) => Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);

/** The standard normal cumulative distribution, through an erf approximation accurate to about 1e-7. */
export function normCdf(z: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(z / Math.SQRT2));
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-(z * z) / 2);
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

/** Lower-triangular L with L Lᵀ = A, for a symmetric positive-definite A. Throws if A is not. */
export function cholesky(A: number[][]): number[][] {
  const n = A.length;
  const L = A.map(() => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i][j];
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
      if (i === j) {
        if (s <= 0) throw new Error('Matrix is not positive definite');
        L[i][i] = Math.sqrt(s);
      } else L[i][j] = s / L[j][j];
    }
  }
  return L;
}

/** Solves L x = b for lower-triangular L. */
export function solveLower(L: number[][], b: number[]): number[] {
  const x = new Array<number>(b.length).fill(0);
  for (let i = 0; i < b.length; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= L[i][k] * x[k];
    x[i] = s / L[i][i];
  }
  return x;
}

/** Solves Lᵀ x = b for lower-triangular L. */
export function solveUpper(L: number[][], b: number[]): number[] {
  const n = b.length;
  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = b[i];
    for (let k = i + 1; k < n; k++) s -= L[k][i] * x[k];
    x[i] = s / L[i][i];
  }
  return x;
}

export interface Kernel {
  /** How far apart two inputs can be and still move together. Short: wiggly; long: smooth. */
  lengthScale: number;
  /** The prior variance of the function (in the units of the normalised outputs). */
  signalVar: number;
  /** Observation noise variance: how much a repeated measurement can differ. */
  noise: number;
}

/** The squared-exponential (RBF) kernel between two points. */
export function rbf(a: number[], b: number[], k: Kernel): number {
  let d2 = 0;
  for (let i = 0; i < a.length; i++) d2 += (a[i] - b[i]) ** 2;
  return k.signalVar * Math.exp(-d2 / (2 * k.lengthScale * k.lengthScale));
}

export interface Posterior {
  mean: number;
  sd: number;
}

export interface GP {
  predict(x: number[]): Posterior;
  /** The observed inputs and outputs the process was fitted to. */
  X: number[][];
  y: number[];
  kernel: Kernel;
}

/**
 * Fits a Gaussian process to observations. Outputs are centred on their mean and scaled by their spread, so the
 * kernel's signal variance of about 1 suits any units; predictions are given back in the original units.
 */
export function fitGP(X: number[][], y: number[], kernel: Kernel): GP {
  const n = y.length;
  const mu = n ? y.reduce((a, b) => a + b, 0) / n : 0;
  const sdY = n > 1 ? Math.sqrt(y.reduce((a, b) => a + (b - mu) ** 2, 0) / n) || 1 : 1;
  const z = y.map((v) => (v - mu) / sdY);
  if (n === 0) {
    return {
      X,
      y,
      kernel,
      predict: () => ({ mean: mu, sd: Math.sqrt(kernel.signalVar) * sdY }),
    };
  }
  const K = X.map((a, i) => X.map((b, j) => rbf(a, b, kernel) + (i === j ? kernel.noise + 1e-9 : 0)));
  const L = cholesky(K);
  const alpha = solveUpper(L, solveLower(L, z));
  return {
    X,
    y,
    kernel,
    predict(x: number[]): Posterior {
      const ks = X.map((a) => rbf(a, x, kernel));
      let m = 0;
      for (let i = 0; i < n; i++) m += ks[i] * alpha[i];
      const v = solveLower(L, ks);
      let vv = 0;
      for (const e of v) vv += e * e;
      const variance = Math.max(kernel.signalVar - vv, 1e-12);
      return { mean: mu + m * sdY, sd: Math.sqrt(variance) * sdY };
    },
  };
}

/**
 * Draws functions from the posterior at the given 1D inputs, using the joint covariance so the samples are smooth
 * curves rather than independent dots. A little jitter keeps the Cholesky stable.
 */
export function samplePosterior(gp: GP, xs: number[], count: number, seed: number): number[][] {
  const { X, y, kernel } = gp;
  const n = y.length;
  const mu = n ? y.reduce((a, b) => a + b, 0) / n : 0;
  const sdY = n > 1 ? Math.sqrt(y.reduce((a, b) => a + (b - mu) ** 2, 0) / n) || 1 : 1;
  const pts = xs.map((x) => [x]);
  const means = pts.map((p) => gp.predict(p).mean);
  // Posterior covariance in normalised units: Kss - Ksxᵀ K⁻¹ Ksx.
  let V: number[][] = [];
  if (n) {
    const K = X.map((a, i) => X.map((b, j) => rbf(a, b, kernel) + (i === j ? kernel.noise + 1e-9 : 0)));
    const L = cholesky(K);
    V = pts.map((p) =>
      solveLower(
        L,
        X.map((a) => rbf(a, p, kernel)),
      ),
    );
  }
  const m = pts.length;
  const C = pts.map((a, i) =>
    pts.map((b, j) => {
      let c = rbf(a, b, kernel);
      if (n) for (let k = 0; k < n; k++) c -= V[i][k] * V[j][k];
      return c + (i === j ? 1e-6 * kernel.signalVar : 0);
    }),
  );
  let Lc: number[][];
  try {
    Lc = cholesky(C);
  } catch {
    // Fall back to independent draws if rounding broke positive definiteness.
    Lc = C.map((row, i) => row.map((_, j) => (i === j ? Math.sqrt(Math.max(C[i][i], 0)) : 0)));
  }
  const rand = mulberry32(seed);
  const out: number[][] = [];
  for (let s = 0; s < count; s++) {
    const e = Array.from({ length: m }, () => gaussian(rand));
    out.push(
      means.map((mean, i) => {
        let d = 0;
        for (let k = 0; k <= i; k++) d += Lc[i][k] * e[k];
        return mean + d * sdY;
      }),
    );
  }
  return out;
}

export type Acquisition = 'ei' | 'ucb' | 'pi';

/**
 * How much a point is worth trying next, for a maximisation. Expected improvement weighs how likely and how large
 * a gain over the best so far is; probability of improvement counts only how likely; the upper confidence bound adds
 * κ spreads to the mean, so a larger κ explores more.
 */
export function acquisition(kind: Acquisition, p: Posterior, best: number, opts: { kappa?: number; xi?: number } = {}) {
  const xi = opts.xi ?? 0.01;
  if (kind === 'ucb') return p.mean + (opts.kappa ?? 2) * p.sd;
  if (p.sd < 1e-12) return kind === 'ei' ? Math.max(p.mean - best - xi, 0) : p.mean > best + xi ? 1 : 0;
  const z = (p.mean - best - xi) / p.sd;
  if (kind === 'pi') return normCdf(z);
  return (p.mean - best - xi) * normCdf(z) + p.sd * normPdf(z);
}

/**
 * Picks the next point to try in the unit hypercube: scores random candidates plus small steps around the best
 * points seen, and returns the one with the highest acquisition. Good enough for up to six inputs.
 */
export function suggest(
  gp: GP,
  dims: number,
  kind: Acquisition,
  seed: number,
  opts: { kappa?: number; candidates?: number; exclude?: number[][] } = {},
): number[] {
  const rand = mulberry32(seed);
  const best = gp.y.length ? Math.max(...gp.y) : 0;
  const cands: number[][] = [];
  const total = opts.candidates ?? 1500;
  for (let i = 0; i < total; i++) cands.push(Array.from({ length: dims }, () => rand()));
  // Local candidates around the three best observations, so a narrow peak can be refined.
  const order = gp.y.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]);
  for (const [, i] of order.slice(0, 3))
    for (let j = 0; j < 150; j++) cands.push(gp.X[i].map((v) => Math.min(1, Math.max(0, v + 0.06 * gaussian(rand)))));
  const taken = opts.exclude ?? [];
  let bestScore = -Infinity;
  let bestX = cands[0];
  for (const c of cands) {
    if (taken.some((t) => t.every((v, i) => Math.abs(v - c[i]) < 1e-3))) continue;
    const s = acquisition(kind, gp.predict(c), best, { kappa: opts.kappa });
    if (s > bestScore) {
      bestScore = s;
      bestX = c;
    }
  }
  return bestX.map((v) => Math.round(v * 1000) / 1000);
}
