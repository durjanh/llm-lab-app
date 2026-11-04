/* Chapters 8 and 9: measuring performance (bias, variance, double descent, high dimensions) and regularisation. */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChapterDef } from './chapters';
import { clamp, fmt, gauss, linspace, mean, rng, useAnimation } from './kit';
import { Chips, Notebook, Readout, Slider } from './Notebook';
import { mix, Plot, type Frame } from './Plot';

// ---------- shared helpers ----------

type Pt = [number, number];

const relu = (v: number) => (v > 0 ? v : 0);

function Legend({ items }: { items: [string, string][] }) {
  return (
    <div className="dl-legend">
      {items.map(([colour, label]) => (
        <span key={label}>
          <i style={{ background: `var(--${colour})` }} />
          {label}
        </span>
      ))}
    </div>
  );
}

/** Fills the area between two curves, such as a ±2σ band, with a translucent colour. */
function band(f: Frame, xs: number[], lo: number[], hi: number[], colour: string, alpha = 0.15) {
  const { ctx } = f;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = colour;
  ctx.beginPath();
  xs.forEach((x, i) => (i ? ctx.lineTo(f.x(x), f.y(hi[i])) : ctx.moveTo(f.x(x), f.y(hi[i]))));
  for (let i = xs.length - 1; i >= 0; i--) ctx.lineTo(f.x(xs[i]), f.y(lo[i]));
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** Draws histogram bars: fractions over equal bins from x0 to x1. */
function bars(f: Frame, x0: number, x1: number, fractions: number[], colour: string) {
  const w = (x1 - x0) / fractions.length;
  f.ctx.fillStyle = colour;
  fractions.forEach((v, i) => {
    const left = f.x(x0 + i * w),
      right = f.x(x0 + (i + 1) * w);
    const top = f.y(v),
      base = f.y(0);
    f.ctx.fillRect(left + 0.5, top, Math.max(1, right - left - 1), base - top);
  });
}

function histogram(values: ArrayLike<number>, x0: number, x1: number, bins: number): number[] {
  const counts = new Array<number>(bins).fill(0);
  for (let i = 0; i < values.length; i++) {
    const k = Math.floor(((values[i] - x0) / (x1 - x0)) * bins);
    if (k >= 0 && k < bins) counts[k]++;
  }
  return counts.map((c) => c / values.length);
}

function shuffle(n: number, r: () => number): number[] {
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** The lower-triangular L with A = L Lᵀ, for a symmetric positive definite A stored row by row (n × n). */
function cholesky(A: Float64Array, n: number): Float64Array {
  const L = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i * n + j];
      for (let k = 0; k < j; k++) s -= L[i * n + k] * L[j * n + k];
      if (i === j) L[i * n + i] = Math.sqrt(Math.max(s, 1e-300));
      else L[i * n + j] = s / L[j * n + j];
    }
  }
  return L;
}

/** Solves L v = b (forward substitution). */
function forwardSub(L: Float64Array, b: ArrayLike<number>, n: number): Float64Array {
  const v = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= L[i * n + k] * v[k];
    v[i] = s / L[i * n + i];
  }
  return v;
}

/** Solves Lᵀ x = v (back substitution). */
function backSub(L: Float64Array, v: ArrayLike<number>, n: number): Float64Array {
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = v[i];
    for (let k = i + 1; k < n; k++) s -= L[k * n + i] * x[k];
    x[i] = s / L[i * n + i];
  }
  return x;
}

const solveSPD = (A: Float64Array, b: ArrayLike<number>, n: number) => {
  const L = cholesky(A, n);
  return backSub(L, forwardSub(L, b, n), n);
};

/**
 * Least squares with an L2 penalty: the w that minimises Σᵢ(Φᵢ·w − yᵢ)² + Σⱼ penⱼ wⱼ². Solved through the normal
 * equations (ΦᵀΦ + diag(pen)) w = Φᵀy. A tiny floor on the penalty keeps the system solvable when the data do not
 * pin down every parameter; then the answer is close to the smallest-norm fit.
 */
function penalisedFit(Phi: Float64Array[], y: number[], pen: (j: number) => number): Float64Array {
  const p = Phi[0].length;
  const A = new Float64Array(p * p),
    b = new Float64Array(p);
  Phi.forEach((row, i) => {
    for (let j = 0; j < p; j++) {
      b[j] += row[j] * y[i];
      for (let k = 0; k <= j; k++) A[j * p + k] += row[j] * row[k];
    }
  });
  for (let j = 0; j < p; j++) {
    for (let k = 0; k < j; k++) A[k * p + j] = A[j * p + k];
    A[j * p + j] += Math.max(pen(j), 1e-9);
  }
  return solveSPD(A, b, p);
}

const dot = (w: ArrayLike<number>, h: ArrayLike<number>) => {
  let s = 0;
  for (let k = 0; k < h.length; k++) s += w[k] * h[k];
  return s;
};

// The 1D regression problem used through both chapters: a smooth wave on [0, 1] plus Gaussian noise.
const truth = (x: number) => Math.sin(2 * Math.PI * x) + 0.4 * x;
const GRID = linspace(0, 1, 101);

/** I training points: one x drawn uniformly in each of I equal slices of [0, 1], and y = truth(x) + noise. */
function sampleData(I: number, sigma: number, r: () => number) {
  const xs = Array.from({ length: I }, (_, i) => (i + r()) / I);
  return { xs, ys: xs.map((x) => truth(x) + sigma * gauss(r)) };
}

/**
 * The simplified shallow network: D ReLU hidden units with fixed joints at 0, 1/D, …, (D − 1)/D, so only the output
 * weights are learned. Its features are [1, relu(x), relu(x − 1/D), …]. The model is linear in its parameters, so
 * least squares fits it in closed form and always finds the global minimum.
 */
function joints(x: number, D: number): Float64Array {
  const h = new Float64Array(D + 1);
  h[0] = 1;
  for (let k = 0; k < D; k++) h[k + 1] = relu(x - k / D);
  return h;
}

function fitJoints(xs: number[], ys: number[], D: number, lambda = 0): Float64Array {
  return penalisedFit(
    xs.map((x) => joints(x, D)),
    ys,
    (j) => (j === 0 ? 0 : lambda),
  );
}

const predictJoints = (w: Float64Array, D: number, xs: number[]) => xs.map((x) => dot(w, joints(x, D)));

/** Mean squared distance from the true function over [0, 1], plus the noise: the expected test error of one fit. */
const testError = (preds: number[], sigma: number) =>
  mean(preds.map((p, i) => (p - truth(GRID[i])) ** 2)) + sigma * sigma;

/**
 * Runs a training loop: `make` builds a fresh state, `step` advances it, `finished` says when to stop. The state
 * starts again whenever one of `deps` changes.
 */
function useTrainer<S>(make: () => S, step: (s: S) => void, finished: (s: S) => boolean, deps: unknown[]) {
  const state = useRef<S | null>(null);
  if (state.current === null) state.current = make();
  const makeRef = useRef(make);
  makeRef.current = make;
  const [, render] = useState(0);
  const [running, setRunning] = useState(false);
  const redraw = () => render((n) => n + 1);

  useAnimation(running, () => {
    const s = state.current as S;
    if (finished(s)) {
      setRunning(false);
      redraw();
      return false;
    }
    step(s);
    redraw();
  });

  const reset = () => {
    setRunning(false);
    state.current = makeRef.current();
    redraw();
  };
  const first = useRef(true);
  useEffect(() => {
    if (first.current) return void (first.current = false);
    reset();
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    s: state.current as S,
    running,
    toggle: () => setRunning((on) => !on && !finished(state.current as S)),
    reset,
  };
}

function RunButtons({ t }: { t: { running: boolean; toggle: () => void; reset: () => void } }) {
  return (
    <>
      <button className="btn primary small" onClick={t.toggle}>
        {t.running ? 'Pause' : 'Train'}
      </button>
      <button className="btn small" onClick={t.reset}>
        Reset
      </button>
    </>
  );
}

// ---------- MNIST-1D-style data ----------

/**
 * Ten 1D shapes, one per class, written for this lab in the spirit of MNIST-1D: a plateau, a spike, ramps, two peaks,
 * a dip, steps, a wave, and a peak then a dip.
 */
const TEMPLATES = [
  [0, 0.6, 1, 1, 1, 1, 1, 1, 1, 1, 0.6, 0],
  [0, 0, 0, 0, 0.3, 1, 1, 0.3, 0, 0, 0, 0],
  [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 0],
  [0, 1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1, 0],
  [0, 1, 1, 0, 0, 0, 0, 0, 0, 1, 1, 0],
  [0, -0.6, -1, -1, -1, -1, -1, -1, -1, -1, -0.6, 0],
  [0, -1, -1, -1, -1, -1, 1, 1, 1, 1, 1, 0],
  [0, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1, 0],
  [0, 1, 0.5, -0.5, -1, -0.5, 0.5, 1, 0.5, -0.5, -1, 0],
  [0, 0.5, 1, 1, 0.5, 0, 0, -0.5, -1, -1, -0.5, 0],
];
const LEN = 40;

/** One example: the class template stretched, scaled and placed at a random offset, sheared, then noised. */
function mnistExample(cls: number, r: () => number, noise: number): Float64Array {
  const t = TEMPLATES[cls];
  const width = 16 + Math.floor(r() * 15);
  const offset = Math.floor(r() * (LEN - width + 1));
  const amp = 0.7 + 0.6 * r();
  const shear = r() - 0.5;
  const freq = 0.5 + r(),
    phase = 2 * Math.PI * r();
  const out = new Float64Array(LEN);
  for (let i = 0; i < LEN; i++) {
    let v = 0;
    const u = ((i - offset) / (width - 1)) * (t.length - 1);
    if (u >= 0 && u <= t.length - 1) {
      const k = Math.min(t.length - 2, Math.floor(u));
      v = amp * (t[k] + (t[k + 1] - t[k]) * (u - k));
    }
    // A slope across the signal, a slow wave (correlated noise) and independent noise at each position.
    out[i] =
      v +
      shear * (i / (LEN - 1) - 0.5) +
      noise * (0.6 * Math.sin((2 * Math.PI * freq * i) / LEN + phase) + 0.4 * gauss(r));
  }
  return out;
}

interface Dataset {
  X: Float64Array[];
  Y: number[];
}

/** n examples with the classes in turn (so every class is equally common). */
function mnistData(n: number, seed: number, noise: number): Dataset {
  const r = rng(seed);
  const X: Float64Array[] = [],
    Y: number[] = [];
  for (let i = 0; i < n; i++) {
    X.push(mnistExample(i % 10, r, noise));
    Y.push(i % 10);
  }
  return { X, Y };
}

// ---------- a small fully connected network with softmax and cross-entropy ----------

interface Net {
  sizes: number[];
  W: Float64Array[];
  b: Float64Array[];
  gW: Float64Array[];
  gb: Float64Array[];
}

/** ReLU layers with He initialisation (weights with variance 2 / fan-in) and zero biases. */
function makeNet(sizes: number[], seed: number): Net {
  const r = rng(seed);
  const W = sizes
    .slice(1)
    .map((out, l) => Float64Array.from({ length: out * sizes[l] }, () => gauss(r) * Math.sqrt(2 / sizes[l])));
  const b = sizes.slice(1).map((out) => new Float64Array(out));
  return { sizes, W, b, gW: W.map((w) => new Float64Array(w.length)), gb: b.map((v) => new Float64Array(v.length)) };
}

function forward(net: Net, x: Float64Array): Float64Array[] {
  const acts = [x];
  const L = net.W.length;
  for (let l = 0; l < L; l++) {
    const fan = net.sizes[l],
      out = net.sizes[l + 1],
      h = acts[l],
      w = net.W[l];
    const z = new Float64Array(out);
    for (let i = 0; i < out; i++) {
      let s = net.b[l][i];
      const o = i * fan;
      for (let j = 0; j < fan; j++) s += w[o + j] * h[j];
      z[i] = l < L - 1 ? relu(s) : s;
    }
    acts.push(z);
  }
  return acts;
}

function probs(z: Float64Array): Float64Array {
  const m = Math.max(...z);
  const p = z.map((v) => Math.exp(v - m));
  const s = p.reduce((a, v) => a + v, 0);
  return p.map((v) => v / s);
}

/** One SGD step on the mean cross-entropy of the examples in `idx`, by backpropagation. */
function sgdStep(net: Net, X: Float64Array[], Y: number[], idx: number[], lr: number) {
  const L = net.W.length;
  net.gW.forEach((g) => g.fill(0));
  net.gb.forEach((g) => g.fill(0));
  for (const n of idx) {
    const acts = forward(net, X[n]);
    let d = probs(acts[L]); // ∂ℓ/∂z for softmax with cross-entropy: p − one-hot(y)
    d[Y[n]] -= 1;
    for (let l = L - 1; l >= 0; l--) {
      const fan = net.sizes[l],
        out = net.sizes[l + 1],
        h = acts[l],
        w = net.W[l],
        gw = net.gW[l];
      const back = new Float64Array(fan);
      for (let i = 0; i < out; i++) {
        const di = d[i];
        if (di === 0) continue;
        net.gb[l][i] += di;
        const o = i * fan;
        for (let j = 0; j < fan; j++) {
          gw[o + j] += di * h[j];
          back[j] += di * w[o + j];
        }
      }
      if (l > 0) {
        for (let j = 0; j < fan; j++) if (h[j] <= 0) back[j] = 0;
        d = back;
      }
    }
  }
  const k = lr / idx.length;
  for (let l = 0; l < L; l++) {
    net.W[l].forEach((_, i) => (net.W[l][i] -= k * net.gW[l][i]));
    net.b[l].forEach((_, i) => (net.b[l][i] -= k * net.gb[l][i]));
  }
}

/** Mean cross-entropy and the fraction of examples classified wrongly. */
function evaluate(net: Net, data: Dataset) {
  let loss = 0,
    wrong = 0;
  data.X.forEach((x, n) => {
    const z = forward(net, x)[net.W.length];
    loss -= Math.log(Math.max(probs(z)[data.Y[n]], 1e-12));
    if (z.indexOf(Math.max(...z)) !== data.Y[n]) wrong++;
  });
  return { loss: loss / data.X.length, err: wrong / data.X.length };
}

/** Runs one epoch of SGD in mini-batches over a shuffled order. */
function epoch(net: Net, data: Dataset, batch: number, lr: number, r: () => number) {
  const order = shuffle(data.X.length, r);
  for (let k = 0; k < order.length; k += batch) sgdStep(net, data.X, data.Y, order.slice(k, k + batch), lr);
}

/* ---------- 8.1 MNIST-1D performance ---------- */

interface History {
  trErr: number[];
  teErr: number[];
  trLoss: number[];
  teLoss: number[];
}

const MN_EPOCHS = 150;

function MnistPerformance() {
  const [noise, setNoise] = useState(0.4);
  const [nTrain, setNTrain] = useState(400);
  const [hidden, setHidden] = useState(32);
  const [cls, setCls] = useState(6);
  const t = useTrainer(
    () => {
      const tr = mnistData(nTrain, 81, noise),
        te = mnistData(500, 82, noise);
      const net = makeNet([LEN, hidden, hidden, 10], 83);
      const a = evaluate(net, tr),
        b = evaluate(net, te);
      const hist: History = { trErr: [a.err], teErr: [b.err], trLoss: [a.loss], teLoss: [b.loss] };
      return { tr, te, net, r: rng(84), hist };
    },
    (s) => {
      epoch(s.net, s.tr, 20, 0.1, s.r);
      const a = evaluate(s.net, s.tr),
        b = evaluate(s.net, s.te);
      s.hist.trErr.push(a.err);
      s.hist.teErr.push(b.err);
      s.hist.trLoss.push(a.loss);
      s.hist.teLoss.push(b.loss);
    },
    (s) => s.hist.trErr.length > MN_EPOCHS,
    [noise, nTrain, hidden],
  );
  const h = t.s.hist;
  const ep = h.trErr.length - 1;
  const bestLoss = h.teLoss.indexOf(Math.min(...h.teLoss));
  const params = LEN * hidden + hidden + hidden * hidden + hidden + hidden * 10 + 10;
  const idx = h.trErr.map((_, i) => i);
  return (
    <Notebook
      id="8.1"
      title="MNIST-1D performance"
      intro={
        <>
          Each example is one of ten 1D shapes, stretched, shifted, scaled and noised, then sampled at 40 positions. A
          network with two hidden layers learns to name the class, trained by SGD on a cross-entropy loss. A separate
          test set, made the same way, shows how well it does on examples it has never seen.
        </>
      }
      tryThis={[
        'Press Train: the training error falls to zero, but the test error stalls far above it.',
        'Watch the test loss: it falls, then climbs while the test error stays flat. The model makes the same mistakes with growing confidence.',
        'Raise the training set size: the test error drops. Raise the noise: it rises, even though the training error still reaches zero.',
      ]}
      takeaway="A model can fit its training data perfectly and still generalise poorly. Only held-out test data measure real performance."
    >
      <div className="dl-controls">
        <Slider label="noise" value={noise} min={0.1} max={0.8} step={0.05} onChange={setNoise} />
        <Slider
          label="training examples"
          value={nTrain}
          min={100}
          max={800}
          step={100}
          onChange={setNTrain}
          show={String}
        />
        <Slider
          label="hidden units per layer"
          value={hidden}
          min={8}
          max={64}
          step={8}
          onChange={setHidden}
          show={String}
        />
        <RunButtons t={t} />
      </div>
      <div className="dl-cols">
        <div>
          <Plot
            x={[0, LEN - 1]}
            y={[-3, 3]}
            height={200}
            xLabel="position"
            yLabel="x"
            ariaLabel="Four training examples of the chosen class"
            draw={(f) => {
              const xs = linspace(0, LEN - 1, LEN);
              const colours = [f.c.s1, f.c.s2, f.c.s3, f.c.s4];
              for (let k = 0; k < 4; k++) f.line(xs, Array.from(t.s.tr.X[cls + 10 * k]), colours[k], 1.5);
            }}
          />
          <div className="dl-controls">
            <Slider label="class" value={cls} min={0} max={9} step={1} onChange={setCls} show={String} />
          </div>
          <div className="dl-caption">
            Four training examples of one class. Their shapes differ in width, position and noise.
          </div>
        </div>
        <Plot
          x={[0, MN_EPOCHS]}
          y={[0, 100]}
          height={200}
          xLabel="epoch"
          yLabel="% wrong"
          ariaLabel="Training and test error against epoch"
          draw={(f) => {
            f.hline(90, f.c.muted);
            f.line(
              idx,
              h.trErr.map((v) => 100 * v),
              f.c.s1,
              2,
            );
            f.line(
              idx,
              h.teErr.map((v) => 100 * v),
              f.c.s2,
              2,
            );
          }}
        />
        <Plot
          x={[0, MN_EPOCHS]}
          y={[0, 3]}
          height={200}
          xLabel="epoch"
          yLabel="cross-entropy"
          ariaLabel="Training and test loss against epoch"
          draw={(f) => {
            f.line(idx, h.trLoss, f.c.s1, 2);
            f.line(idx, h.teLoss, f.c.s2, 2);
            if (ep > 0) f.vline(bestLoss, f.c.s2);
          }}
        />
      </div>
      <Legend
        items={[
          ['s1', 'training set'],
          ['s2', 'test set'],
          ['muted', 'chance (90% wrong)'],
        ]}
      />
      <Readout
        items={[
          ['epoch', ep],
          ['parameters', params],
          ['training error', `${fmt(100 * h.trErr[ep])}%`],
          ['test error', `${fmt(100 * h.teErr[ep])}%`],
          ['test loss', fmt(h.teLoss[ep])],
          ['lowest test loss at epoch', bestLoss],
        ]}
      />
    </Notebook>
  );
}

/* ---------- 8.2 Bias–variance trade-off ---------- */

const BV_R = 100; // training sets per capacity
const BV_DMAX = 14;

interface BVStats {
  mean: number[];
  sd: number[];
  some: number[][];
  bias2: number;
  variance: number;
  measured: number;
}

function biasVariance(I: number, sigma: number, seed: number): BVStats[] {
  const sets = Array.from({ length: BV_R }, (_, k) => sampleData(I, sigma, rng(seed * 7919 + k)));
  const out: BVStats[] = [];
  for (let D = 1; D <= BV_DMAX; D++) {
    const preds = sets.map((d) => predictJoints(fitJoints(d.xs, d.ys, D), D, GRID));
    const m = GRID.map((_, g) => mean(preds.map((p) => p[g])));
    const v = GRID.map((_, g) => mean(preds.map((p) => (p[g] - m[g]) ** 2)));
    // Test error measured directly: fresh noisy test targets at every x, for every fitted model.
    const rt = rng(seed + 31 * D);
    const measured = mean(preds.map((p) => mean(p.map((f, g) => (f - truth(GRID[g]) - sigma * gauss(rt)) ** 2))));
    out.push({
      mean: m,
      sd: v.map(Math.sqrt),
      some: preds.slice(0, 5),
      bias2: mean(m.map((f, g) => (f - truth(GRID[g])) ** 2)),
      variance: mean(v),
      measured,
    });
  }
  return out;
}

function BiasVariance() {
  const [D, setD] = useState(3);
  const [I, setI] = useState(15);
  const [sigma, setSigma] = useState(0.3);
  const [seed, setSeed] = useState(1);
  const stats = useMemo(() => biasVariance(I, sigma, seed), [I, sigma, seed]);
  const data = useMemo(() => sampleData(I, sigma, rng(seed * 7919)), [I, sigma, seed]);
  const s = stats[D - 1];
  const noise = sigma * sigma;
  const totals = stats.map((v) => v.bias2 + v.variance + noise);
  const best = totals.indexOf(Math.min(...totals)) + 1;
  const ds = stats.map((_, i) => i + 1);
  const ymax = Math.max(noise + 0.1, Math.min(Math.max(...totals), 2.5 * Math.min(...totals)));
  return (
    <Notebook
      id="8.2"
      title="Bias–variance trade-off"
      intro={
        <>
          The model is a shallow network whose D hidden units have fixed, evenly spaced joints, so least squares fits it
          exactly. Fit it to {BV_R} different noisy training sets. The average fit f̄(x) misses the true function by the
          bias; the fits scatter around their average by the variance. The expected test error is bias² + variance + σ²,
          where σ² is the noise in the data.
        </>
      }
      tryThis={[
        'Raise the capacity D: the bias falls, but the fits spread out more and the variance rises. The total is lowest in between.',
        'Raise the number of training points: the variance shrinks and the best capacity moves up.',
        'Compare the last two readouts: the test error measured on fresh data matches the sum of the three terms.',
      ]}
      takeaway="For least squares, test error splits exactly into noise, bias and variance. More capacity trades bias for variance; more data lowers the variance."
    >
      <div className="dl-controls">
        <Slider label="hidden units D" value={D} min={1} max={BV_DMAX} step={1} onChange={setD} show={String} />
        <Slider label="training points" value={I} min={6} max={60} step={1} onChange={setI} show={String} />
        <Slider label="noise σ" value={sigma} min={0.05} max={0.6} onChange={setSigma} />
        <button className="btn small" onClick={() => setSeed((v) => v + 1)}>
          New datasets
        </button>
      </div>
      <div className="dl-cols">
        <div>
          <Plot
            x={[0, 1]}
            y={[-2, 2.5]}
            xLabel="x"
            yLabel="y"
            ariaLabel="True function, several fitted models, their mean and a band of two standard deviations"
            draw={(f) => {
              band(
                f,
                GRID,
                s.mean.map((m, i) => m - 2 * s.sd[i]),
                s.mean.map((m, i) => m + 2 * s.sd[i]),
                f.c.s1,
              );
              for (const p of s.some) f.line(GRID, p, f.c.muted, 1);
              f.line(GRID, GRID.map(truth), f.c.ink, 2, [5, 4]);
              f.line(GRID, s.mean, f.c.s1, 2.5);
              f.dots(
                data.xs.map((x, i) => [x, data.ys[i]] as Pt),
                f.c.s2,
                3,
              );
            }}
          />
          <div className="dl-caption">
            Dashed: the true function. Grey: five of the fits. Blue: their average, with ±2 standard deviations shaded.
            Orange: one training set.
          </div>
        </div>
        <div>
          <Plot
            x={[1, BV_DMAX]}
            y={[0, ymax]}
            xLabel="hidden units D"
            yLabel="error"
            ariaLabel="Bias squared, variance, noise and their sum against capacity"
            draw={(f) => {
              f.hline(noise, f.c.muted);
              f.line(
                ds,
                stats.map((v) => v.bias2),
                f.c.s2,
                2,
              );
              f.line(
                ds,
                stats.map((v) => v.variance),
                f.c.s1,
                2,
              );
              f.line(ds, totals, f.c.ink, 2.5);
              f.dots(
                stats.map((v, i) => [i + 1, v.measured] as Pt),
                f.c.s3,
                3,
              );
              f.vline(D, f.c.muted, [2, 3]);
            }}
          />
          <Legend
            items={[
              ['s2', 'bias²'],
              ['s1', 'variance'],
              ['muted', 'noise σ²'],
              ['ink', 'sum'],
              ['s3', 'measured test error'],
            ]}
          />
        </div>
      </div>
      <Readout
        items={[
          ['bias²', fmt(s.bias2)],
          ['variance', fmt(s.variance)],
          ['noise σ²', fmt(noise)],
          ['bias² + variance + σ²', fmt(s.bias2 + s.variance + noise)],
          ['measured test error', fmt(s.measured)],
          ['best capacity', best],
        ]}
      />
    </Notebook>
  );
}

/* ---------- 8.3 Double descent ---------- */

// A random-features network: P hidden ReLU units whose input weights are random and fixed, so only the output layer is
// learned, by least squares onto one-hot targets. Model size is then easy to vary and every fit is exact.
const DD_N = 100; // training examples
const DD_TEST = 300;
const DD_PMAX = 300;
const DD_PS = Array.from({ length: DD_PMAX / 2 }, (_, i) => 2 * (i + 1));

interface DDData {
  H: Float64Array[]; // hidden activations of the training examples, all DD_PMAX units
  T: Float64Array[]; // and of the test examples
  G: Float64Array; // HᵀH, DD_PMAX × DD_PMAX
  yTrain: number[];
  yTest: number[];
  flipU: number[]; // per training example: a uniform number and a random label, for label noise
  flipTo: number[];
}

let ddCache: DDData | null = null;

/** Builds the data and the random hidden layer once, the first time the notebook draws. */
function ddData(): DDData {
  if (ddCache) return ddCache;
  const tr = mnistData(DD_N, 831, 0.3),
    te = mnistData(DD_TEST, 832, 0.3);
  const r = rng(833);
  const W = Array.from({ length: DD_PMAX }, () => Float64Array.from({ length: LEN }, () => gauss(r) / Math.sqrt(LEN)));
  const b = Array.from({ length: DD_PMAX }, () => 0.5 * gauss(r));
  const hidden = (x: Float64Array) => Float64Array.from({ length: DD_PMAX }, (_, j) => relu(dot(W[j], x) + b[j]));
  const H = tr.X.map(hidden),
    T = te.X.map(hidden);
  const G = new Float64Array(DD_PMAX * DD_PMAX);
  for (const h of H)
    for (let j = 0; j < DD_PMAX; j++) for (let k = 0; k < DD_PMAX; k++) G[j * DD_PMAX + k] += h[j] * h[k];
  ddCache = {
    H,
    T,
    G,
    yTrain: tr.Y,
    yTest: te.Y,
    flipU: tr.Y.map(() => r()),
    flipTo: tr.Y.map(() => Math.floor(r() * 10)),
  };
  return ddCache;
}

interface DDPoint {
  train: number;
  test: number;
  wrong: number;
  norm: number;
}

/**
 * Fits the output weights for every even P from 2 to DD_PMAX, using the first P hidden units scaled by 1/√P, and
 * measures each fit. Below n it solves the P × P normal equations; from n up it uses the n × n system for the fit with
 * the smallest weights, w = Φᵀ(ΦΦᵀ + λI)⁻¹Y, which interpolates the training data when λ = 0.
 */
function ddSweep(labelNoise: number, lambda: number): DDPoint[] {
  const d = ddData();
  const n = DD_N,
    C = 10,
    lam = Math.max(lambda, 1e-10);
  const labels = d.yTrain.map((y, i) => (d.flipU[i] < labelNoise ? d.flipTo[i] : y));
  const Y = labels.map((y) => Array.from({ length: C }, (_, c) => (c === y ? 1 : 0)));
  const S = new Float64Array(n * n); // running Σⱼ hⱼhⱼᵀ between training examples
  const ST = new Float64Array(DD_TEST * n); // and between test and training examples
  const out: DDPoint[] = [];
  let done = 0;
  for (const P of DD_PS) {
    for (; done < P; done++) {
      for (let a = 0; a < n; a++) {
        const ha = d.H[a][done];
        if (ha === 0) continue;
        for (let b = 0; b < n; b++) S[a * n + b] += ha * d.H[b][done];
        for (let t = 0; t < DD_TEST; t++) ST[t * n + a] += d.T[t][done] * ha;
      }
    }
    let predTrain: number[][],
      predTest: number[][],
      norm2 = 0;
    if (P < n) {
      const A = new Float64Array(P * P);
      for (let j = 0; j < P; j++) {
        for (let k = 0; k < P; k++) A[j * P + k] = d.G[j * DD_PMAX + k] / P;
        A[j * P + j] += lam;
      }
      const L = cholesky(A, P);
      const w = Array.from({ length: C }, (_, c) => {
        const rhs = Float64Array.from(
          { length: P },
          (_, j) => mean(d.H.map((h, i) => h[j] * Y[i][c])) * (n / Math.sqrt(P)),
        );
        return backSub(L, forwardSub(L, rhs, P), P);
      });
      w.forEach((v) => (norm2 += dot(v, v)));
      const apply = (h: Float64Array) => w.map((v) => dot(v, h.subarray(0, P)) / Math.sqrt(P));
      [predTrain, predTest] = [d.H.map(apply), d.T.map(apply)];
    } else {
      const K = S.map((v) => v / P);
      for (let a = 0; a < n; a++) K[a * n + a] += lam;
      const L = cholesky(K, n);
      const alpha = Array.from({ length: C }, (_, c) =>
        backSub(
          L,
          forwardSub(
            L,
            Y.map((y) => y[c]),
            n,
          ),
          n,
        ),
      );
      const Kfit = S.map((v) => v / P);
      predTrain = Y.map((_, a) => alpha.map((al) => dot(Kfit.subarray(a * n, a * n + n), al)));
      predTest = d.yTest.map((_, t) => alpha.map((al) => dot(ST.subarray(t * n, t * n + n), al) / P));
      // ‖w‖² = αᵀ ΦΦᵀ α for each output.
      alpha.forEach((al) => al.forEach((v, a) => (norm2 += v * dot(Kfit.subarray(a * n, a * n + n), al))));
    }
    const sq = (p: number[], y: number) => p.reduce((s, v, c) => s + (v - (c === y ? 1 : 0)) ** 2, 0);
    out.push({
      train: mean(predTrain.map((p, i) => sq(p, labels[i]))),
      test: mean(predTest.map((p, t) => sq(p, d.yTest[t]))),
      wrong: mean(predTest.map((p, t) => (p.indexOf(Math.max(...p)) === d.yTest[t] ? 0 : 1))),
      norm: Math.sqrt(norm2),
    });
  }
  return out;
}

function DoubleDescent() {
  const [P, setP] = useState(DD_N);
  const [labelNoise, setLabelNoise] = useState(0.15);
  const [logLam, setLogLam] = useState(-8);
  const lambda = logLam <= -8 ? 0 : 10 ** logLam;
  const sweep = useMemo(() => ddSweep(labelNoise, lambda), [labelNoise, lambda]);
  const now = sweep[P / 2 - 1];
  const lg = (v: number) => Math.log10(Math.max(v, 1e-4));
  const peak = DD_PS[sweep.reduce((b, s, i) => (s.test > sweep[b].test ? i : b), 0)];
  const best = (from: number, to: number) =>
    Math.min(...sweep.filter((_, i) => DD_PS[i] >= from && DD_PS[i] <= to).map((s) => s.wrong));
  return (
    <Notebook
      id="8.3"
      title="Double descent"
      intro={
        <>
          A network with P hidden ReLU units classifies {DD_N} MNIST-1D-style training examples. The input weights are
          random and fixed; only the output layer is fitted, by least squares onto one-hot targets. When P exceeds the
          number of examples n, many weight settings fit the data exactly; the fit chosen is the one with the smallest
          weights. Some training labels are randomised, as in the book.
        </>
      }
      tryThis={[
        'Move P up from 2: the test error first falls, then shoots up as P nears n = 100, then falls again beyond it.',
        'At P = n the model has just enough parameters to fit every training label, including the wrong ones, and needs huge weights to do it (right plot).',
        'Set the label noise to 0: the peak shrinks but does not vanish. Give λ a small value such as 1e-3: the peak disappears.',
      ]}
      takeaway="Test error can fall, rise near the interpolation threshold, then fall again as parameters increase. Past the threshold, the fit with the smallest weights needs less contortion; a little L2 regularisation removes the peak."
    >
      <div className="dl-controls">
        <Slider label="hidden units P" value={P} min={2} max={DD_PMAX} step={2} onChange={setP} show={String} />
        <Slider
          label="training labels randomised"
          value={labelNoise}
          min={0}
          max={0.3}
          step={0.05}
          onChange={setLabelNoise}
          show={(v) => `${Math.round(v * 100)}%`}
        />
        <Slider
          label="L2 strength λ"
          value={logLam}
          min={-8}
          max={-1}
          step={0.5}
          onChange={setLogLam}
          show={(v) => (v <= -8 ? '0' : `1e${v}`)}
        />
      </div>
      <div className="dl-cols">
        <div>
          <Plot
            x={[0, DD_PMAX]}
            y={[-3, 3]}
            xLabel="hidden units P"
            yLabel="log₁₀ squared error"
            ariaLabel="Training and test squared error against the number of hidden units"
            draw={(f) => {
              f.vline(DD_N, f.c.ink);
              f.vline(P, f.c.muted, [2, 3]);
              f.line(
                DD_PS,
                sweep.map((s) => lg(s.train)),
                f.c.s1,
                2,
              );
              f.line(
                DD_PS,
                sweep.map((s) => lg(s.test)),
                f.c.s2,
                2.5,
              );
              f.text('P = n', DD_N + 4, 2.6, f.c.ink2);
            }}
          />
          <Legend
            items={[
              ['s1', 'training error'],
              ['s2', 'test error'],
              ['ink', 'P = n'],
            ]}
          />
        </div>
        <div>
          <Plot
            x={[0, DD_PMAX]}
            y={[0, 100]}
            xLabel="hidden units P"
            yLabel="% test examples wrong"
            ariaLabel="Test classification error against the number of hidden units"
            draw={(f) => {
              f.hline(90, f.c.muted);
              f.vline(DD_N, f.c.ink);
              f.vline(P, f.c.muted, [2, 3]);
              f.line(
                DD_PS,
                sweep.map((s) => 100 * s.wrong),
                f.c.s2,
                2,
              );
            }}
          />
          <div className="dl-caption">Classification error on the test set. The dashed line is chance.</div>
        </div>
        <div>
          <Plot
            x={[0, DD_PMAX]}
            y={[0, 4]}
            xLabel="hidden units P"
            yLabel="log₁₀ ‖w‖"
            ariaLabel="Size of the fitted output weights against the number of hidden units"
            draw={(f) => {
              f.vline(DD_N, f.c.ink);
              f.vline(P, f.c.muted, [2, 3]);
              f.line(
                DD_PS,
                sweep.map((s) => Math.log10(Math.max(s.norm, 1))),
                f.c.s4,
                2,
              );
            }}
          />
          <div className="dl-caption">Size of the output weights. Fitting exactly at P = n takes enormous weights.</div>
        </div>
      </div>
      <Readout
        items={[
          ['hidden units P', P],
          ['training error', fmt(now.train)],
          ['test error', fmt(now.test)],
          ['test examples wrong', `${fmt(100 * now.wrong)}%`],
          ['highest test error at P =', peak],
          ['best % wrong, P < n / P > n', `${fmt(100 * best(2, DD_N - 2))} / ${fmt(100 * best(DD_N + 2, DD_PMAX))}`],
        ]}
      />
    </Notebook>
  );
}

/* ---------- 8.4 High-dimensional spaces ---------- */

/** ln Γ(z), by the Lanczos approximation. */
function lgamma(z: number): number {
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61503916999185,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  const zz = z - 1;
  let x = c[0];
  for (let i = 1; i < 9; i++) x += c[i] / (zz + i);
  const t = zz + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (zz + 0.5) * Math.log(t) - t + Math.log(x);
}

/** log₁₀ of the volume of a D-dimensional ball of radius r: r^D π^(D/2) / Γ(D/2 + 1). */
const log10BallVolume = (D: number, r: number) =>
  (D * Math.log(r) + (D / 2) * Math.log(Math.PI) - lgamma(D / 2 + 1)) / Math.LN10;

const HD_N = 150;

function highDim(D: number) {
  const r = rng(84 + D);
  const g = Array.from({ length: HD_N }, () => Float64Array.from({ length: D }, () => gauss(r)));
  const u = Array.from({ length: HD_N }, () => Float64Array.from({ length: D }, () => r()));
  const norms = g.map((v) => Math.sqrt(dot(v, v)));
  const cos: number[] = [];
  let near = Infinity,
    far = 0;
  for (let i = 0; i < HD_N; i++) {
    for (let j = i + 1; j < HD_N; j++) {
      cos.push(dot(g[i], g[j]) / (norms[i] * norms[j]));
      let d2 = 0;
      for (let k = 0; k < D; k++) d2 += (u[i][k] - u[j][k]) ** 2;
      near = Math.min(near, d2);
      far = Math.max(far, d2);
    }
  }
  const scaled = norms.map((v) => v / Math.sqrt(D));
  const sdCos = Math.sqrt(mean(cos.map((c) => c * c)));
  return { scaled, cos, ratio: Math.sqrt(near / far), meanNorm: mean(scaled), sdCos };
}

function HighDimensional() {
  const [e, setE] = useState(1);
  const [shell, setShell] = useState(0.01);
  const D = Math.round(10 ** e);
  const h = useMemo(() => highDim(D), [D]);
  const normHist = histogram(h.scaled, 0, 2.5, 50);
  const cosHist = histogram(h.cos, -1, 1, 50);
  const dims = Array.from({ length: 1000 }, (_, i) => i + 1);
  const shellFrac = (d: number) => 1 - (1 - shell) ** d;
  const volDims = Array.from({ length: 60 }, (_, i) => i + 1);
  return (
    <Notebook
      id="8.4"
      title="High-dimensional spaces"
      intro={
        <>
          Pictures in two dimensions mislead about spaces with hundreds. Draw {HD_N} points from a standard normal
          distribution in D dimensions, and {HD_N} more uniformly in the unit hypercube. Then compare their lengths, the
          angles between them and the distances between them, and see where the volume of a ball lies.
        </>
      }
      tryThis={[
        'Raise D: the lengths ‖x‖/√D bunch up around 1. Almost no sample lies near the mean, the most likely point.',
        'Watch the angles: in high dimensions almost every pair of random vectors is close to perpendicular (cosine near 0).',
        'At D = 1000 the nearest and furthest pairs of points in the cube are nearly the same distance apart.',
        'Set the shell to 1%: by D = 300 most of a ball’s volume lies in that thin outer layer.',
      ]}
      takeaway="In high dimensions distances concentrate, random directions are nearly orthogonal, and volume sits near the surface. Data are always sparse there."
    >
      <div className="dl-controls">
        <Slider label="dimensions D" value={e} min={0} max={3} step={0.05} onChange={setE} show={() => String(D)} />
        <Slider
          label="outer shell"
          value={shell}
          min={0.01}
          max={0.2}
          step={0.01}
          onChange={setShell}
          show={(v) => `${Math.round(v * 100)}%`}
        />
      </div>
      <div className="dl-cols">
        <div>
          <Plot
            x={[0, 2.5]}
            y={[0, Math.max(0.1, ...normHist) * 1.1]}
            height={190}
            xLabel="‖x‖ / √D"
            yLabel="fraction"
            ariaLabel="Histogram of the lengths of normal samples divided by the square root of D"
            draw={(f) => bars(f, 0, 2.5, normHist, f.c.s1)}
          />
          <div className="dl-caption">Lengths of normal samples, scaled by √D.</div>
        </div>
        <div>
          <Plot
            x={[-1, 1]}
            y={[0, Math.max(0.1, ...cosHist) * 1.1]}
            height={190}
            xLabel="cos θ"
            yLabel="fraction"
            ariaLabel="Histogram of the cosine of the angle between pairs of normal samples"
            draw={(f) => bars(f, -1, 1, cosHist, f.c.s3)}
          />
          <div className="dl-caption">Cosine of the angle between each pair of normal samples.</div>
        </div>
        <div>
          <Plot
            x={[0, 1000]}
            y={[0, 1]}
            height={190}
            xLabel="D"
            yLabel="fraction of volume"
            ariaLabel="Fraction of a ball's volume in its outer shell against dimension"
            draw={(f) => {
              f.line(dims, dims.map(shellFrac), f.c.s2, 2);
              f.dots([[D, shellFrac(D)]], f.c.ink, 4);
            }}
          />
          <div className="dl-caption">Share of a ball’s volume in its outer shell: 1 − (1 − shell)^D.</div>
        </div>
        <div>
          <Plot
            x={[1, 60]}
            y={[-30, 0]}
            height={190}
            xLabel="D"
            yLabel="log₁₀ volume"
            ariaLabel="Log volume of a ball of diameter one against dimension"
            draw={(f) => {
              f.line(
                volDims,
                volDims.map((d) => log10BallVolume(d, 0.5)),
                f.c.s5,
                2,
              );
              if (D <= 60) f.dots([[D, log10BallVolume(D, 0.5)]], f.c.ink, 4);
            }}
          />
          <div className="dl-caption">
            A ball of diameter 1 fits inside the unit cube, but its volume heads to zero.
          </div>
        </div>
      </div>
      <Readout
        items={[
          ['dimensions', D],
          ['mean ‖x‖ / √D', fmt(h.meanNorm)],
          ['spread of cos θ (≈ 1/√D)', fmt(h.sdCos)],
          ['nearest ÷ furthest distance (cube)', fmt(h.ratio)],
          ['volume of diameter-1 ball', fmt(10 ** log10BallVolume(D, 0.5))],
          [`volume in outer ${Math.round(shell * 100)}%`, `${fmt(100 * shellFrac(D))}%`],
        ]}
      />
    </Notebook>
  );
}

/* ---------- 9.1 L2 regularisation ---------- */

/** A loss surface on a grid, stored as log-scaled values from 0 (lowest) to 1 (highest), and where its lowest cell is. */
interface Grid {
  n: number;
  xr: [number, number];
  yr: [number, number];
  t: Float32Array;
  min: Pt;
}

function makeGrid(loss: (a: number, b: number) => number, xr: [number, number], yr: [number, number], n = 60): Grid {
  const raw = new Float32Array(n * n);
  let best = Infinity,
    min: Pt = [0, 0];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const a = xr[0] + ((i + 0.5) / n) * (xr[1] - xr[0]);
      const b = yr[0] + ((j + 0.5) / n) * (yr[1] - yr[0]);
      const v = loss(a, b);
      if (v < best) [best, min] = [v, [a, b]];
      raw[j * n + i] = Math.log(v + 1e-3);
    }
  }
  let lo = Infinity,
    hi = -Infinity;
  for (const v of raw) [lo, hi] = [Math.min(lo, v), Math.max(hi, v)];
  return { n, xr, yr, t: raw.map((v) => (v - lo) / (hi - lo || 1)), min };
}

/** Draws the grid in bands, so the bands read as contours: low loss dark blue, high loss pale. */
function drawGrid(f: Frame, g: Grid) {
  const levels = 16;
  const palette = Array.from({ length: levels }, (_, k) => mix(f.c.s1, f.c.surface, 0.08 + (0.9 * k) / (levels - 1)));
  f.heat((a, b) => {
    const i = clamp(Math.floor(((a - g.xr[0]) / (g.xr[1] - g.xr[0])) * g.n), 0, g.n - 1);
    const j = clamp(Math.floor(((b - g.yr[0]) / (g.yr[1] - g.yr[0])) * g.n), 0, g.n - 1);
    return palette[Math.min(levels - 1, Math.floor(g.t[j * g.n + i] * levels))];
  }, 60);
}

function drawPath(f: Frame, path: Pt[], colour: string, width = 2, dash: number[] = []) {
  if (!path.length) return;
  f.line(
    path.map((p) => p[0]),
    path.map((p) => p[1]),
    colour,
    width,
    dash,
  );
  f.dots([path[path.length - 1]], colour, 4);
}

const gabor = (a: number, b: number, x: number) => {
  const u = a + 0.06 * b * x;
  return Math.sin(u) * Math.exp((-u * u) / 32);
};

const GAB = (() => {
  const r = rng(91);
  const xs = Array.from({ length: 30 }, () => -15 + 30 * r());
  const ys = xs.map((x) => gabor(-0.6, 15.5, x) + 0.1 * gauss(r));
  return { xs, ys };
})();
const GAB_X: [number, number] = [-10, 10];
const GAB_Y: [number, number] = [2.5, 22.5];
const GAB_C: Pt = [0, 12.5]; // where the regulariser prefers the parameters to be

const gabData = (a: number, b: number) => GAB.xs.reduce((s, x, i) => s + (gabor(a, b, x) - GAB.ys[i]) ** 2, 0);
const gabReg = (a: number, b: number) => (a - GAB_C[0]) ** 2 + (b - GAB_C[1]) ** 2;

function gabDescent(start: Pt, lambda: number): Pt[] {
  const loss = (a: number, b: number) => gabData(a, b) + lambda * gabReg(a, b);
  const path: Pt[] = [start];
  let [a, b] = start;
  const h = 1e-5;
  for (let t = 0; t < 300; t++) {
    const ga = (loss(a + h, b) - loss(a - h, b)) / (2 * h);
    const gb = (loss(a, b + h) - loss(a, b - h)) / (2 * h);
    [a, b] = [a - 0.1 * ga, b - 0.1 * gb];
    path.push([a, b]);
  }
  return path;
}

const L2 = (() => {
  const r = rng(912);
  return sampleData(15, 0.3, r);
})();
const L2_D = 14;
const L2_LOGS = linspace(-6, 1, 57);

function L2Regularisation() {
  const [lamG, setLamG] = useState(0);
  const [start, setStart] = useState<Pt>([2.6, 8.5]);
  const [logLam, setLogLam] = useState(-6);
  const grid = useMemo(() => makeGrid((a, b) => gabData(a, b) + lamG * gabReg(a, b), GAB_X, GAB_Y), [lamG]);
  const path = useMemo(() => gabDescent(start, lamG), [start, lamG]);
  const end = path[path.length - 1];
  const gx = linspace(-15, 15, 200);

  const lam = 10 ** logLam;
  const w = fitJoints(L2.xs, L2.ys, L2_D, lam);
  const preds = predictJoints(w, L2_D, GRID);
  const sweep = useMemo(
    () =>
      L2_LOGS.map((lg) => {
        const v = fitJoints(L2.xs, L2.ys, L2_D, 10 ** lg);
        const train = mean(predictJoints(v, L2_D, L2.xs).map((p, i) => (p - L2.ys[i]) ** 2));
        return { train, test: testError(predictJoints(v, L2_D, GRID), 0.3) };
      }),
    [],
  );
  const now = sweep[Math.round((logLam + 6) * 8)];
  const bestLog = L2_LOGS[sweep.reduce((b, s, i) => (s.test < sweep[b].test ? i : b), 0)];
  return (
    <Notebook
      id="9.1"
      title="L2 regularisation"
      intro={
        <>
          Add a penalty to the loss: L′[φ] = L[φ] + λ·g[φ]. With an L2 penalty, g is a sum of squared parameters (here,
          on the left, squared distance from a preferred point). It acts as a prior that favours some parameters over
          others. On the left it reshapes the loss surface of a two-parameter Gabor model. On the right it smooths the
          fit of a network with 14 hidden units to 15 points.
        </>
      }
      tryThis={[
        'With λ = 0, press nothing: gradient descent from the default start gets stuck in a local minimum. Raise λ to about 1.5 and it reaches the main valley.',
        'At large λ the minimum is pulled towards the preferred point (+), so the fit to the data gets worse: the regulariser adds bias.',
        'On the right, with tiny λ the curve passes through every point. Raise λ: it smooths out, and the test error falls before rising again.',
      ]}
      takeaway="L2 regularisation trades fit to the training data for smaller, smoother solutions. A moderate λ lowers the variance more than it adds bias."
    >
      <div className="dl-controls">
        <Slider label="λ on the Gabor loss" value={lamG} min={0} max={3} step={0.05} onChange={setLamG} />
        <Slider label="log₁₀ λ on the network" value={logLam} min={-6} max={1} step={0.125} onChange={setLogLam} />
      </div>
      <div className="dl-cols">
        <div>
          <Plot
            x={GAB_X}
            y={GAB_Y}
            xLabel="φ₀"
            yLabel="φ₁"
            ariaLabel="Regularised loss surface of the Gabor model with a gradient descent path"
            onDrag={(a, b, phase) => phase === 'start' && setStart([a, b])}
            draw={(f) => {
              drawGrid(f, grid);
              f.text('+', GAB_C[0], GAB_C[1] - 0.4, f.c.ink, 'center');
              f.dots([grid.min], f.c.s3, 5);
              drawPath(f, path, f.c.s2);
              f.dots([start], f.c.ink, 3);
            }}
          />
          <div className="dl-caption">
            Drag to choose a start. Green: the lowest point of the surface; orange: gradient descent.
          </div>
        </div>
        <Plot
          x={[-15, 15]}
          y={[-1.2, 1.2]}
          xLabel="x"
          yLabel="y"
          ariaLabel="Gabor data and the model where gradient descent ended"
          draw={(f) => {
            f.line(
              gx,
              gx.map((x) => gabor(end[0], end[1], x)),
              f.c.s2,
              2.5,
            );
            f.dots(
              GAB.xs.map((x, i) => [x, GAB.ys[i]] as Pt),
              f.c.ink,
              3,
            );
          }}
        />
        <div>
          <Plot
            x={[0, 1]}
            y={[-2, 2.5]}
            xLabel="x"
            yLabel="y"
            ariaLabel="Network with 14 hidden units fitted with the chosen L2 strength"
            draw={(f) => {
              f.line(GRID, GRID.map(truth), f.c.ink, 1.5, [5, 4]);
              f.line(GRID, preds, f.c.s1, 2.5);
              f.dots(
                L2.xs.map((x, i) => [x, L2.ys[i]] as Pt),
                f.c.s2,
                3.5,
              );
            }}
          />
          <div className="dl-caption">The fitted network (blue), the true function (dashed) and the training data.</div>
        </div>
        <div>
          <Plot
            x={[-6, 1]}
            y={[0, 0.8]}
            xLabel="log₁₀ λ"
            yLabel="mean squared error"
            ariaLabel="Training and test error against the L2 strength"
            draw={(f) => {
              f.line(
                L2_LOGS,
                sweep.map((s) => s.train),
                f.c.s1,
                2,
              );
              f.line(
                L2_LOGS,
                sweep.map((s) => s.test),
                f.c.s2,
                2,
              );
              f.vline(logLam, f.c.muted, [2, 3]);
            }}
          />
          <Legend
            items={[
              ['s1', 'training error'],
              ['s2', 'expected test error'],
            ]}
          />
        </div>
      </div>
      <Readout
        items={[
          ['Gabor: data loss at end', fmt(gabData(...end))],
          ['Gabor: end point', `${fmt(end[0])}, ${fmt(end[1])}`],
          ['network: training error', fmt(now.train)],
          ['network: test error', fmt(now.test)],
          ['network: best log₁₀ λ', fmt(bestLog)],
        ]}
      />
    </Notebook>
  );
}

/* ---------- 9.2 Implicit regularisation ---------- */

// A two-layer linear network with one unit in each layer: f[x, φ] = φ₁·φ₀·x. Every pair with φ₀φ₁ equal to the best
// slope fits equally well, so the minima form a curved valley. The valley is flattest where φ₀ = φ₁.
const IR = (() => {
  const I = 24,
    r = rng(92);
  const xs = Array.from({ length: I }, (_, i) => 0.2 + (1.2 * (i + r())) / I);
  const ys = xs.map((x) => 1.2 * x + 0.3 * gauss(r));
  return { I, xs, ys, m2: mean(xs.map((x) => x * x)) };
})();
const IR_BATCHES = [1, 2, 3, 4, 6, 8, 12, 24];
const IR_R: [number, number] = [-0.2, 3];
const IR_STEPS = 100;
const SGD_STEPS = 2000;

/** dL/d(φ₀φ₁) for each example: gᵢ = 2(φ₀φ₁xᵢ − yᵢ)xᵢ. The gradient of the mean loss is ḡ·(φ₁, φ₀). */
const irG = (a: number, b: number, i: number) => 2 * (a * b * IR.xs[i] - IR.ys[i]) * IR.xs[i];

type IRKind = 'L' | 'gd' | 'sgd';

/**
 * The loss, and the modified losses whose continuous gradient flow follows gradient descent (L + α/4·|∇L|²) and the
 * average path of SGD (adding α/4 times the expected squared difference between a batch gradient and the full one).
 * For a random batch of m from I examples that expectation is (I − m)/(m(I − 1)) times the variance of the
 * per-example gradients.
 */
function irLoss(kind: IRKind, a: number, b: number, alpha: number, m: number): number {
  let L = 0,
    g = 0;
  for (let i = 0; i < IR.I; i++) {
    L += (a * b * IR.xs[i] - IR.ys[i]) ** 2;
    g += irG(a, b, i);
  }
  L /= IR.I;
  g /= IR.I;
  const norm = a * a + b * b;
  if (kind === 'L') return L;
  const gd = (alpha / 4) * g * g * norm;
  if (kind === 'gd') return L + gd;
  let v = 0;
  for (let i = 0; i < IR.I; i++) v += (irG(a, b, i) - g) ** 2;
  v /= IR.I;
  return L + gd + (alpha / 4) * norm * v * ((IR.I - m) / (m * (IR.I - 1)));
}

/** Gradient flow (tiny Euler steps) on one of the losses, for the time that `steps` steps of size α would take. */
function flow(kind: IRKind, start: Pt, alpha: number, m: number, steps: number, sub: number): Pt[] {
  const dt = alpha / sub,
    h = 1e-5;
  const loss = (a: number, b: number) => irLoss(kind, a, b, alpha, m);
  let [a, b] = start;
  const path: Pt[] = [start];
  for (let t = 0; t < steps * sub; t++) {
    const ga = (loss(a + h, b) - loss(a - h, b)) / (2 * h);
    const gb = (loss(a, b + h) - loss(a, b - h)) / (2 * h);
    [a, b] = [a - dt * ga, b - dt * gb];
    if (t % sub === sub - 1) path.push([a, b]);
  }
  return path;
}

function discreteGD(start: Pt, alpha: number): Pt[] {
  const all = Array.from({ length: IR.I }, (_, i) => i);
  return sgdPath(start, alpha, () => all, IR_STEPS);
}

function sgdPath(start: Pt, alpha: number, batch: () => number[], steps: number, path: Pt[] = [start]): Pt[] {
  let [a, b] = path[path.length - 1];
  for (let t = 0; t < steps; t++) {
    const idx = batch();
    const g = mean(idx.map((i) => irG(a, b, i)));
    [a, b] = [a - alpha * g * b, b - alpha * g * a];
    path.push([a, b]);
  }
  return path;
}

function ImplicitRegularisation() {
  const [alpha, setAlpha] = useState(0.1);
  const [bi, setBi] = useState(0);
  const [kind, setKind] = useState<IRKind>('sgd');
  const [start, setStart] = useState<Pt>([0.1, 2.6]);
  const m = IR_BATCHES[bi];
  const grid = useMemo(() => makeGrid((a, b) => irLoss(kind, a, b, alpha, m), IR_R, IR_R, 56), [kind, alpha, m]);
  const paths = useMemo(
    () => ({
      flowL: flow('L', start, alpha, m, IR_STEPS, 10),
      gd: discreteGD(start, alpha),
      flowGD: flow('gd', start, alpha, m, IR_STEPS, 10),
      flowSGD: flow('sgd', start, alpha, m, SGD_STEPS, 4),
    }),
    [start, alpha, m],
  );
  const t = useTrainer(
    () => ({ path: [start] as Pt[], r: rng(921), order: [] as number[], pos: IR.I }),
    (s) => {
      sgdPath(
        start,
        alpha,
        () => {
          if (s.pos + m > IR.I) [s.order, s.pos] = [shuffle(IR.I, s.r), 0];
          s.pos += m;
          return s.order.slice(s.pos - m, s.pos);
        },
        20,
        s.path,
      );
    },
    (s) => {
      const [a, b] = s.path[s.path.length - 1];
      return s.path.length > SGD_STEPS || !(Math.abs(a) + Math.abs(b) < 20);
    },
    [start, alpha, m],
  );
  const rows: [string, string, Pt][] = [
    ['s1', 'gradient flow on L', paths.flowL[paths.flowL.length - 1]],
    ['s2', `gradient descent, α = ${alpha}`, paths.gd[paths.gd.length - 1]],
    ['s4', 'gradient flow on L + α/4·|∇L|²', paths.flowGD[paths.flowGD.length - 1]],
    ['s5', `SGD, batch ${m}, after ${t.s.path.length - 1} steps`, t.s.path[t.s.path.length - 1]],
    ['s3', 'gradient flow on the SGD loss', paths.flowSGD[paths.flowSGD.length - 1]],
  ];
  const inside = (p: Pt) => p.every((v) => v >= IR_R[0] && v <= IR_R[1]);
  return (
    <Notebook
      id="9.2"
      title="Implicit regularisation"
      intro={
        <>
          The model f[x, φ] = φ₁·φ₀·x fits equally well wherever φ₀φ₁ equals the best slope, so its minima form a curved
          valley. Continuous gradient flow keeps φ₁² − φ₀² fixed and lands wherever that puts it. Steps of finite size α
          act like flow on L + (α/4)|∇L|²; SGD adds a further term for the variance of the batch gradients. Both terms
          favour the flatter, balanced part of the valley.
        </>
      }
      tryThis={[
        'Compare the blue and orange ends: finite steps land a little further along the valley than the flow. The yellow flow on the modified loss follows the orange steps.',
        'Press Train with batch size 1: SGD keeps drifting along the valley floor towards φ₀ = φ₁, where the curvature is lowest. The green flow on the SGD loss predicts the drift.',
        'Raise the batch size to 24: SGD becomes gradient descent and the drift stops. Lower α and every path moves back towards the flow.',
        'Switch the surface between L and the modified losses: the extra terms are zero along the valley but grow off it and with the imbalance.',
      ]}
      takeaway="Gradient descent and SGD are not neutral. Finite steps and small batches act as hidden regularisers that push towards flat minima, where batches agree."
    >
      <div className="dl-controls">
        <Slider label="learning rate α" value={alpha} min={0.01} max={0.15} step={0.005} onChange={setAlpha} />
        <Slider
          label="batch size"
          value={bi}
          min={0}
          max={IR_BATCHES.length - 1}
          step={1}
          onChange={setBi}
          show={() => String(m)}
        />
        <RunButtons t={t} />
      </div>
      <div className="dl-controls">
        <Chips<IRKind>
          options={[
            { id: 'L', label: 'surface: L' },
            { id: 'gd', label: 'L + α/4·|∇L|²' },
            { id: 'sgd', label: '+ batch variance' },
          ]}
          value={kind}
          onChange={setKind}
        />
      </div>
      <div className="dl-cols">
        <div>
          <Plot
            x={IR_R}
            y={IR_R}
            height={300}
            xLabel="φ₀"
            yLabel="φ₁"
            ariaLabel="Loss surface with a curved valley of minima and the paths of gradient flow, gradient descent and SGD"
            onDrag={(a, b, phase) => phase === 'start' && setStart([a, b])}
            draw={(f) => {
              drawGrid(f, grid);
              const bal = linspace(IR_R[0], IR_R[1], 2);
              f.line(bal, bal, f.c.muted, 1, [3, 4]);
              drawPath(f, paths.flowL, f.c.s1, 2, [6, 4]);
              drawPath(f, paths.gd, f.c.s2, 2);
              drawPath(f, paths.flowGD, f.c.s4, 1.5, [2, 3]);
              drawPath(f, paths.flowSGD, f.c.s3, 1.5, [6, 4]);
              const sp = t.s.path.filter(inside);
              drawPath(f, sp, f.c.s5, 1.5);
              f.dots([start], f.c.ink, 3);
            }}
          />
          <div className="dl-caption">
            Drag to choose a start. The dotted diagonal is φ₀ = φ₁, the flattest point of the valley.
          </div>
        </div>
        <div>
          <table className="dl-table">
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>path</th>
                <th>φ₀</th>
                <th>φ₁</th>
                <th>φ₁² − φ₀²</th>
                <th>curvature</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(([colour, label, [a, b]]) => (
                <tr key={colour}>
                  <td style={{ textAlign: 'left' }}>
                    <span className="dl-legend">
                      <span>
                        <i style={{ background: `var(--${colour})` }} />
                        {label}
                      </span>
                    </span>
                  </td>
                  <td>{fmt(a)}</td>
                  <td>{fmt(b)}</td>
                  <td>{fmt(b * b - a * a)}</td>
                  <td>{fmt(2 * IR.m2 * (a * a + b * b))}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="dl-caption">
            Curvature across the valley floor is about 2·mean(x²)·(φ₀² + φ₁²), smallest when φ₀ = φ₁. Gradient flow
            keeps φ₁² − φ₀² fixed; each finite step multiplies it by 1 − α²g², where g is that step’s gradient with
            respect to φ₀φ₁.
          </p>
        </div>
      </div>
    </Notebook>
  );
}

/* ---------- 9.3 Ensembling ---------- */

const ENS = sampleData(15, 0.3, rng(93));
const ENS_MAX = 40;

function Ensembling() {
  const [D, setD] = useState(14);
  const [M, setM] = useState(10);
  const [seed, setSeed] = useState(1);
  const res = useMemo(() => {
    const full = predictJoints(fitJoints(ENS.xs, ENS.ys, D), D, GRID);
    const r = rng(930 + seed);
    const models = Array.from({ length: ENS_MAX }, () => {
      // Bagging: a training set of the same size, drawn from the data with replacement.
      const idx = Array.from({ length: ENS.xs.length }, () => Math.floor(r() * ENS.xs.length));
      return predictJoints(
        fitJoints(
          idx.map((i) => ENS.xs[i]),
          idx.map((i) => ENS.ys[i]),
          D,
        ),
        D,
        GRID,
      );
    });
    const sums = GRID.map(() => 0);
    const curve = models.map((p, k) => {
      p.forEach((v, g) => (sums[g] += v));
      return testError(
        sums.map((s) => s / (k + 1)),
        0.3,
      );
    });
    return { full, models, curve, fullErr: testError(full, 0.3), single: mean(models.map((p) => testError(p, 0.3))) };
  }, [D, seed]);
  const avg = GRID.map((_, g) => mean(res.models.slice(0, M).map((p) => p[g])));
  const ms = Array.from({ length: ENS_MAX }, (_, i) => i + 1);
  const top = Math.min(1.5, Math.max(...res.curve, res.fullErr, res.single) * 1.1);
  return (
    <Notebook
      id="9.3"
      title="Ensembling"
      intro={
        <>
          Train several models and average their predictions. Here each model is the 14-unit network from chapter 8,
          fitted to a bootstrap sample: as many points as the data, drawn with replacement, so each model sees a
          slightly different set. This is bagging. Their errors partly cancel, so the average is smoother than any one
          fit.
        </>
      }
      tryThis={[
        'Start with one model, then raise the number: the average (blue) settles down and the test error drops.',
        'Compare with the single model fitted to all the data (orange dashed), which passes through every point.',
        'Lower the hidden units to 3: each model has little variance, so averaging gains less.',
      ]}
      takeaway="Averaging models trained on resampled data reduces variance. It helps most when each model overfits in its own way."
    >
      <div className="dl-controls">
        <Slider label="hidden units D" value={D} min={3} max={20} step={1} onChange={setD} show={String} />
        <Slider label="models in the ensemble" value={M} min={1} max={ENS_MAX} step={1} onChange={setM} show={String} />
        <button className="btn small" onClick={() => setSeed((s) => s + 1)}>
          New bootstrap samples
        </button>
      </div>
      <div className="dl-cols">
        <div>
          <Plot
            x={[0, 1]}
            y={[-2, 2.5]}
            xLabel="x"
            yLabel="y"
            ariaLabel="Bootstrap models, their average, the full-data model and the training data"
            draw={(f) => {
              for (const p of res.models.slice(0, Math.min(M, 12))) f.line(GRID, p, f.c.muted, 1);
              f.line(GRID, GRID.map(truth), f.c.ink, 1.5, [5, 4]);
              f.line(GRID, res.full, f.c.s2, 2, [6, 3]);
              f.line(GRID, avg, f.c.s1, 2.5);
              f.dots(
                ENS.xs.map((x, i) => [x, ENS.ys[i]] as Pt),
                f.c.ink,
                3.5,
              );
            }}
          />
          <div className="dl-caption">
            Grey: up to 12 of the bootstrap models. Blue: the average of all of them in the ensemble.
          </div>
        </div>
        <div>
          <Plot
            x={[1, ENS_MAX]}
            y={[0, top]}
            xLabel="models"
            yLabel="expected test error"
            ariaLabel="Test error of the ensemble against the number of models"
            draw={(f) => {
              f.hline(res.fullErr, f.c.s2);
              f.hline(res.single, f.c.muted);
              f.line(ms, res.curve, f.c.s1, 2);
              f.dots([[M, res.curve[M - 1]]], f.c.ink, 4);
            }}
          />
          <Legend
            items={[
              ['s1', 'ensemble'],
              ['s2', 'one model, all data'],
              ['muted', 'one bootstrap model, on average'],
            ]}
          />
        </div>
      </div>
      <Readout
        items={[
          ['ensemble test error', fmt(res.curve[M - 1])],
          ['one model on all data', fmt(res.fullErr)],
          ['one bootstrap model (mean)', fmt(res.single)],
          ['noise floor σ²', fmt(0.09)],
        ]}
      />
    </Notebook>
  );
}

/* ---------- 9.4 Bayesian approach ---------- */

const BAYES_START: Pt[] = (() => {
  const r = rng(94);
  const xs = [0.04, 0.1, 0.17, 0.23, 0.3, 0.7, 0.76, 0.83, 0.9, 0.96];
  return xs.map((x) => [x, truth(x) + 0.2 * gauss(r)] as Pt);
})();

/**
 * Bayesian linear regression on the joint features with prior φ ~ N(0, σp²I) and noise σ²: the posterior is normal
 * with precision A = ΦᵀΦ/σ² + I/σp² and mean A⁻¹Φᵀy/σ². Also returns the log marginal likelihood of the data.
 */
function posterior(pts: Pt[], D: number, sp: number, s: number) {
  const p = D + 1;
  const Phi = pts.map(([x]) => joints(x, D));
  const A = new Float64Array(p * p),
    b = new Float64Array(p);
  Phi.forEach((h, i) => {
    for (let j = 0; j < p; j++) {
      b[j] += (h[j] * pts[i][1]) / (s * s);
      for (let k = 0; k < p; k++) A[j * p + k] += (h[j] * h[k]) / (s * s);
    }
  });
  for (let j = 0; j < p; j++) A[j * p + j] += 1 / (sp * sp);
  const L = cholesky(A, p);
  const mu = backSub(L, forwardSub(L, b, p), p);
  return { p, L, mu, evidence: logEvidence(Phi, pts, sp, s) };
}

/** log Pr(y) for y ~ N(0, σp²ΦΦᵀ + σ²I), by a Cholesky factor of the covariance. */
function logEvidence(Phi: Float64Array[], pts: Pt[], sp: number, s: number): number {
  const n = pts.length;
  if (!n) return 0;
  const C = new Float64Array(n * n);
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) C[i * n + j] = sp * sp * dot(Phi[i], Phi[j]) + (i === j ? s * s : 0);
  const L = cholesky(C, n);
  const v = forwardSub(
    L,
    pts.map((q) => q[1]),
    n,
  );
  let logDet = 0;
  for (let i = 0; i < n; i++) logDet += Math.log(L[i * n + i]);
  return -0.5 * dot(v, v) - logDet - 0.5 * n * Math.log(2 * Math.PI);
}

function BayesianApproach() {
  const [pts, setPts] = useState<Pt[]>(BAYES_START);
  const [logSp, setLogSp] = useState(0.5);
  const [s, setS] = useState(0.2);
  const [D, setD] = useState(12);
  const [seed, setSeed] = useState(1);
  const sp = 10 ** logSp;
  const post = posterior(pts, D, sp, s);
  const pred = GRID.map((x) => {
    const h = joints(x, D);
    const v = forwardSub(post.L, h, post.p);
    return { m: dot(post.mu, h), sd: Math.sqrt(dot(v, v) + s * s) };
  });
  const r = rng(940 + seed);
  const samples = [0, 1, 2].map(() => {
    // φ = μ + L⁻ᵀz has covariance L⁻ᵀL⁻¹ = A⁻¹, the posterior covariance.
    const phi = backSub(
      post.L,
      Float64Array.from({ length: post.p }, () => gauss(r)),
      post.p,
    ).map((v, j) => v + post.mu[j]);
    return GRID.map((x) => dot(phi, joints(x, D)));
  });
  const logs = linspace(-1.5, 1.5, 61);
  const ev = useMemo(() => logs.map((l) => posterior(pts, D, 10 ** l, s).evidence), [pts, D, s]); // eslint-disable-line react-hooks/exhaustive-deps
  const evLo = Math.min(...ev),
    evHi = Math.max(...ev);
  const mid = pred[50];
  return (
    <Notebook
      id="9.4"
      title="Bayesian approach"
      intro={
        <>
          Instead of one best set of parameters, keep a distribution over them. With a normal prior φ ~ N(0, σp²I) on
          the weights of the joint network and normal noise, Bayes’ rule gives a normal posterior. Predictions average
          over it: a mean curve, and an uncertainty band that is narrow near the data and wide where there are none.
        </>
      }
      tryThis={[
        'Look at the gap in the middle: the band widens where no data constrain the curve.',
        'Click the left plot to add points in the gap: the band pinches in around each new point.',
        'Shrink the prior σp: samples become flatter and the mean is pulled towards zero. This mean is the L2-regularised fit with λ = σ²/σp².',
        'The right plot shows how likely the data are under each prior. Its peak is a sensible σp, chosen without a validation set.',
      ]}
      takeaway="The Bayesian approach averages over every parameter setting, weighted by prior and fit. It gives honest uncertainty where data are missing."
    >
      <div className="dl-controls">
        <Slider
          label="prior σp"
          value={logSp}
          min={-1.5}
          max={1.5}
          step={0.05}
          onChange={setLogSp}
          show={(v) => fmt(10 ** v)}
        />
        <Slider label="noise σ" value={s} min={0.05} max={0.6} onChange={setS} />
        <Slider label="hidden units D" value={D} min={3} max={20} step={1} onChange={setD} show={String} />
        <button className="btn small" onClick={() => setSeed((v) => v + 1)}>
          New samples
        </button>
        <button className="btn small" onClick={() => setPts([])}>
          Clear points
        </button>
        <button className="btn small" onClick={() => setPts(BAYES_START)}>
          Reset points
        </button>
      </div>
      <div className="dl-cols">
        <div>
          <Plot
            x={[0, 1]}
            y={[-2.5, 3]}
            xLabel="x"
            yLabel="y"
            ariaLabel="Posterior predictive mean with a two standard deviation band, posterior samples and the data"
            onDrag={(x, y, phase) => phase === 'start' && x >= 0 && x <= 1 && setPts((p) => [...p, [x, y]])}
            draw={(f) => {
              band(
                f,
                GRID,
                pred.map((q) => q.m - 2 * q.sd),
                pred.map((q) => q.m + 2 * q.sd),
                f.c.s1,
                0.18,
              );
              for (const smp of samples) f.line(GRID, smp, f.c.s3, 1);
              f.line(GRID, GRID.map(truth), f.c.ink, 1.5, [5, 4]);
              f.line(
                GRID,
                pred.map((q) => q.m),
                f.c.s1,
                2.5,
              );
              f.dots(pts, f.c.s2, 3.5);
            }}
          />
          <div className="dl-caption">
            Click to add a point. Blue: mean and ±2 standard deviations. Green: three posterior samples.
          </div>
        </div>
        <div>
          <Plot
            x={[-1.5, 1.5]}
            y={[evLo - 1, evHi + Math.max(1, 0.1 * (evHi - evLo))]}
            xLabel="log₁₀ σp"
            yLabel="log Pr(data)"
            ariaLabel="Log marginal likelihood of the data against the prior standard deviation"
            draw={(f) => {
              f.line(logs, ev, f.c.s4, 2);
              f.vline(logSp, f.c.muted, [2, 3]);
            }}
          />
          <div className="dl-caption">How probable the data are under each prior, averaging over all parameters.</div>
        </div>
      </div>
      <Readout
        items={[
          ['data points', pts.length],
          ['equivalent L2 λ = σ²/σp²', fmt((s * s) / (sp * sp))],
          ['predictive sd at x = 0.5', fmt(mid.sd)],
          ['log Pr(data)', fmt(post.evidence)],
          ['best log₁₀ σp', fmt(logs[ev.indexOf(evHi)])],
        ]}
      />
    </Notebook>
  );
}

/* ---------- 9.5 Augmentation ---------- */

/** A copy of an example shifted by up to `maxShift` positions (repeating the edge value), rescaled a little and noised. */
function augment(x: Float64Array, r: () => number, maxShift: number, noise: number): Float64Array {
  const shift = Math.round((2 * r() - 1) * maxShift);
  const scale = 1 + 0.4 * (r() - 0.5);
  return x.map((_, i) => scale * x[clamp(i - shift, 0, LEN - 1)] + noise * gauss(r));
}

const AUG_EPOCHS = 300;

function Augmentation() {
  const [nTrain, setNTrain] = useState(60);
  const [maxShift, setMaxShift] = useState(8);
  const [noise, setNoise] = useState(0.1);
  const t = useTrainer(
    () => {
      const tr = mnistData(nTrain, 95, 0.4),
        te = mnistData(500, 96, 0.4);
      const plain = makeNet([LEN, 32, 32, 10], 97),
        aug = makeNet([LEN, 32, 32, 10], 97);
      const e0 = evaluate(plain, te).err;
      return {
        tr,
        te,
        plain,
        aug,
        r: rng(98),
        ep: [0],
        plainErr: [e0],
        augErr: [e0],
        plainTrain: [e0],
        augTrain: [e0],
      };
    },
    (s) => {
      for (let k = 0; k < 2; k++) {
        epoch(s.plain, s.tr, 10, 0.05, s.r);
        // A fresh random transformation of every training example, every epoch.
        epoch(s.aug, { X: s.tr.X.map((x) => augment(x, s.r, maxShift, noise)), Y: s.tr.Y }, 10, 0.05, s.r);
      }
      s.ep.push(s.ep[s.ep.length - 1] + 2);
      s.plainErr.push(evaluate(s.plain, s.te).err);
      s.augErr.push(evaluate(s.aug, s.te).err);
      s.plainTrain.push(evaluate(s.plain, s.tr).err);
      s.augTrain.push(evaluate(s.aug, s.tr).err);
    },
    (s) => s.ep[s.ep.length - 1] >= AUG_EPOCHS,
    [nTrain, maxShift, noise],
  );
  const s = t.s;
  const last = s.ep.length - 1;
  const ex = s.tr.X[0];
  const er = rng(99 + maxShift);
  const copies = [0, 1, 2].map(() => augment(ex, er, maxShift, noise));
  const pos = linspace(0, LEN - 1, LEN);
  const pc = (v: number[]) => v.map((e) => 100 * e);
  return (
    <Notebook
      id="9.5"
      title="Augmentation"
      intro={
        <>
          With few training examples, make more. Shifting an MNIST-1D-style signal along, rescaling it slightly or
          adding a little noise leaves its class unchanged. Two identical networks train side by side on the same small
          set: one sees the original examples every epoch, the other a freshly transformed copy of each.
        </>
      }
      tryThis={[
        'Press Train: the plain network reaches zero training error quickly, but the augmented one gets the lower test error.',
        'Set the shift to 0 and leave only noise: most of the gain disappears. Shifts help because position really does vary in this data.',
        'Raise the training set size: both networks improve, and the gap between them narrows.',
      ]}
      takeaway="Augmentation adds examples that teach the network which changes do not matter. It costs nothing to label and often helps most when data are scarce."
    >
      <div className="dl-controls">
        <Slider
          label="training examples"
          value={nTrain}
          min={30}
          max={200}
          step={10}
          onChange={setNTrain}
          show={String}
        />
        <Slider label="largest shift" value={maxShift} min={0} max={12} step={1} onChange={setMaxShift} show={String} />
        <Slider label="added noise" value={noise} min={0} max={0.3} step={0.02} onChange={setNoise} />
        <RunButtons t={t} />
      </div>
      <div className="dl-cols">
        <div>
          <Plot
            x={[0, LEN - 1]}
            y={[-3, 3]}
            height={220}
            xLabel="position"
            yLabel="x"
            ariaLabel="One training example and three augmented copies"
            draw={(f) => {
              copies.forEach((c, k) => f.line(pos, Array.from(c), [f.c.s3, f.c.s4, f.c.s5][k], 1.2));
              f.line(pos, Array.from(ex), f.c.ink, 2.5);
            }}
          />
          <div className="dl-caption">One training example (dark) and three augmented copies with the same label.</div>
        </div>
        <div>
          <Plot
            x={[0, AUG_EPOCHS]}
            y={[0, 100]}
            height={220}
            xLabel="epoch"
            yLabel="% wrong"
            ariaLabel="Training and test error of the plain and augmented networks against epoch"
            draw={(f) => {
              f.line(s.ep, pc(s.plainTrain), f.c.s2, 1.2, [4, 3]);
              f.line(s.ep, pc(s.augTrain), f.c.s1, 1.2, [4, 3]);
              f.line(s.ep, pc(s.plainErr), f.c.s2, 2.5);
              f.line(s.ep, pc(s.augErr), f.c.s1, 2.5);
            }}
          />
          <Legend
            items={[
              ['s2', 'plain'],
              ['s1', 'augmented'],
            ]}
          />
          <div className="dl-caption">Solid: test error. Dashed: error on the (unaugmented) training set.</div>
        </div>
      </div>
      <Readout
        items={[
          ['epoch', s.ep[last]],
          ['plain: test error', `${fmt(100 * s.plainErr[last])}%`],
          ['augmented: test error', `${fmt(100 * s.augErr[last])}%`],
          ['plain: training error', `${fmt(100 * s.plainTrain[last])}%`],
          ['augmented: training error', `${fmt(100 * s.augTrain[last])}%`],
        ]}
      />
    </Notebook>
  );
}

export const CHAPTERS: ChapterDef[] = [
  {
    n: 8,
    title: 'Measuring performance',
    blurb:
      'A model that fits its training data may still fail on new data. Test error comes from noise, bias and variance; adding capacity trades one against another, until double descent breaks the pattern. High-dimensional space is part of why.',
    notebooks: [
      { id: '8.1', title: 'MNIST-1D performance', Component: MnistPerformance },
      { id: '8.2', title: 'Bias–variance trade-off', Component: BiasVariance },
      { id: '8.3', title: 'Double descent', Component: DoubleDescent },
      { id: '8.4', title: 'High-dimensional spaces', Component: HighDimensional },
    ],
  },
  {
    n: 9,
    title: 'Regularisation',
    blurb:
      'Ways to close the gap between training and test performance: penalise large weights, rely on the hidden preferences of SGD, average many models, average over parameters the Bayesian way, and make more data by augmentation.',
    notebooks: [
      { id: '9.1', title: 'L2 regularisation', Component: L2Regularisation },
      { id: '9.2', title: 'Implicit regularisation', Component: ImplicitRegularisation },
      { id: '9.3', title: 'Ensembling', Component: Ensembling },
      { id: '9.4', title: 'Bayesian approach', Component: BayesianApproach },
      { id: '9.5', title: 'Augmentation', Component: Augmentation },
    ],
  },
];
