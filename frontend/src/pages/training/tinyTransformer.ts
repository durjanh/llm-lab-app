/* A tiny decoder-only transformer with hand-written backpropagation, small enough to train live in the browser.
 * Token and position embeddings, then 1 or 2 pre-norm blocks (causal multi-head self-attention, a ReLU MLP,
 * residual connections), a final layer norm and an untied output layer. All weights live in one flat
 * Float64Array. The file has no imports, so Node can run it directly for the gradient check. */

export interface Config {
  V: number; // vocabulary size
  T: number; // context length
  d: number; // embedding size
  layers: number;
  heads: number;
  F: number; // MLP hidden units
}

interface LayerOffsets {
  g1: number;
  b1: number;
  Wq: number;
  Wk: number;
  Wv: number;
  Wo: number;
  g2: number;
  b2: number;
  W1: number;
  c1: number;
  W2: number;
  c2: number;
}

interface Offsets {
  E: number;
  P: number;
  L: LayerOffsets[];
  gf: number;
  bf: number;
  U: number;
  bu: number;
  n: number;
}

/** What one block keeps from the forward pass, for one sequence, so the backward pass can reuse it. */
interface LayerBuffers {
  x: Float64Array; // residual stream into the block, T x d
  a: Float64Array; // layer norm 1 output
  mu1: Float64Array;
  rs1: Float64Array;
  q: Float64Array;
  k: Float64Array;
  v: Float64Array;
  A: Float64Array; // attention weights, heads x T x T, zero above the diagonal
  z: Float64Array; // heads' outputs side by side, T x d
  xm: Float64Array; // residual stream after attention
  b: Float64Array; // layer norm 2 output
  mu2: Float64Array;
  rs2: Float64Array;
  u: Float64Array; // MLP pre-activation, T x F
  r: Float64Array; // after ReLU
}

interface Buffers {
  L: LayerBuffers[];
  xf: Float64Array; // residual stream after the last block
  f: Float64Array; // final layer norm output
  muf: Float64Array;
  rsf: Float64Array;
  P: Float64Array; // next-token probabilities, T x V
  // scratch for the backward pass
  dres: Float64Array;
  dn: Float64Array;
  dq: Float64Array;
  dk: Float64Array;
  dv: Float64Array;
  dz: Float64Array;
  du: Float64Array;
  dlog: Float64Array;
  dA: Float64Array;
}

export interface Model {
  cfg: Config;
  off: Offsets;
  p: Float64Array; // weights
  g: Float64Array; // gradients
  m: Float64Array; // Adam's first moment
  s: Float64Array; // Adam's second moment
  t: number; // Adam steps taken
  buf: Buffers;
}

const LN_EPS = 1e-5;

function layout(c: Config): Offsets {
  let n = 0;
  const take = (size: number) => {
    const at = n;
    n += size;
    return at;
  };
  const { V, T, d, F } = c;
  const E = take(V * d);
  const P = take(T * d);
  const L: LayerOffsets[] = [];
  for (let l = 0; l < c.layers; l++) {
    L.push({
      g1: take(d),
      b1: take(d),
      Wq: take(d * d),
      Wk: take(d * d),
      Wv: take(d * d),
      Wo: take(d * d),
      g2: take(d),
      b2: take(d),
      W1: take(d * F),
      c1: take(F),
      W2: take(F * d),
      c2: take(d),
    });
  }
  const gf = take(d);
  const bf = take(d);
  const U = take(d * V);
  const bu = take(V);
  return { E, P, L, gf, bf, U, bu, n };
}

function gauss(rand: () => number): number {
  const u = Math.max(rand(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

/** Seeded random numbers (mulberry32), so a run can be repeated exactly. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Number of weights a model of this shape has. */
export function paramCount(c: Config): number {
  return layout(c).n;
}

/** A fresh model with small random weights. Layer norms start as the identity. */
export function create(c: Config, rand: () => number): Model {
  if (c.d % c.heads) throw new Error('The embedding size must divide evenly between the heads.');
  const off = layout(c);
  const p = new Float64Array(off.n);
  const fill = (at: number, size: number, std: number) => {
    for (let i = 0; i < size; i++) p[at + i] = gauss(rand) * std;
  };
  const { V, T, d, F } = c;
  fill(off.E, V * d, 0.3);
  fill(off.P, T * d, 0.3);
  const sd = 1 / Math.sqrt(d);
  for (const lo of off.L) {
    p.fill(1, lo.g1, lo.g1 + d);
    p.fill(1, lo.g2, lo.g2 + d);
    fill(lo.Wq, d * d, sd);
    fill(lo.Wk, d * d, sd);
    fill(lo.Wv, d * d, sd);
    fill(lo.Wo, d * d, sd / Math.sqrt(2 * c.layers));
    fill(lo.W1, d * F, sd);
    fill(lo.W2, F * d, 1 / Math.sqrt(F) / Math.sqrt(2 * c.layers));
  }
  p.fill(1, off.gf, off.gf + d);
  // Small output weights make the first prediction close to uniform, so the first loss is close to ln V.
  fill(off.U, d * V, 0.02);
  const f = (size: number) => new Float64Array(size);
  const L: LayerBuffers[] = off.L.map(() => ({
    x: f(T * d),
    a: f(T * d),
    mu1: f(T),
    rs1: f(T),
    q: f(T * d),
    k: f(T * d),
    v: f(T * d),
    A: f(c.heads * T * T),
    z: f(T * d),
    xm: f(T * d),
    b: f(T * d),
    mu2: f(T),
    rs2: f(T),
    u: f(T * F),
    r: f(T * F),
  }));
  const buf: Buffers = {
    L,
    xf: f(T * d),
    f: f(T * d),
    muf: f(T),
    rsf: f(T),
    P: f(T * V),
    dres: f(T * d),
    dn: f(T * Math.max(d, F)),
    dq: f(T * d),
    dk: f(T * d),
    dv: f(T * d),
    dz: f(T * d),
    du: f(T * F),
    dlog: f(T * V),
    dA: f(T),
  };
  return { cfg: c, off, p, g: f(off.n), m: f(off.n), s: f(off.n), t: 0, buf };
}

/* ---------- small dense helpers on flat row-major arrays ---------- */

/** out (n x m) = inp (n x k) · W (k x m) + bias, where W and bias sit in p at the given offsets (bias < 0: none). */
function matmul(
  out: Float64Array,
  inp: Float64Array,
  p: Float64Array,
  W: number,
  bias: number,
  n: number,
  k: number,
  m: number,
) {
  for (let t = 0; t < n; t++) {
    const o = t * m;
    if (bias >= 0) for (let j = 0; j < m; j++) out[o + j] = p[bias + j];
    else out.fill(0, o, o + m);
    for (let i = 0; i < k; i++) {
      const a = inp[t * k + i];
      if (a === 0) continue;
      const w = W + i * m;
      for (let j = 0; j < m; j++) out[o + j] += a * p[w + j];
    }
  }
}

/** Gradients of out = inp · W: adds inp^T · dOut to g at W (and the column sums to the bias), and,
 * if dIn is given, writes dIn = dOut · W^T (adding to it when `add` is true). */
function matmulBack(
  dOut: Float64Array,
  inp: Float64Array,
  p: Float64Array,
  g: Float64Array,
  W: number,
  bias: number,
  n: number,
  k: number,
  m: number,
  dIn: Float64Array | null,
  add: boolean,
) {
  for (let t = 0; t < n; t++) {
    const o = t * m;
    if (bias >= 0) for (let j = 0; j < m; j++) g[bias + j] += dOut[o + j];
    for (let i = 0; i < k; i++) {
      const a = inp[t * k + i],
        w = W + i * m;
      let acc = 0;
      for (let j = 0; j < m; j++) {
        const dj = dOut[o + j];
        g[w + j] += a * dj;
        acc += p[w + j] * dj;
      }
      if (dIn) dIn[t * k + i] = add ? dIn[t * k + i] + acc : acc;
    }
  }
}

function layerNorm(
  x: Float64Array,
  y: Float64Array,
  mu: Float64Array,
  rs: Float64Array,
  p: Float64Array,
  gain: number,
  bias: number,
  n: number,
  d: number,
) {
  for (let t = 0; t < n; t++) {
    const o = t * d;
    let m = 0;
    for (let e = 0; e < d; e++) m += x[o + e];
    m /= d;
    let v = 0;
    for (let e = 0; e < d; e++) v += (x[o + e] - m) ** 2;
    const r = 1 / Math.sqrt(v / d + LN_EPS);
    mu[t] = m;
    rs[t] = r;
    for (let e = 0; e < d; e++) y[o + e] = (x[o + e] - m) * r * p[gain + e] + p[bias + e];
  }
}

/** Back through a layer norm: adds the gain and bias gradients to g and the input gradient to dx. */
function layerNormBack(
  x: Float64Array,
  dy: Float64Array,
  mu: Float64Array,
  rs: Float64Array,
  p: Float64Array,
  g: Float64Array,
  gain: number,
  bias: number,
  n: number,
  d: number,
  dx: Float64Array,
) {
  for (let t = 0; t < n; t++) {
    const o = t * d,
      m = mu[t],
      r = rs[t];
    let s1 = 0,
      s2 = 0;
    for (let e = 0; e < d; e++) {
      const xh = (x[o + e] - m) * r,
        dye = dy[o + e];
      g[gain + e] += dye * xh;
      g[bias + e] += dye;
      const dxh = dye * p[gain + e];
      s1 += dxh;
      s2 += dxh * xh;
    }
    s1 /= d;
    s2 /= d;
    for (let e = 0; e < d; e++) {
      const xh = (x[o + e] - m) * r;
      dx[o + e] += r * (dy[o + e] * p[gain + e] - s1 - xh * s2);
    }
  }
}

/* ---------- the model ---------- */

/** Runs the model on T tokens. Leaves the next-token probabilities in M.buf.P (T x V) and every
 * block's attention weights in M.buf.L[l].A. */
export function forward(M: Model, x: ArrayLike<number>): void {
  const { V, T, d, heads, F } = M.cfg;
  const { p, off, buf } = M;
  const dh = d / heads,
    sc = 1 / Math.sqrt(dh);
  const x0 = buf.L[0].x;
  for (let t = 0; t < T; t++) {
    const e0 = off.E + x[t] * d,
      p0 = off.P + t * d;
    for (let e = 0; e < d; e++) x0[t * d + e] = p[e0 + e] + p[p0 + e];
  }
  for (let l = 0; l < off.L.length; l++) {
    const lo = off.L[l],
      B = buf.L[l];
    const out = l + 1 < off.L.length ? buf.L[l + 1].x : buf.xf;
    layerNorm(B.x, B.a, B.mu1, B.rs1, p, lo.g1, lo.b1, T, d);
    matmul(B.q, B.a, p, lo.Wq, -1, T, d, d);
    matmul(B.k, B.a, p, lo.Wk, -1, T, d, d);
    matmul(B.v, B.a, p, lo.Wv, -1, T, d, d);
    B.z.fill(0);
    for (let h = 0; h < heads; h++) {
      const c0 = h * dh;
      for (let t = 0; t < T; t++) {
        const row = (h * T + t) * T;
        let mx = -Infinity;
        for (let j = 0; j <= t; j++) {
          let s = 0;
          for (let c = 0; c < dh; c++) s += B.q[t * d + c0 + c] * B.k[j * d + c0 + c];
          s *= sc;
          B.A[row + j] = s;
          if (s > mx) mx = s;
        }
        let sum = 0;
        for (let j = 0; j <= t; j++) {
          const e = Math.exp(B.A[row + j] - mx);
          B.A[row + j] = e;
          sum += e;
        }
        for (let j = 0; j <= t; j++) {
          const a = (B.A[row + j] /= sum);
          for (let c = 0; c < dh; c++) B.z[t * d + c0 + c] += a * B.v[j * d + c0 + c];
        }
        for (let j = t + 1; j < T; j++) B.A[row + j] = 0;
      }
    }
    matmul(B.xm, B.z, p, lo.Wo, -1, T, d, d);
    for (let i = 0; i < T * d; i++) B.xm[i] += B.x[i];
    layerNorm(B.xm, B.b, B.mu2, B.rs2, p, lo.g2, lo.b2, T, d);
    matmul(B.u, B.b, p, lo.W1, lo.c1, T, d, F);
    for (let i = 0; i < T * F; i++) B.r[i] = B.u[i] > 0 ? B.u[i] : 0;
    matmul(out, B.r, p, lo.W2, lo.c2, T, F, d);
    for (let i = 0; i < T * d; i++) out[i] += B.xm[i];
  }
  layerNorm(buf.xf, buf.f, buf.muf, buf.rsf, p, off.gf, off.bf, T, d);
  matmul(buf.P, buf.f, p, off.U, off.bu, T, d, V);
  for (let t = 0; t < T; t++) {
    const o = t * V;
    let mx = -Infinity;
    for (let v = 0; v < V; v++) if (buf.P[o + v] > mx) mx = buf.P[o + v];
    let sum = 0;
    for (let v = 0; v < V; v++) sum += buf.P[o + v] = Math.exp(buf.P[o + v] - mx);
    for (let v = 0; v < V; v++) buf.P[o + v] /= sum;
  }
}

/** Forward and backward for one sequence: x holds T inputs, y the T next tokens. Adds `scale` times the
 * gradient of the summed cross-entropy to M.g and returns the summed loss. */
export function accumulate(M: Model, x: ArrayLike<number>, y: ArrayLike<number>, scale: number): number {
  const { V, T, d, heads, F } = M.cfg;
  const { p, g, off, buf } = M;
  const dh = d / heads,
    sc = 1 / Math.sqrt(dh);
  forward(M, x);
  let loss = 0;
  const { dlog, dres, dn, dq, dk, dv, dz, du, dA } = buf;
  for (let t = 0; t < T; t++) {
    const o = t * V;
    loss -= Math.log(Math.max(buf.P[o + y[t]], 1e-30));
    for (let v = 0; v < V; v++) dlog[o + v] = buf.P[o + v] * scale;
    dlog[o + y[t]] -= scale;
  }
  matmulBack(dlog, buf.f, p, g, off.U, off.bu, T, d, V, dn, false);
  dres.fill(0);
  layerNormBack(buf.xf, dn, buf.muf, buf.rsf, p, g, off.gf, off.bf, T, d, dres);
  for (let l = off.L.length - 1; l >= 0; l--) {
    const lo = off.L[l],
      B = buf.L[l];
    // MLP: out = xm + relu(LN(xm) W1 + c1) W2 + c2
    matmulBack(dres, B.r, p, g, lo.W2, lo.c2, T, F, d, du, false);
    for (let i = 0; i < T * F; i++) if (B.u[i] <= 0) du[i] = 0;
    matmulBack(du, B.b, p, g, lo.W1, lo.c1, T, d, F, dn, false);
    layerNormBack(B.xm, dn, B.mu2, B.rs2, p, g, lo.g2, lo.b2, T, d, dres);
    // attention: xm = x + z Wo
    matmulBack(dres, B.z, p, g, lo.Wo, -1, T, d, d, dz, false);
    dq.fill(0);
    dk.fill(0);
    dv.fill(0);
    for (let h = 0; h < heads; h++) {
      const c0 = h * dh;
      for (let t = 0; t < T; t++) {
        const row = (h * T + t) * T;
        let dot = 0;
        for (let j = 0; j <= t; j++) {
          const a = B.A[row + j];
          let s = 0;
          for (let c = 0; c < dh; c++) {
            const dzc = dz[t * d + c0 + c];
            s += dzc * B.v[j * d + c0 + c];
            dv[j * d + c0 + c] += a * dzc;
          }
          dA[j] = s;
          dot += a * s;
        }
        for (let j = 0; j <= t; j++) {
          const ds = B.A[row + j] * (dA[j] - dot) * sc;
          if (ds === 0) continue;
          for (let c = 0; c < dh; c++) {
            dq[t * d + c0 + c] += ds * B.k[j * d + c0 + c];
            dk[j * d + c0 + c] += ds * B.q[t * d + c0 + c];
          }
        }
      }
    }
    matmulBack(dq, B.a, p, g, lo.Wq, -1, T, d, d, dn, false);
    matmulBack(dk, B.a, p, g, lo.Wk, -1, T, d, d, dn, true);
    matmulBack(dv, B.a, p, g, lo.Wv, -1, T, d, d, dn, true);
    layerNormBack(B.x, dn, B.mu1, B.rs1, p, g, lo.g1, lo.b1, T, d, dres);
  }
  for (let t = 0; t < T; t++) {
    const e0 = off.E + x[t] * d,
      p0 = off.P + t * d;
    for (let e = 0; e < d; e++) {
      g[e0 + e] += dres[t * d + e];
      g[p0 + e] += dres[t * d + e];
    }
  }
  return loss;
}

/** One Adam update from the gradients in M.g, after clipping their overall size to `clip`. */
export function adam(M: Model, lr: number, clip = 1, b1 = 0.9, b2 = 0.99, eps = 1e-8): void {
  const { p, g, m, s } = M;
  let n2 = 0;
  for (let i = 0; i < g.length; i++) n2 += g[i] * g[i];
  const k = Math.sqrt(n2) > clip ? clip / Math.sqrt(n2) : 1;
  M.t++;
  const a = (lr * Math.sqrt(1 - b2 ** M.t)) / (1 - b1 ** M.t);
  for (let i = 0; i < p.length; i++) {
    const gi = g[i] * k;
    m[i] = b1 * m[i] + (1 - b1) * gi;
    s[i] = b2 * s[i] + (1 - b2) * gi * gi;
    p[i] -= (a * m[i]) / (Math.sqrt(s[i]) + eps);
  }
}

/** A training example: T input tokens and the T tokens that follow them. */
export interface Example {
  x: Int32Array;
  y: Int32Array;
}

/** One training step on a batch: mean cross-entropy per token, then Adam. Returns the mean loss. */
export function trainStep(M: Model, batch: Example[], lr: number): number {
  M.g.fill(0);
  const scale = 1 / (batch.length * M.cfg.T);
  let loss = 0;
  for (const ex of batch) loss += accumulate(M, ex.x, ex.y, scale);
  adam(M, lr);
  return loss * scale;
}

/* ---------- the tasks ---------- */

/** An induction example: a few random filler tokens, then a run of random tokens, then the same run again.
 * The run's length, and so where the repeat starts, changes every time, so the model cannot learn "look n
 * places back". To predict the second copy it has to find the earlier copy of the current token and read
 * the token that came after it. */
export interface InductionExample extends Example {
  /** Where the first copy of the run starts. */
  start: number;
  /** Length of the run. */
  run: number;
}

export function inductionExample(V: number, T: number, rand: () => number, minRun = 4): InductionExample {
  const hi = Math.floor(T / 2),
    lo = Math.min(hi, Math.max(2, minRun));
  const run = lo + Math.floor(rand() * (hi - lo + 1));
  const start = T + 1 - 2 * run;
  const pattern = Array.from({ length: run }, () => Math.floor(rand() * V));
  const seq: number[] = [];
  for (let i = 0; i < start; i++) seq.push(Math.floor(rand() * V));
  seq.push(...pattern, ...pattern);
  return { x: Int32Array.from(seq.slice(0, T)), y: Int32Array.from(seq.slice(1, T + 1)), start, run };
}

/** Positions whose next token can be read off the earlier copy: the current token is in the second copy. */
export function repeatedPositions(ex: InductionExample, T: number): number[] {
  const out: number[] = [];
  for (let t = ex.start + ex.run; t < T; t++) out.push(t);
  return out;
}

/** A window of T + 1 characters from the text, as an example. */
export function textExample(ids: ArrayLike<number>, T: number, at: number): Example {
  const x = new Int32Array(T),
    y = new Int32Array(T);
  for (let t = 0; t < T; t++) {
    x[t] = ids[at + t];
    y[t] = ids[at + t + 1];
  }
  return { x, y };
}

/* ---------- measurements ---------- */

export interface HeadScores {
  /** Mean attention from each position in the second copy to the position after the earlier copy of its token. */
  induction: number[][];
  /** Mean attention from each position to the one just before it. */
  previous: number[][];
}

export interface InductionEval {
  loss: number; // mean over every position
  repeatLoss: number; // mean over the positions in the second copy
  repeatAcc: number; // share of those the model gets right (most likely token)
  scores: HeadScores;
}

/** Measures loss, accuracy on the repeated part and each head's induction and previous-token scores. */
export function evalInduction(M: Model, set: InductionExample[]): InductionEval {
  const { V, T, layers, heads } = M.cfg;
  const zero = () => Array.from({ length: layers }, () => new Array<number>(heads).fill(0));
  const ind = zero(),
    prev = zero();
  let loss = 0,
    rLoss = 0,
    right = 0,
    nRep = 0;
  for (const ex of set) {
    forward(M, ex.x);
    const P = M.buf.P;
    for (let t = 0; t < T; t++) loss -= Math.log(Math.max(P[t * V + ex.y[t]], 1e-30));
    const rep = repeatedPositions(ex, T);
    for (const t of rep) {
      rLoss -= Math.log(Math.max(P[t * V + ex.y[t]], 1e-30));
      let best = 0;
      for (let v = 1; v < V; v++) if (P[t * V + v] > P[t * V + best]) best = v;
      if (best === ex.y[t]) right++;
    }
    nRep += rep.length;
    for (let l = 0; l < layers; l++) {
      const A = M.buf.L[l].A;
      for (let h = 0; h < heads; h++) {
        const base = h * T * T;
        for (const t of rep) ind[l][h] += A[base + t * T + (t - ex.run + 1)] / rep.length / set.length;
        let s = 0;
        for (let t = 1; t < T; t++) s += A[base + t * T + t - 1];
        prev[l][h] += s / (T - 1) / set.length;
      }
    }
  }
  return {
    loss: loss / (set.length * T),
    repeatLoss: rLoss / Math.max(1, nRep),
    repeatAcc: right / Math.max(1, nRep),
    scores: { induction: ind, previous: prev },
  };
}

/** Mean loss per token and each head's previous-token score over a set of examples. */
export function evalText(M: Model, set: Example[]): { loss: number; previous: number[][] } {
  const { V, T, layers, heads } = M.cfg;
  const prev = Array.from({ length: layers }, () => new Array<number>(heads).fill(0));
  let loss = 0;
  for (const ex of set) {
    forward(M, ex.x);
    for (let t = 0; t < T; t++) loss -= Math.log(Math.max(M.buf.P[t * V + ex.y[t]], 1e-30));
    for (let l = 0; l < layers; l++) {
      for (let h = 0; h < heads; h++) {
        let s = 0;
        for (let t = 1; t < T; t++) s += M.buf.L[l].A[h * T * T + t * T + t - 1];
        prev[l][h] += s / (T - 1) / set.length;
      }
    }
  }
  return { loss: loss / (set.length * T), previous: prev };
}

/** Continues a context of T tokens by n more, sampling at the given temperature. */
export function generate(M: Model, context: ArrayLike<number>, n: number, temperature: number, rand: () => number) {
  const { V, T } = M.cfg;
  const win = Array.from(context).slice(-T);
  const out: number[] = [];
  for (let s = 0; s < n; s++) {
    forward(M, win);
    const o = (T - 1) * V,
      w = new Array<number>(V);
    let sum = 0;
    for (let v = 0; v < V; v++) sum += w[v] = Math.pow(M.buf.P[o + v], 1 / Math.max(0.05, temperature));
    let r = rand() * sum,
      pick = V - 1;
    for (let v = 0; v < V; v++)
      if ((r -= w[v]) <= 0) {
        pick = v;
        break;
      }
    out.push(pick);
    win.shift();
    win.push(pick);
  }
  return out;
}

/** Compares backpropagation with central finite differences on a small random model. */
export function gradCheck(seed = 1): { params: number; maxRelError: number; ok: boolean } {
  const rand = seeded(seed);
  const cfg: Config = { V: 5, T: 6, d: 6, layers: 2, heads: 2, F: 8 };
  const M = create(cfg, rand);
  for (let i = 0; i < M.p.length; i++) M.p[i] += 0.2 * gauss(rand); // move away from the start, so nothing is exactly zero
  const set = [0, 1].map(() => inductionExample(cfg.V, cfg.T, rand));
  const lossOf = () => set.reduce((s, ex) => s + accumulate(M, ex.x, ex.y, 0), 0);
  M.g.fill(0);
  for (const ex of set) accumulate(M, ex.x, ex.y, 1);
  const analytic = Float64Array.from(M.g);
  const eps = 1e-5;
  let maxRel = 0;
  for (let i = 0; i < M.p.length; i++) {
    const old = M.p[i];
    M.p[i] = old + eps;
    const lp = lossOf();
    M.p[i] = old - eps;
    const lm = lossOf();
    M.p[i] = old;
    const num = (lp - lm) / (2 * eps),
      a = analytic[i];
    const rel = Math.abs(num - a) / Math.max(1e-7, Math.abs(num) + Math.abs(a));
    if (rel > maxRel) maxRel = rel;
  }
  return { params: M.p.length, maxRelError: maxRel, ok: maxRel < 1e-4 };
}
