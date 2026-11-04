/* Chapters 20 and 21: why deep learning works (random labels, full-batch training, lottery tickets, adversarial
   examples) and two ethics notebooks (fair thresholds and local explanations). */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChapterDef } from './chapters';
import { fmt, gauss, linspace, rng, useAnimation } from './kit';
import { Chips, Notebook, Readout, Slider } from './Notebook';
import { Plot, mix, type Frame } from './Plot';

// ---------- a small multilayer perceptron ----------

interface Dataset {
  X: Float64Array[];
  y: number[];
}

/** ReLU hidden layers and a softmax output. W[l] is sizes[l + 1] × sizes[l], row by row. A mask holds pruned weights at 0. */
interface Mlp {
  sizes: number[];
  W: Float64Array[];
  b: Float64Array[];
  mask: Float64Array[] | null;
}

/** He initialisation: weights with variance 2 / fan-in, biases at 0. */
function initMlp(sizes: number[], seed: number): Mlp {
  const r = rng(seed);
  const W: Float64Array[] = [];
  const b: Float64Array[] = [];
  for (let l = 0; l < sizes.length - 1; l++) {
    const std = Math.sqrt(2 / sizes[l]);
    const w = new Float64Array(sizes[l] * sizes[l + 1]);
    for (let k = 0; k < w.length; k++) w[k] = gauss(r) * std;
    W.push(w);
    b.push(new Float64Array(sizes[l + 1]));
  }
  return { sizes, W, b, mask: null };
}

function cloneMlp(n: Mlp): Mlp {
  return {
    sizes: n.sizes,
    W: n.W.map((w) => w.slice()),
    b: n.b.map((v) => v.slice()),
    mask: n.mask && n.mask.map((m) => m.slice()),
  };
}

/** Every layer's activations: acts[0] is the input, the last is the logits. */
function forward(n: Mlp, x: Float64Array): Float64Array[] {
  const acts = [x];
  let h = x;
  const L = n.W.length;
  for (let l = 0; l < L; l++) {
    const rows = n.sizes[l + 1];
    const cols = n.sizes[l];
    const W = n.W[l];
    const z = new Float64Array(rows);
    for (let i = 0; i < rows; i++) {
      let s = n.b[l][i];
      const o = i * cols;
      for (let j = 0; j < cols; j++) s += W[o + j] * h[j];
      z[i] = l < L - 1 && s < 0 ? 0 : s;
    }
    acts.push(z);
    h = z;
  }
  return acts;
}

function softmaxOf(z: Float64Array): Float64Array {
  let m = -Infinity;
  for (const v of z) m = Math.max(m, v);
  const e = new Float64Array(z.length);
  let s = 0;
  for (let i = 0; i < z.length; i++) s += e[i] = Math.exp(z[i] - m);
  for (let i = 0; i < z.length; i++) e[i] /= s;
  return e;
}

function predict(n: Mlp, x: Float64Array): Float64Array {
  const a = forward(n, x);
  return softmaxOf(a[a.length - 1]);
}

function argmax(p: ArrayLike<number>): number {
  let best = 0;
  for (let i = 1; i < p.length; i++) if (p[i] > p[best]) best = i;
  return best;
}

/**
 * Backpropagation from dOut = ∂ℓ/∂logits. Adds the weight and bias gradients into gW and gb when given, and
 * returns ∂ℓ/∂input, which the attack and the saliency map need.
 */
function backward(
  n: Mlp,
  acts: Float64Array[],
  dOut: Float64Array,
  gW: Float64Array[] | null,
  gb: Float64Array[] | null,
): Float64Array {
  let g = dOut;
  for (let l = n.W.length - 1; l >= 0; l--) {
    const rows = n.sizes[l + 1];
    const cols = n.sizes[l];
    const h = acts[l];
    const W = n.W[l];
    const prev = new Float64Array(cols);
    for (let i = 0; i < rows; i++) {
      const gi = g[i];
      if (gi === 0) continue;
      const o = i * cols;
      if (gW && gb) {
        const gw = gW[l];
        for (let j = 0; j < cols; j++) gw[o + j] += gi * h[j];
        gb[l][i] += gi;
      }
      for (let j = 0; j < cols; j++) prev[j] += W[o + j] * gi;
    }
    // A hidden unit that was off (its ReLU output is 0) passes no gradient back.
    if (l > 0) for (let j = 0; j < cols; j++) if (h[j] <= 0) prev[j] = 0;
    g = prev;
  }
  return g;
}

/** The optimiser's state: plain SGD or Adam, with gradient buffers reused across steps. */
interface Opt {
  adam: boolean;
  lr: number;
  t: number;
  gW: Float64Array[];
  gb: Float64Array[];
  m: Float64Array[];
  v: Float64Array[];
}

function makeOpt(n: Mlp, lr: number, adam = false): Opt {
  const all = [...n.W, ...n.b];
  return {
    adam,
    lr,
    t: 0,
    gW: n.W.map((w) => new Float64Array(w.length)),
    gb: n.b.map((v) => new Float64Array(v.length)),
    m: all.map((a) => new Float64Array(a.length)),
    v: all.map((a) => new Float64Array(a.length)),
  };
}

/** One update on the examples `idx` of `d`, minimising their mean cross-entropy. Returns that loss. */
function trainStep(n: Mlp, opt: Opt, d: Dataset, idx: ArrayLike<number>): number {
  opt.gW.forEach((g) => g.fill(0));
  opt.gb.forEach((g) => g.fill(0));
  let loss = 0;
  const B = idx.length;
  for (let k = 0; k < B; k++) {
    const i = idx[k];
    const acts = forward(n, d.X[i]);
    const p = softmaxOf(acts[acts.length - 1]);
    loss -= Math.log(Math.max(p[d.y[i]], 1e-12));
    p[d.y[i]] -= 1; // ∂(cross-entropy)/∂logits = softmax − one-hot
    for (let c = 0; c < p.length; c++) p[c] /= B;
    backward(n, acts, p, opt.gW, opt.gb);
  }
  const params = [...n.W, ...n.b];
  const grads = [...opt.gW, ...opt.gb];
  opt.t++;
  const c1 = 1 - 0.9 ** opt.t;
  const c2 = 1 - 0.999 ** opt.t;
  for (let a = 0; a < params.length; a++) {
    const P = params[a];
    const G = grads[a];
    if (opt.adam) {
      const M = opt.m[a];
      const V = opt.v[a];
      for (let k = 0; k < P.length; k++) {
        M[k] = 0.9 * M[k] + 0.1 * G[k];
        V[k] = 0.999 * V[k] + 0.001 * G[k] * G[k];
        P[k] -= (opt.lr * (M[k] / c1)) / (Math.sqrt(V[k] / c2) + 1e-8);
      }
    } else {
      for (let k = 0; k < P.length; k++) P[k] -= opt.lr * G[k];
    }
    const mask = a < n.W.length && n.mask ? n.mask[a] : null;
    if (mask) for (let k = 0; k < P.length; k++) P[k] *= mask[k];
  }
  return loss / B;
}

function evaluate(n: Mlp, d: Dataset): { loss: number; acc: number } {
  let loss = 0;
  let right = 0;
  d.X.forEach((x, i) => {
    const p = predict(n, x);
    loss -= Math.log(Math.max(p[d.y[i]], 1e-12));
    if (argmax(p) === d.y[i]) right++;
  });
  return { loss: loss / d.X.length, acc: right / d.X.length };
}

function shuffled(n: number, r: () => number): number[] {
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** One pass over the data in shuffled mini-batches. Returns the mean batch loss. */
function epoch(n: Mlp, opt: Opt, d: Dataset, batch: number, r: () => number): number {
  const order = shuffled(d.y.length, r);
  let loss = 0;
  let count = 0;
  for (let s = 0; s < order.length; s += batch) {
    loss += trainStep(n, opt, d, order.slice(s, s + batch));
    count++;
  }
  return loss / count;
}

// ---------- the signal dataset (in the spirit of MNIST-1D) ----------

const SIG_LEN = 32;
const CLASSES = 4;
const NOISE = 0.15;
const SIZES = [SIG_LEN, 64, 64, CLASSES];
const CLASS_NAMES = ['bump', 'two spikes', 'saw', 'dip then rise'];
const CLASS_COLOURS = ['s1', 's2', 's3', 's4'] as const;

const TEMPLATES: number[][] = [
  [0, 0.5, 1, 1, 1, 0.5, 0, 0, 0, 0, 0],
  [0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0],
  [0, 0.25, 0.5, 0.75, 1, -1, -0.75, -0.5, -0.25, 0, 0],
  [0, -0.5, -1, -1, -0.5, 0, 0.5, 1, 1, 0.5, 0],
];

/** Signals of 32 samples: the class's shape at a random place and height, on a random slope, plus smooth noise. */
function makeSignals(count: number, seed: number): Dataset {
  const r = rng(seed);
  const X: Float64Array[] = [];
  const y: number[] = [];
  for (let k = 0; k < count; k++) {
    const c = k % CLASSES;
    const t = TEMPLATES[c];
    const x = new Float64Array(SIG_LEN);
    const at = Math.floor(r() * (SIG_LEN - t.length));
    const amp = 0.8 + 0.5 * r();
    const slope = (r() - 0.5) * 0.04;
    let noise = 0;
    for (let i = 0; i < SIG_LEN; i++) {
      noise = 0.6 * noise + 0.8 * NOISE * gauss(r); // correlated noise with a standard deviation of about NOISE
      x[i] = slope * (i - SIG_LEN / 2) + noise + (i >= at && i < at + t.length ? amp * t[i - at] : 0);
    }
    X.push(x);
    y.push(c);
  }
  return { X, y };
}

const TEST = makeSignals(300, 999);
const SIG_XS = Array.from({ length: SIG_LEN }, (_, i) => i);

/** Shuffles the labels of a chosen fraction of the examples among themselves. Class counts stay the same. */
function corruptLabels(d: Dataset, fraction: number, seed: number): Dataset {
  const r = rng(seed);
  const chosen = shuffled(d.y.length, r).slice(0, Math.round(fraction * d.y.length));
  const order = shuffled(chosen.length, r);
  const y = [...d.y];
  chosen.forEach((i, k) => (y[i] = d.y[chosen[order[k]]]));
  return { X: d.X, y };
}

// ---------- shared UI ----------

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

const pct = (v: number) => `${(100 * v).toFixed(1)}%`;

/**
 * A training job run one animation frame at a time. `make` builds a fresh state, `step` advances it and returns
 * true when it has finished. The state starts again whenever one of `deps` changes.
 */
function useJob<S>(make: () => S, step: (s: S) => boolean, deps: unknown[], autoStart = false) {
  const state = useRef<S | null>(null);
  if (state.current === null) state.current = make();
  const makeRef = useRef(make);
  makeRef.current = make;
  const [, render] = useState(0);
  const [running, setRunning] = useState(autoStart);

  useAnimation(running, () => {
    const done = step(state.current as S);
    render((n) => n + 1);
    if (done) {
      setRunning(false);
      return false;
    }
  });

  const reset = (start = false) => {
    state.current = makeRef.current();
    setRunning(start);
    render((n) => n + 1);
  };
  const first = useRef(true);
  useEffect(() => {
    if (first.current) return void (first.current = false);
    reset(autoStart);
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps

  return { s: state.current as S, running, toggle: () => setRunning((r) => !r), reset: () => reset(false) };
}

function RunButtons({
  job,
  done,
}: {
  job: { running: boolean; toggle: () => void; reset: () => void };
  done: boolean;
}) {
  return (
    <div className="row">
      <button className="btn primary small" onClick={job.toggle} disabled={done}>
        {job.running ? 'Pause' : done ? 'Finished' : 'Run'}
      </button>
      <button className="btn small" onClick={job.reset}>
        Reset
      </button>
    </div>
  );
}

/** One network being trained, with its history. */
interface Track {
  net: Mlp;
  opt: Opt;
  data: Dataset;
  rand: () => number;
  epochs: number[];
  trainErr: number[];
  trainLoss: number[];
  testAcc: number[];
  fitAt: number; // first epoch with every training example right, or −1
}

function makeTrack(net: Mlp, data: Dataset, lr: number, seed: number): Track {
  return {
    net,
    opt: makeOpt(net, lr),
    data,
    rand: rng(seed),
    epochs: [],
    trainErr: [],
    trainLoss: [],
    testAcc: [],
    fitAt: -1,
  };
}

/** Evaluates a track on its own training labels and on the (true) test labels, and records the result. */
function record(t: Track, at: number) {
  const tr = evaluate(t.net, t.data);
  t.epochs.push(at);
  t.trainErr.push(1 - tr.acc);
  t.trainLoss.push(Math.log10(Math.max(tr.loss, 1e-6)));
  t.testAcc.push(evaluate(t.net, TEST).acc);
  if (tr.acc === 1 && t.fitAt < 0) t.fitAt = at;
}

const last = (a: number[]) => (a.length ? a[a.length - 1] : NaN);

// ---------- 20.1 Random data ----------

const RD_TRAIN = 300;
const RD_MAX = 250;

interface RandomState {
  real: Track;
  noisy: Track;
  changed: number;
  epoch: number;
  done: boolean;
}

function RandomData() {
  const [fraction, setFraction] = useState(1);
  const [seed, setSeed] = useState(1);
  const train = useMemo(() => makeSignals(RD_TRAIN, seed), [seed]);
  const job = useJob<RandomState>(
    () => {
      const noisyData = corruptLabels(train, fraction, seed + 50);
      const real = makeTrack(initMlp(SIZES, seed + 7), train, 0.1, seed + 9);
      const noisy = makeTrack(initMlp(SIZES, seed + 7), noisyData, 0.1, seed + 9);
      record(real, 0);
      record(noisy, 0);
      const changed = noisyData.y.filter((v, i) => v !== train.y[i]).length / RD_TRAIN;
      return { real, noisy, changed, epoch: 0, done: false };
    },
    (s) => {
      if (s.done) return true;
      s.epoch++;
      for (const t of [s.real, s.noisy]) {
        epoch(t.net, t.opt, t.data, 20, t.rand);
        record(t, s.epoch);
      }
      const both = s.real.fitAt >= 0 && s.noisy.fitAt >= 0;
      s.done = (both && s.epoch >= Math.max(s.real.fitAt, s.noisy.fitAt) + 15) || s.epoch >= RD_MAX;
      return s.done;
    },
    [fraction, seed, train],
  );
  const { s } = job;
  const xMax = Math.max(40, s.epoch);
  const examples = Array.from({ length: CLASSES }, (_, c) => train.X[c]);
  return (
    <Notebook
      id="20.1"
      title="Random data"
      intro={
        <>
          Two copies of the same network (32 inputs, two hidden layers of 64 ReLUs, 4 outputs, about 6,600 weights) are
          trained with SGD on the same {RD_TRAIN} signals. The first sees the real labels. The second sees labels
          shuffled between examples, so there is nothing to learn: the label is unrelated to the signal. Both are tested
          on 300 new signals with their real labels.
        </>
      }
      tryThis={[
        'Press Run. Both training errors fall to zero: the network memorises shuffled labels as completely as real ones. The shuffled run takes two to three times as many epochs.',
        'Watch the test accuracy. The real run reaches about 85–90%; the shuffled run stays at chance, 25%, because what it memorised says nothing about new signals.',
        'Shuffle only 20% or 50% of the labels. Training still reaches zero error, it takes longer, and the test accuracy falls in between.',
      ]}
      takeaway="A network big enough to fit any labelling of its training set can still generalise when the labels have structure. So low training error and the parameter count cannot explain generalisation on their own: something about real data, the model and the training method together makes the network prefer simple fits."
    >
      <div className="dl-cols">
        <div>
          <Plot
            x={[0, SIG_LEN - 1]}
            y={[-1.6, 8]}
            height={200}
            axes={false}
            ariaLabel="One training signal from each of the four classes"
            draw={(f) => {
              examples.forEach((x, c) => {
                const off = (CLASSES - 1 - c) * 2.2;
                f.hline(off, f.c.line, [2, 3]);
                f.line(
                  SIG_XS,
                  Array.from(x, (v) => v + off),
                  f.c[CLASS_COLOURS[c]],
                  2,
                );
                f.text(CLASS_NAMES[c], 0.5, off + 0.75, f.c.ink2);
              });
            }}
          />
          <p className="dl-caption">
            One training signal of each class. The shape sits at a random place, on a random slope, in noise.
          </p>
        </div>
        <div className="dl-controls" style={{ alignItems: 'flex-start', flexDirection: 'column' }}>
          <Slider
            label="Labels shuffled in the second run"
            value={fraction}
            min={0}
            max={1}
            step={0.05}
            onChange={setFraction}
            show={(v) => `${Math.round(v * 100)}%`}
          />
          <RunButtons job={job} done={s.done} />
          <button className="btn small" onClick={() => setSeed((v) => v + 1)}>
            New data and start
          </button>
          <Readout
            items={[
              ['labels actually changed', pct(s.changed)],
              ['epoch', s.epoch],
            ]}
          />
        </div>
      </div>
      <Legend
        items={[
          ['s1', 'Real labels'],
          ['s2', `${Math.round(fraction * 100)}% of labels shuffled`],
        ]}
      />
      <div className="dl-cols">
        <div>
          <b className="small">Training error</b>
          <Plot
            x={[0, xMax]}
            y={[0, 0.8]}
            height={200}
            xLabel="epoch"
            ariaLabel="Training error against epoch for real and shuffled labels"
            draw={(f) => {
              f.line(s.real.epochs, s.real.trainErr, f.c.s1);
              f.line(s.noisy.epochs, s.noisy.trainErr, f.c.s2);
            }}
          />
        </div>
        <div>
          <b className="small">Test accuracy (real labels, new signals)</b>
          <Plot
            x={[0, xMax]}
            y={[0, 1]}
            height={200}
            xLabel="epoch"
            ariaLabel="Test accuracy against epoch for real and shuffled labels"
            draw={(f) => {
              f.hline(0.25, f.c.muted);
              f.text('chance', xMax * 0.98, 0.28, f.c.muted, 'right');
              f.line(s.real.epochs, s.real.testAcc, f.c.s1);
              f.line(s.noisy.epochs, s.noisy.testAcc, f.c.s2);
            }}
          />
        </div>
      </div>
      <Readout
        items={[
          ['real: epochs to fit', s.real.fitAt >= 0 ? s.real.fitAt : '–'],
          ['shuffled: epochs to fit', s.noisy.fitAt >= 0 ? s.noisy.fitAt : '–'],
          ['real: test accuracy', pct(last(s.real.testAcc))],
          ['shuffled: test accuracy', pct(last(s.noisy.testAcc))],
        ]}
      />
    </Notebook>
  );
}

// ---------- 20.2 Full-batch gradient descent ----------

const FB_TRAIN = 200;
const FB_EVERY = 5;
const BATCHES = [1, 2, 5, 10, 20, 50];

interface FullBatchState {
  gd: Track;
  sgd: Track;
  epoch: number;
  total: number;
  done: boolean;
}

interface FullBatchResult {
  labels: string;
  batch: number;
  lr: number;
  gd: number;
  sgd: number;
}

function FullBatch() {
  const [batchAt, setBatchAt] = useState(1);
  const [lr, setLr] = useState(0.1);
  const [labels, setLabels] = useState<'real' | 'shuffled'>('real');
  const [seed, setSeed] = useState(1);
  const [history, setHistory] = useState<FullBatchResult[]>([]);
  const batch = BATCHES[batchAt];
  const job = useJob<FullBatchState>(
    () => {
      const clean = makeSignals(FB_TRAIN, seed + 20);
      const data = labels === 'real' ? clean : corruptLabels(clean, 1, seed + 21);
      const gd = makeTrack(initMlp(SIZES, seed + 22), data, lr, seed + 23);
      const sgd = makeTrack(initMlp(SIZES, seed + 22), data, lr, seed + 23);
      record(gd, 0);
      record(sgd, 0);
      return { gd, sgd, epoch: 0, total: labels === 'real' ? 400 : 600, done: false };
    },
    (s) => {
      if (s.done) return true;
      for (let k = 0; k < 2 && s.epoch < s.total; k++) {
        s.epoch++;
        epoch(s.gd.net, s.gd.opt, s.gd.data, FB_TRAIN, s.gd.rand); // one batch of everything: one step per epoch
        epoch(s.sgd.net, s.sgd.opt, s.sgd.data, batch, s.sgd.rand);
        if (s.epoch % FB_EVERY === 0) {
          record(s.gd, s.epoch);
          record(s.sgd, s.epoch);
        }
      }
      s.done = s.epoch >= s.total;
      if (s.done) {
        const row = { labels, batch, lr, gd: last(s.gd.testAcc), sgd: last(s.sgd.testAcc) };
        setHistory((h) => [row, ...h].slice(0, 8));
      }
      return s.done;
    },
    [batch, lr, labels, seed],
  );
  const { s } = job;
  const lossLo = Math.min(-3, Math.floor(Math.min(...s.gd.trainLoss, ...s.sgd.trainLoss)));
  return (
    <Notebook
      id="20.2"
      title="Full-batch gradient descent"
      intro={
        <>
          The same network and data, trained two ways from the same starting weights and with the same learning rate.
          Full-batch gradient descent uses the exact gradient over all {FB_TRAIN} training signals, one step per epoch,
          with no randomness. SGD takes a step after every mini-batch, so its gradient is a noisy estimate. Fitting does
          not need the noise. The question is whether the noise changes which solution is found.
        </>
      }
      tryThis={[
        'With real labels and a batch of 2, press Run. Both reach 100% training accuracy. SGD usually ends a few points higher on the test set, and running gradient descent for longer barely moves its test accuracy.',
        'Switch to shuffled labels. Plain gradient descent, with no noise at all, still drives the training error to zero, so the loss has no local minimum that traps it.',
        'Raise the batch size towards 50, or lower the learning rate. The noise shrinks and the gap between the two closes. Small differences are noisy: press New data a few times and compare the history.',
      ]}
      takeaway="Full-batch gradient descent can fit even random labels, so SGD's noise is not what makes training succeed. It does change where training ends: smaller batches and larger steps act as an implicit regulariser and tend to find solutions that generalise better, though the effect is modest and varies between runs."
    >
      <div className="dl-controls">
        <Chips
          options={[
            { id: 'real', label: 'Real labels' },
            { id: 'shuffled', label: 'Shuffled labels' },
          ]}
          value={labels}
          onChange={setLabels}
        />
        <Slider
          label="SGD batch size"
          value={batchAt}
          min={0}
          max={BATCHES.length - 1}
          step={1}
          onChange={setBatchAt}
          show={(v) => String(BATCHES[v])}
        />
        <Slider
          label="Learning rate"
          value={lr}
          min={0.02}
          max={0.2}
          step={0.01}
          onChange={setLr}
          show={(v) => v.toFixed(2)}
        />
        <RunButtons job={job} done={s.done} />
        <button className="btn small" onClick={() => setSeed((v) => v + 1)}>
          New data and start
        </button>
      </div>
      <Legend
        items={[
          ['s2', `Full-batch gradient descent (batch ${FB_TRAIN})`],
          ['s5', `SGD (batch ${batch})`],
        ]}
      />
      <div className="dl-cols">
        <div>
          <b className="small">Training loss (log₁₀)</b>
          <Plot
            x={[0, s.total]}
            y={[lossLo, 0.5]}
            height={210}
            xLabel="epoch"
            ariaLabel="Training loss against epoch for full-batch gradient descent and SGD"
            draw={(f) => {
              f.line(s.gd.epochs, s.gd.trainLoss, f.c.s2);
              f.line(s.sgd.epochs, s.sgd.trainLoss, f.c.s5);
            }}
          />
        </div>
        <div>
          <b className="small">Test accuracy</b>
          <Plot
            x={[0, s.total]}
            y={[0, 1]}
            height={210}
            xLabel="epoch"
            ariaLabel="Test accuracy against epoch for full-batch gradient descent and SGD"
            draw={(f) => {
              f.hline(0.25, f.c.muted);
              f.line(s.gd.epochs, s.gd.testAcc, f.c.s2);
              f.line(s.sgd.epochs, s.sgd.testAcc, f.c.s5);
            }}
          />
        </div>
      </div>
      <Readout
        items={[
          ['epoch', `${s.epoch} of ${s.total}`],
          ['updates: GD / SGD', `${s.epoch} / ${s.epoch * Math.ceil(FB_TRAIN / batch)}`],
          ['GD: train error', pct(last(s.gd.trainErr))],
          ['SGD: train error', pct(last(s.sgd.trainErr))],
          ['GD: test accuracy', pct(last(s.gd.testAcc))],
          ['SGD: test accuracy', pct(last(s.sgd.testAcc))],
        ]}
      />
      {history.length > 0 && (
        <div className="dl-scroll">
          <table className="dl-table">
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>Finished run</th>
                <th>SGD batch</th>
                <th>Learning rate</th>
                <th>GD test</th>
                <th>SGD test</th>
                <th>SGD − GD</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h, i) => (
                <tr key={i}>
                  <td style={{ textAlign: 'left' }}>{h.labels} labels</td>
                  <td>{h.batch}</td>
                  <td>{h.lr.toFixed(2)}</td>
                  <td>{pct(h.gd)}</td>
                  <td>{pct(h.sgd)}</td>
                  <td>{`${h.sgd >= h.gd ? '+' : ''}${(100 * (h.sgd - h.gd)).toFixed(1)}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Notebook>
  );
}

// ---------- 20.3 Lottery tickets ----------

const LT_TRAIN = 300;
const LT_EPOCHS = 50;
const LT_TRAIN_SET = makeSignals(LT_TRAIN, 31);

/**
 * Keeps the largest-magnitude weights of each layer. The output layer, which is small, is pruned at half the rate,
 * as Frankle and Carbin do. Biases are never pruned.
 */
function magnitudeMask(net: Mlp, sparsity: number): Float64Array[] {
  return net.W.map((w, l) => {
    const rate = l === net.W.length - 1 ? sparsity / 2 : sparsity;
    const cut = Math.round(rate * w.length);
    const order = Array.from(w, (_, k) => k).sort((a, b) => Math.abs(w[a]) - Math.abs(w[b]));
    const mask = new Float64Array(w.length).fill(1);
    for (let k = 0; k < cut; k++) mask[order[k]] = 0;
    return mask;
  });
}

function applyMask(net: Mlp, mask: Float64Array[]): Mlp {
  const n = cloneMlp(net);
  n.mask = mask.map((m) => m.slice());
  n.W.forEach((w, l) => w.forEach((_, k) => (w[k] *= mask[l][k])));
  return n;
}

interface LotteryState {
  seed: number;
  init: Mlp;
  dense: Track;
  ticket: Track | null;
  fresh: Track | null;
  kept: number;
  total: number;
  epoch: number;
  phase: 'dense' | 'retrain' | 'done';
}

interface LotteryResult {
  sparsity: number;
  dense: number;
  ticket: number;
  fresh: number;
}

/** Prunes the trained dense network and sets up the two retraining runs: original start and a fresh one. */
function startRetrain(s: LotteryState, sparsity: number) {
  const mask = magnitudeMask(s.dense.net, sparsity);
  s.ticket = makeTrack(applyMask(s.init, mask), LT_TRAIN_SET, 0.1, s.seed + 3);
  s.fresh = makeTrack(applyMask(initMlp(SIZES, s.seed + 1000), mask), LT_TRAIN_SET, 0.1, s.seed + 3);
  record(s.ticket, 0);
  record(s.fresh, 0);
  s.kept = mask.reduce((a, m) => a + m.reduce((x, v) => x + v, 0), 0);
  s.epoch = 0;
  s.phase = 'retrain';
}

function LotteryTickets() {
  const [sparsity, setSparsity] = useState(0.9);
  const [seed, setSeed] = useState(1);
  const [history, setHistory] = useState<LotteryResult[]>([]);
  const cache = useRef<LotteryState | null>(null);
  const job = useJob<LotteryState>(
    () => {
      // When only the sparsity changed, keep the dense network, so only the retraining runs again.
      const old = cache.current;
      if (old && old.seed === seed) {
        if (old.phase === 'dense') return old; // still training: the new sparsity applies when it prunes
        const s: LotteryState = { ...old };
        startRetrain(s, sparsity);
        return s;
      }
      const init = initMlp(SIZES, seed + 40);
      const dense = makeTrack(cloneMlp(init), LT_TRAIN_SET, 0.1, seed + 3);
      record(dense, 0);
      const total = SIZES.slice(1).reduce((a, n, l) => a + n * SIZES[l], 0);
      return { seed, init, dense, ticket: null, fresh: null, kept: total, total, epoch: 0, phase: 'dense' };
    },
    (s) => {
      cache.current = s;
      if (s.phase === 'done') return true;
      s.epoch++;
      if (s.phase === 'dense') {
        epoch(s.dense.net, s.dense.opt, s.dense.data, 20, s.dense.rand);
        record(s.dense, s.epoch);
        if (s.epoch >= LT_EPOCHS) startRetrain(s, sparsity);
        return false;
      }
      for (const t of [s.ticket, s.fresh]) {
        if (!t) continue;
        epoch(t.net, t.opt, t.data, 20, t.rand);
        record(t, s.epoch);
      }
      if (s.epoch >= LT_EPOCHS && s.ticket && s.fresh) {
        s.phase = 'done';
        const row = {
          sparsity,
          dense: last(s.dense.testAcc),
          ticket: last(s.ticket.testAcc),
          fresh: last(s.fresh.testAcc),
        };
        setHistory((h) => [row, ...h.filter((r) => r.sparsity !== sparsity)].slice(0, 8));
        return true;
      }
      return false;
    },
    [sparsity, seed],
  );
  const { s } = job;
  cache.current = s;

  // Histogram of the trained middle layer's weight magnitudes, with the layer's pruning cut.
  const trainedMiddle = s.phase === 'dense' ? null : s.dense.net.W[1];
  const bins = 40;
  const hist = useMemo(() => {
    if (!trainedMiddle) return null;
    const mags = Array.from(trainedMiddle, Math.abs).sort((a, b) => a - b);
    const top = mags[Math.floor(mags.length * 0.995)];
    const counts = new Array<number>(bins).fill(0);
    for (const v of mags) counts[Math.min(bins - 1, Math.floor((v / top) * bins))]++;
    const cut = mags[Math.min(mags.length - 1, Math.round(sparsity * mags.length))];
    return { top, fractions: counts.map((c) => c / mags.length), cut };
  }, [trainedMiddle, sparsity]);

  const status =
    s.phase === 'dense'
      ? `training the dense network, epoch ${s.epoch} of ${LT_EPOCHS}`
      : s.phase === 'retrain'
        ? `retraining the pruned networks, epoch ${s.epoch} of ${LT_EPOCHS}`
        : 'finished';
  return (
    <Notebook
      id="20.3"
      title="Lottery tickets"
      intro={
        <>
          Train the full network for {LT_EPOCHS} epochs. Then prune: in each layer, set the smallest-magnitude weights
          to zero and keep them there. Retrain the sparse network twice for {LT_EPOCHS} epochs: once from its original
          starting weights (the &ldquo;winning ticket&rdquo;), and once from a fresh random start with the same
          connections. The lottery ticket hypothesis says the original start matters: training found a sub-network that
          was well placed from the beginning.
        </>
      }
      tryThis={[
        'At 90% sparsity press Run. The ticket loses a little accuracy; the same connections from a fresh start learn more slowly and lose far more.',
        'Try 50%: half the weights go, and both pruned networks do about as well as the dense one. There is plenty of spare capacity.',
        'Push to 95–98%. Both fall, but the ticket stays well ahead. Changing the sparsity reuses the trained dense network, so each try only retrains.',
      ]}
      takeaway="Most weights in a trained network can be removed. The surviving connections work best with their original starting values, which suggests a large network trains well partly because it contains many small sub-networks, and one of them happens to start in a good place."
    >
      <div className="dl-controls">
        <Slider
          label="Sparsity (weights removed)"
          value={sparsity}
          min={0}
          max={0.98}
          step={0.01}
          onChange={setSparsity}
          show={(v) => `${Math.round(v * 100)}%`}
        />
        <RunButtons job={job} done={s.phase === 'done'} />
        <button className="btn small" onClick={() => setSeed((v) => v + 1)}>
          New start
        </button>
        <span className="small muted">{status}</span>
      </div>
      <Legend
        items={[
          ['s1', 'Dense network'],
          ['s3', 'Pruned, original start (ticket)'],
          ['s2', 'Pruned, fresh random start'],
        ]}
      />
      <div className="dl-cols">
        <div>
          <b className="small">Test accuracy</b>
          <Plot
            x={[0, LT_EPOCHS]}
            y={[0, 1]}
            height={220}
            xLabel="epoch"
            ariaLabel="Test accuracy against epoch for the dense network, the winning ticket and the re-initialised network"
            draw={(f) => {
              f.hline(0.25, f.c.muted);
              f.line(s.dense.epochs, s.dense.testAcc, f.c.s1, 2, s.phase === 'dense' ? [] : [5, 4]);
              if (s.ticket) f.line(s.ticket.epochs, s.ticket.testAcc, f.c.s3);
              if (s.fresh) f.line(s.fresh.epochs, s.fresh.testAcc, f.c.s2);
            }}
          />
        </div>
        <div>
          <b className="small">Trained weight sizes, middle layer</b>
          {hist ? (
            <Plot
              x={[0, hist.top]}
              y={[0, Math.max(...hist.fractions) * 1.1]}
              height={220}
              xLabel="|weight|"
              ariaLabel="Histogram of trained weight magnitudes with the pruning cut"
              draw={(f: Frame) => {
                const w = hist.top / bins;
                hist.fractions.forEach((v, i) => {
                  const x0 = i * w;
                  f.ctx.fillStyle = x0 + w <= hist.cut ? f.c.muted : f.c.s3;
                  const left = f.x(x0);
                  const right = f.x(x0 + w);
                  f.ctx.fillRect(left + 0.5, f.y(v), Math.max(1, right - left - 1), f.y(0) - f.y(v));
                });
                f.vline(hist.cut, f.c.bad);
              }}
            />
          ) : (
            <p className="dl-caption">Appears once the dense network has trained.</p>
          )}
          <p className="dl-caption">Grey weights fall below the cut (red) and are removed; green ones are kept.</p>
        </div>
      </div>
      <Readout
        items={[
          ['weights kept', `${s.kept} of ${s.total}`],
          ['dense: test accuracy', pct(last(s.dense.testAcc))],
          ['ticket: test accuracy', s.ticket ? pct(last(s.ticket.testAcc)) : '–'],
          ['fresh start: test accuracy', s.fresh ? pct(last(s.fresh.testAcc)) : '–'],
        ]}
      />
      {history.length > 0 && (
        <div className="dl-scroll">
          <table className="dl-table">
            <thead>
              <tr>
                <th>Sparsity</th>
                <th>Dense</th>
                <th>Ticket (original start)</th>
                <th>Fresh start</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.sparsity}>
                  <td>{Math.round(h.sparsity * 100)}%</td>
                  <td>{pct(h.dense)}</td>
                  <td>{pct(h.ticket)}</td>
                  <td>{pct(h.fresh)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Notebook>
  );
}

// ---------- 20.4 Adversarial attacks ----------

const ADV_TRAIN_SET = makeSignals(300, 61);
const ADV_EPOCHS = 40;
const ADV_CURVE_N = 200;
const EPS_GRID = linspace(0, 0.3, 31);

/** ∂(cross-entropy for the true class)/∂input: the direction that raises the loss fastest. */
function inputLossGradient(net: Mlp, x: Float64Array, label: number): Float64Array {
  const acts = forward(net, x);
  const p = softmaxOf(acts[acts.length - 1]);
  p[label] -= 1;
  return backward(net, acts, p, null, null);
}

const perturb = (x: Float64Array, dir: Float64Array, eps: number) => x.map((v, j) => v + eps * dir[j]);

interface AdvState {
  net: Mlp;
  opt: Opt;
  rand: () => number;
  epoch: number;
  done: boolean;
}

function AdversarialAttacks() {
  const [eps, setEps] = useState(0.08);
  const [example, setExample] = useState(0);
  const [kind, setKind] = useState<'fgsm' | 'random'>('fgsm');
  const job = useJob<AdvState>(
    () => {
      const net = initMlp(SIZES, 71);
      return { net, opt: makeOpt(net, 0.1), rand: rng(72), epoch: 0, done: false };
    },
    (s) => {
      if (s.done) return true;
      for (let k = 0; k < 2; k++) epoch(s.net, s.opt, ADV_TRAIN_SET, 20, s.rand);
      s.epoch += 2;
      s.done = s.epoch >= ADV_EPOCHS;
      return s.done;
    },
    [],
    true,
  );
  const { s } = job;

  // Once trained: the FGSM direction sign(∇ₓℓ) and a random ±1 direction for each test signal, and accuracy against ε.
  const attack = useMemo(() => {
    if (!s.done) return null;
    const r = rng(5);
    const signs = TEST.X.map((x, i) => inputLossGradient(s.net, x, TEST.y[i]).map(Math.sign));
    const randoms = TEST.X.map(() => Float64Array.from({ length: SIG_LEN }, () => (r() < 0.5 ? -1 : 1)));
    const accuracy = (dirs: Float64Array[]) =>
      EPS_GRID.map((e) => {
        let right = 0;
        for (let i = 0; i < ADV_CURVE_N; i++)
          if (argmax(predict(s.net, perturb(TEST.X[i], dirs[i], e))) === TEST.y[i]) right++;
        return right / ADV_CURVE_N;
      });
    return { signs, randoms, fgsmAcc: accuracy(signs), randomAcc: accuracy(randoms) };
  }, [s.done, s.net]);

  const x = TEST.X[example];
  const label = TEST.y[example];
  const dir = attack ? (kind === 'fgsm' ? attack.signs[example] : attack.randoms[example]) : new Float64Array(SIG_LEN);
  const xAdv = perturb(x, dir, eps);
  const before = predict(s.net, x);
  const after = predict(s.net, xAdv);
  let flipAt = NaN;
  if (attack) {
    for (let e = 0; e <= 1; e += 0.0025) {
      if (argmax(predict(s.net, perturb(x, attack.signs[example], e))) !== label) {
        flipAt = e;
        break;
      }
    }
  }
  return (
    <Notebook
      id="20.4"
      title="Adversarial attacks"
      intro={
        <>
          A network trained on the signals from 20.1 (it trains itself when the page opens). The fast gradient sign
          method (FGSM) computes how the loss for the true class changes with each input sample, ∇ₓℓ, and moves every
          sample by ε in the direction that raises the loss: x′ = x + ε·sign(∇ₓℓ). For comparison, a random perturbation
          moves every sample by the same ε in a random direction.
        </>
      }
      tryThis={[
        'Raise ε slowly. For many signals the prediction flips between ε = 0.05 and 0.1, smaller than the noise already in the data (standard deviation about 0.15). The perturbed signal still looks like its class.',
        'Switch to the random perturbation. At the same ε the prediction hardly moves: what matters is the direction, not the size.',
        'Read the accuracy curve: FGSM takes the test accuracy to almost zero by ε = 0.2, while random noise of the same size costs far less.',
      ]}
      takeaway="Every sample moves by at most ε, but FGSM lines the moves up with the network's gradient, so their effects add across all 32 inputs. Inputs with many dimensions give an attacker many small pushes to combine; in images with millions of pixels the change can be invisible."
    >
      <div className="dl-controls">
        <Slider label="ε" value={eps} min={0} max={0.3} step={0.005} onChange={setEps} show={(v) => v.toFixed(3)} />
        <Slider
          label="Test signal"
          value={example}
          min={0}
          max={49}
          step={1}
          onChange={setExample}
          show={(v) => String(v + 1)}
        />
        <Chips
          options={[
            { id: 'fgsm', label: 'FGSM: ε·sign(∇ₓℓ)' },
            { id: 'random', label: 'Random ±ε' },
          ]}
          value={kind}
          onChange={setKind}
        />
        {!s.done && (
          <span className="small muted">
            training, epoch {s.epoch} of {ADV_EPOCHS}…
          </span>
        )}
      </div>
      <div className="dl-cols">
        <div>
          <b className="small">The signal (true class: {CLASS_NAMES[label]})</b>
          <Plot
            x={[0, SIG_LEN - 1]}
            y={[-2, 2]}
            height={200}
            xLabel="sample"
            ariaLabel="The original and perturbed test signal"
            draw={(f) => {
              f.line(SIG_XS, Array.from(x), f.c.ink2, 2);
              f.line(SIG_XS, Array.from(xAdv), f.c.s2, 2, [5, 3]);
            }}
          />
          <Legend
            items={[
              ['ink2', 'Original'],
              ['s2', 'Perturbed'],
            ]}
          />
        </div>
        <div>
          <b className="small">The perturbation x′ − x</b>
          <Plot
            x={[0, SIG_LEN - 1]}
            y={[-0.35, 0.35]}
            height={200}
            xLabel="sample"
            ariaLabel="The perturbation added to each sample"
            draw={(f) => {
              f.hline(0, f.c.muted, []);
              f.ctx.fillStyle = f.c.s2;
              for (let j = 0; j < SIG_LEN; j++) {
                const top = f.y(Math.max(0, eps * dir[j]));
                const base = f.y(Math.min(0, eps * dir[j]));
                f.ctx.fillRect(f.x(j) - 3, top, 6, Math.max(1, base - top));
              }
            }}
          />
          <p className="dl-caption">Every sample moves by exactly ε, up or down.</p>
        </div>
      </div>
      <div className="dl-cols">
        <div className="dl-scroll">
          <table className="dl-table">
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>Class</th>
                <th>Probability before</th>
                <th>after</th>
              </tr>
            </thead>
            <tbody>
              {CLASS_NAMES.map((name, c) => (
                <tr key={name}>
                  <td style={{ textAlign: 'left' }}>
                    {name}
                    {c === label ? ' (true)' : ''}
                  </td>
                  <td style={{ fontWeight: c === argmax(before) ? 700 : undefined }}>{pct(before[c])}</td>
                  <td style={{ fontWeight: c === argmax(after) ? 700 : undefined }}>{pct(after[c])}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Readout
            items={[
              ['prediction after', CLASS_NAMES[argmax(after)]],
              ['smallest FGSM ε that flips it', attack ? (Number.isFinite(flipAt) ? flipAt.toFixed(3) : '> 1') : '–'],
              ['ε / noise std', `${(eps / NOISE).toFixed(2)}×`],
            ]}
          />
        </div>
        <div>
          <b className="small">Test accuracy against ε ({ADV_CURVE_N} test signals)</b>
          <Plot
            x={[0, 0.3]}
            y={[0, 1]}
            height={200}
            xLabel="ε"
            ariaLabel="Test accuracy against the size of the perturbation, for FGSM and for random perturbations"
            draw={(f) => {
              f.hline(0.25, f.c.muted);
              if (attack) {
                f.line(EPS_GRID, attack.randomAcc, f.c.s1);
                f.line(EPS_GRID, attack.fgsmAcc, f.c.s2);
              }
              f.vline(eps, f.c.ink2);
            }}
          />
          <Legend
            items={[
              ['s2', 'FGSM'],
              ['s1', 'Random ±ε'],
            ]}
          />
        </div>
      </div>
    </Notebook>
  );
}

// ---------- 21.1 Bias mitigation ----------

/** The standard normal CDF, from the Abramowitz and Stegun approximation to erf (error below 1.5 × 10⁻⁷). */
function normCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-x * x);
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

const normPdf = (x: number, m: number, sd: number) =>
  Math.exp(-0.5 * ((x - m) / sd) ** 2) / (sd * Math.sqrt(2 * Math.PI));

const MU_REPAY = 62;
const MU_DEFAULT = 42;
const SD_A = 11;

interface Group {
  rate: number; // share of the group who would repay
  sd: number; // spread of the score within each outcome
}

/** What a threshold τ on the score does to one group: everyone with a score at or above τ gets the loan. */
function outcomes(g: Group, tau: number) {
  const tpr = 1 - normCdf((tau - MU_REPAY) / g.sd); // share of repayers accepted
  const fpr = 1 - normCdf((tau - MU_DEFAULT) / g.sd); // share of defaulters accepted
  const accept = g.rate * tpr + (1 - g.rate) * fpr;
  const ppv = accept > 0 ? (g.rate * tpr) / accept : NaN; // of those accepted, the share who repay
  const acc = g.rate * tpr + (1 - g.rate) * (1 - fpr);
  return { tpr, fpr, accept, ppv, acc };
}

type Metric = 'accept' | 'tpr';

/** The threshold for group B that gives the same value of `metric` as `target`. Both metrics fall as τ rises. */
function matchThreshold(g: Group, metric: Metric, target: number): number {
  let lo = -50;
  let hi = 150;
  for (let k = 0; k < 60; k++) {
    const mid = (lo + hi) / 2;
    if (outcomes(g, mid)[metric] > target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** The pair of thresholds with the highest overall accuracy, optionally subject to a fairness constraint. */
function bestThresholds(a: Group, b: Group, rule: 'one' | 'free' | Metric): [number, number] {
  let best: [number, number] = [50, 50];
  let bestAcc = -1;
  for (let ta = 20; ta <= 85; ta += 0.1) {
    let tb: number;
    if (rule === 'one') tb = ta;
    else if (rule === 'free') tb = NaN;
    else tb = matchThreshold(b, rule, outcomes(a, ta)[rule]);
    const accA = outcomes(a, ta).acc;
    if (rule === 'free') {
      if (accA > bestAcc) [bestAcc, best] = [accA, [ta, best[1]]];
      continue;
    }
    const total = (accA + outcomes(b, tb).acc) / 2;
    if (total > bestAcc) [bestAcc, best] = [total, [ta, tb]];
  }
  if (rule === 'free') {
    let bAcc = -1;
    for (let tb = 20; tb <= 85; tb += 0.1) {
      const v = outcomes(b, tb).acc;
      if (v > bAcc) [bAcc, best[1]] = [v, tb];
    }
  }
  return [+best[0].toFixed(1), +best[1].toFixed(1)];
}

const SCORE_XS = linspace(0, 100, 201);

function BiasMitigation() {
  const [rateA, setRateA] = useState(0.6);
  const [rateB, setRateB] = useState(0.35);
  const [sdB, setSdB] = useState(15);
  const [mode, setMode] = useState<'one' | 'two'>('one');
  const [tauA, setTauA] = useState(52);
  const [tauB, setTauB] = useState(52);
  const a: Group = { rate: rateA, sd: SD_A };
  const b: Group = { rate: rateB, sd: sdB };
  const tB = mode === 'one' ? tauA : tauB;
  const oa = outcomes(a, tauA);
  const ob = outcomes(b, tB);
  const overall = (oa.acc + ob.acc) / 2;
  const preset = (rule: 'one' | 'free' | Metric) => {
    const [x, y] = bestThresholds(a, b, rule);
    setMode(rule === 'one' ? 'one' : 'two');
    setTauA(x);
    setTauB(y);
  };
  const close = (u: number, v: number) => Math.abs(u - v) < 0.01;
  const rows: { name: string; criterion: string; va: number; vb: number; holds: boolean }[] = [
    {
      name: 'Accepted',
      criterion: 'Demographic parity',
      va: oa.accept,
      vb: ob.accept,
      holds: close(oa.accept, ob.accept),
    },
    {
      name: 'Repayers accepted (TPR)',
      criterion: 'Equal opportunity',
      va: oa.tpr,
      vb: ob.tpr,
      holds: close(oa.tpr, ob.tpr),
    },
    {
      name: 'Defaulters accepted (FPR)',
      criterion: 'Equalised odds (with TPR)',
      va: oa.fpr,
      vb: ob.fpr,
      holds: close(oa.tpr, ob.tpr) && close(oa.fpr, ob.fpr),
    },
    {
      name: 'Accepted who repay (precision)',
      criterion: 'Predictive parity',
      va: oa.ppv,
      vb: ob.ppv,
      holds: close(oa.ppv, ob.ppv),
    },
    { name: 'Accuracy', criterion: '', va: oa.acc, vb: ob.acc, holds: close(oa.acc, ob.acc) },
  ];
  const yMax = 0.042;
  const density = (g: Group, tau: number, title: string) => (
    <div>
      <b className="small">{title}</b>
      <Plot
        x={[0, 100]}
        y={[0, yMax]}
        height={170}
        xLabel="score"
        ariaLabel={`${title}: score distributions of people who repay and who default, with the threshold`}
        draw={(f) => {
          f.line(
            SCORE_XS,
            SCORE_XS.map((s) => g.rate * normPdf(s, MU_REPAY, g.sd)),
            f.c.s3,
          );
          f.line(
            SCORE_XS,
            SCORE_XS.map((s) => (1 - g.rate) * normPdf(s, MU_DEFAULT, g.sd)),
            f.c.s2,
          );
          f.vline(tau, f.c.ink, []);
          f.text('loan →', tau + 1.5, yMax * 0.92, f.c.ink);
        }}
      />
    </div>
  );
  const roc = (g: Group) => {
    const pts = linspace(-20, 130, 151).map((t) => outcomes(g, t));
    return { xs: pts.map((p) => p.fpr), ys: pts.map((p) => p.tpr) };
  };
  const rocA = roc(a);
  const rocB = roc(b);
  return (
    <Notebook
      id="21.1"
      title="Bias mitigation"
      intro={
        <>
          A lender has a credit score for two equally large groups, A and B, and gives a loan to anyone at or above a
          threshold. In both groups, people who would repay average {MU_REPAY} and people who would default average{' '}
          {MU_DEFAULT}. But more of group A would repay, and the score is noisier for group B. The model is fixed; all
          we can change is the threshold for each group, which is a post-processing fix for bias. Each fairness
          criterion compares one rate between the groups.
        </>
      }
      tryThis={[
        'Press Best single threshold: it ignores group membership. Group B gets far fewer loans, and its repayers are also accepted less often.',
        'Press Demographic parity: both groups now get loans at the same rate, but the rates of repayers and defaulters accepted no longer match.',
        'Press Equal opportunity: repayers in both groups have the same chance of a loan, but the acceptance rates and the precision differ. No pair of thresholds turns every criterion green.',
        'Set both repay rates equal and group B’s spread to 11: the groups are now identical and one threshold satisfies everything. The conflict comes from the differences between the groups.',
      ]}
      takeaway="Fairness criteria that each sound reasonable cannot all hold when base rates differ and the score is imperfect. Choosing one is a value judgment, not a technical detail, and each choice usually costs some accuracy."
    >
      <div className="dl-controls">
        <Slider label="Group A: share who repay" value={rateA} min={0.1} max={0.9} onChange={setRateA} show={pct} />
        <Slider label="Group B: share who repay" value={rateB} min={0.1} max={0.9} onChange={setRateB} show={pct} />
        <Slider
          label="Group B: score spread"
          value={sdB}
          min={8}
          max={20}
          step={0.5}
          onChange={setSdB}
          show={(v) => `${v} (A: ${SD_A})`}
        />
      </div>
      <div className="dl-controls">
        <Chips
          options={[
            { id: 'one', label: 'One threshold' },
            { id: 'two', label: 'A threshold per group' },
          ]}
          value={mode}
          onChange={(m) => (setMode(m), m === 'two' && setTauB(tauA))}
        />
        <Slider
          label={mode === 'one' ? 'Threshold' : 'Threshold A'}
          value={tauA}
          min={20}
          max={85}
          step={0.1}
          onChange={setTauA}
          show={(v) => v.toFixed(1)}
        />
        {mode === 'two' && (
          <Slider
            label="Threshold B"
            value={tauB}
            min={20}
            max={85}
            step={0.1}
            onChange={setTauB}
            show={(v) => v.toFixed(1)}
          />
        )}
      </div>
      <div className="dl-controls">
        <button className="btn small" onClick={() => preset('one')}>
          Best single threshold
        </button>
        <button className="btn small" onClick={() => preset('free')}>
          Best per group
        </button>
        <button className="btn small" onClick={() => preset('accept')}>
          Demographic parity
        </button>
        <button className="btn small" onClick={() => preset('tpr')}>
          Equal opportunity
        </button>
      </div>
      <Legend
        items={[
          ['s3', 'Would repay'],
          ['s2', 'Would default'],
          ['ink', 'Threshold'],
        ]}
      />
      <div className="dl-cols">
        {density(a, tauA, `Group A (threshold ${tauA.toFixed(1)})`)}
        {density(b, tB, `Group B (threshold ${tB.toFixed(1)})`)}
      </div>
      <div className="dl-cols">
        <div className="dl-scroll">
          <table className="dl-table">
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>Rate</th>
                <th>Group A</th>
                <th>Group B</th>
                <th style={{ textAlign: 'left' }}>Criterion: equal across groups</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.name}>
                  <td style={{ textAlign: 'left' }}>{r.name}</td>
                  <td>{pct(r.va)}</td>
                  <td>{pct(r.vb)}</td>
                  <td
                    style={{
                      textAlign: 'left',
                      color: r.criterion ? (r.holds ? 'var(--good)' : 'var(--bad)') : undefined,
                    }}
                  >
                    {r.criterion ? `${r.holds ? '✓' : '✗'} ${r.criterion}` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Readout
            items={[
              ['overall accuracy', pct(overall)],
              ['criteria met', rows.filter((r) => r.criterion && r.holds).length + ' of 4'],
            ]}
          />
          <p className="dl-caption">A criterion counts as met when the two groups are within one percentage point.</p>
        </div>
        <div>
          <b className="small">ROC curves: every threshold, for each group</b>
          <Plot
            x={[0, 1]}
            y={[0, 1]}
            height={230}
            xLabel="defaulters accepted (FPR)"
            yLabel="repayers accepted (TPR)"
            ariaLabel="ROC curves for both groups with the current operating points"
            draw={(f) => {
              f.line([0, 1], [0, 1], f.c.muted, 1, [4, 4]);
              f.line(rocA.xs, rocA.ys, f.c.s1);
              f.line(rocB.xs, rocB.ys, f.c.s4);
              f.dots([[oa.fpr, oa.tpr]], f.c.s1, 6);
              f.dots([[ob.fpr, ob.tpr]], f.c.s4, 6);
            }}
          />
          <Legend
            items={[
              ['s1', 'Group A'],
              ['s4', 'Group B'],
            ]}
          />
          <p className="dl-caption">
            Equalised odds needs both dots at the same place, which is only possible where the curves cross.
          </p>
        </div>
      </div>
    </Notebook>
  );
}

// ---------- 21.2 Explainability ----------

const EX_SIZES = [2, 24, 24, 2];
const EX_RANGE: [number, number] = [-2.5, 2.5];
const LIME_SAMPLES = 300;
const EX_EPOCHS = 150;

/** Points in a square, labelled by which side of a wavy curve they fall, with 4% of labels flipped. */
const EX_DATA: Dataset = (() => {
  const r = rng(81);
  const X: Float64Array[] = [];
  const y: number[] = [];
  for (let k = 0; k < 240; k++) {
    const p = Float64Array.from([4.6 * r() - 2.3, 4.6 * r() - 2.3]);
    let label = p[1] > 0.9 * Math.sin(1.7 * p[0]) - 0.2 * p[0] ? 1 : 0;
    if (r() < 0.04) label = 1 - label;
    X.push(p);
    y.push(label);
  }
  return { X, y };
})();

/** p(class 1 | x) and its gradient with respect to the two inputs. */
function probAndGradient(net: Mlp, x: Float64Array) {
  const acts = forward(net, x);
  const p = softmaxOf(acts[acts.length - 1]);
  const s = p[0] * p[1]; // ∂p₁/∂z₁ = p₁(1 − p₁) = p₀p₁, and ∂p₁/∂z₀ = −p₀p₁
  const g = backward(net, acts, Float64Array.from([-s, s]), null, null);
  return { p: p[1], g: [g[0], g[1]] as [number, number] };
}

/** Solves the 3 × 3 system A v = c by Gaussian elimination with partial pivoting. */
function solve3(A: number[][], c: number[]): number[] {
  const M = A.map((row, i) => [...row, c[i]]);
  for (let k = 0; k < 3; k++) {
    let piv = k;
    for (let i = k + 1; i < 3; i++) if (Math.abs(M[i][k]) > Math.abs(M[piv][k])) piv = i;
    [M[k], M[piv]] = [M[piv], M[k]];
    const d = M[k][k] || 1e-12;
    for (let i = k + 1; i < 3; i++) {
      const f = M[i][k] / d;
      for (let j = k; j < 4; j++) M[i][j] -= f * M[k][j];
    }
  }
  const v = [0, 0, 0];
  for (let i = 2; i >= 0; i--) {
    let s = M[i][3];
    for (let j = i + 1; j < 3; j++) s -= M[i][j] * v[j];
    v[i] = s / (M[i][i] || 1e-12);
  }
  return v;
}

/**
 * LIME: probe the model at points around x₀, weight each by closeness, and fit p ≈ β₀ + β·(x − x₀) by weighted
 * least squares. Returns the samples, their weights, the coefficients and the weighted R² of the fit.
 */
function lime(net: Mlp, x0: [number, number], width: number, unit: [number, number][]) {
  const pts = unit.map(([u, v]) => [x0[0] + 2 * width * u, x0[1] + 2 * width * v] as [number, number]);
  const ps = pts.map((q) => predict(net, Float64Array.from(q))[1]);
  const ws = pts.map(([a, b]) => Math.exp(-((a - x0[0]) ** 2 + (b - x0[1]) ** 2) / (2 * width * width)));
  const A = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const c = [0, 0, 0];
  pts.forEach(([a, b], k) => {
    const f = [1, a - x0[0], b - x0[1]];
    for (let i = 0; i < 3; i++) {
      c[i] += ws[k] * f[i] * ps[k];
      for (let j = 0; j < 3; j++) A[i][j] += ws[k] * f[i] * f[j];
    }
  });
  const beta = solve3(A, c);
  const wSum = ws.reduce((s, w) => s + w, 0);
  const pMean = ps.reduce((s, p, k) => s + ws[k] * p, 0) / wSum;
  let sse = 0;
  let sst = 0;
  pts.forEach(([a, b], k) => {
    const fit = beta[0] + beta[1] * (a - x0[0]) + beta[2] * (b - x0[1]);
    sse += ws[k] * (ps[k] - fit) ** 2;
    sst += ws[k] * (ps[k] - pMean) ** 2;
  });
  return { pts, ps, ws, beta, r2: sst > 1e-12 ? 1 - sse / sst : 1 };
}

/** Draws an arrow from (x, y) along (dx, dy), in data units. */
function arrow(f: Frame, x: number, y: number, dx: number, dy: number, colour: string) {
  const [x1, y1, x2, y2] = [f.x(x), f.y(y), f.x(x + dx), f.y(y + dy)];
  const ang = Math.atan2(y2 - y1, x2 - x1);
  const { ctx } = f;
  ctx.save();
  ctx.strokeStyle = colour;
  ctx.fillStyle = colour;
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - 10 * Math.cos(ang - 0.4), y2 - 10 * Math.sin(ang - 0.4));
  ctx.lineTo(x2 - 10 * Math.cos(ang + 0.4), y2 - 10 * Math.sin(ang + 0.4));
  ctx.fill();
  ctx.restore();
}

/** The line where a linear model value + slope·(x − x0) equals 0.5, as two far-apart points. */
function halfLine(x0: [number, number], value: number, slope: [number, number]): [number[], number[]] | null {
  const n2 = slope[0] ** 2 + slope[1] ** 2;
  if (n2 < 1e-12) return null;
  const k = (0.5 - value) / n2;
  const q = [x0[0] + k * slope[0], x0[1] + k * slope[1]];
  const d = [-slope[1] / Math.sqrt(n2), slope[0] / Math.sqrt(n2)];
  return [
    [q[0] - 10 * d[0], q[0] + 10 * d[0]],
    [q[1] - 10 * d[1], q[1] + 10 * d[1]],
  ];
}

interface ExState {
  net: Mlp;
  opt: Opt;
  rand: () => number;
  epoch: number;
  done: boolean;
}

function Explainability() {
  const [x0, setX0] = useState<[number, number]>([0.9, 0.6]);
  const [width, setWidth] = useState(0.3);
  const [seed, setSeed] = useState(1);
  const job = useJob<ExState>(
    () => {
      const net = initMlp(EX_SIZES, 82);
      return { net, opt: makeOpt(net, 0.003, true), rand: rng(83), epoch: 0, done: false };
    },
    (s) => {
      if (s.done) return true;
      for (let k = 0; k < 15; k++) epoch(s.net, s.opt, EX_DATA, 24, s.rand);
      s.epoch += 15;
      s.done = s.epoch >= EX_EPOCHS;
      return s.done;
    },
    [],
    true,
  );
  const { s } = job;
  const unit = useMemo(() => {
    const r = rng(seed + 90);
    return Array.from({ length: LIME_SAMPLES }, () => [gauss(r), gauss(r)] as [number, number]);
  }, [seed]);
  const here = probAndGradient(s.net, Float64Array.from(x0));
  const fit = lime(s.net, x0, width, unit);
  const beta: [number, number] = [fit.beta[1], fit.beta[2]];
  const g = here.g;
  const norm = (v: [number, number]) => Math.hypot(v[0], v[1]);
  const cosine = norm(g) > 1e-9 && norm(beta) > 1e-9 ? (g[0] * beta[0] + g[1] * beta[1]) / (norm(g) * norm(beta)) : NaN;
  const angle = (Math.acos(Math.max(-1, Math.min(1, cosine))) * 180) / Math.PI;
  const scale = 0.9 / Math.max(norm(g), norm(beta), 1e-9);
  const gLine = halfLine(x0, here.p, g);
  const bLine = halfLine(x0, fit.beta[0], beta);
  return (
    <Notebook
      id="21.2"
      title="Explainability"
      intro={
        <>
          A small network (two inputs, two hidden layers of 24 ReLUs) has learned to separate two classes along a wavy
          boundary. To explain its output p = Pr(class 1) at one input x₀, there are two common local answers. Gradient
          saliency asks how p changes for an infinitely small move: ∇p at x₀. LIME treats the model as a black box: it
          probes it at {LIME_SAMPLES} nearby points, weights each by closeness (kernel width σ), and fits a linear model
          p ≈ β₀ + β·(x − x₀). The coefficients β are the explanation.
        </>
      }
      tryThis={[
        'Shrink σ to 0.02. LIME’s arrow lines up with the gradient: a linear fit to a tiny neighbourhood is the first-order Taylor expansion.',
        'Widen σ to 1. LIME now averages the slope over a large patch, bends included: its arrow shrinks and turns away from the gradient, and its fit (R²) gets worse.',
        'Drag x₀ into one class, about half a unit from the boundary. The model is confident, so the gradient is almost zero. LIME with σ = 0.3 still reports a clear slope, because its probes reach the boundary.',
      ]}
      takeaway="Both are local explanations, and they answer slightly different questions: the gradient describes an infinitely small neighbourhood, LIME a neighbourhood you choose. Neither explains the whole model, and the explanation can change with the choice of σ, so it should be read with its fidelity."
    >
      <div className="dl-controls">
        <Slider
          label="LIME kernel width σ"
          value={width}
          min={0.02}
          max={1.2}
          step={0.01}
          onChange={setWidth}
          show={(v) => v.toFixed(2)}
        />
        <button className="btn small" onClick={() => setSeed((v) => v + 1)}>
          New LIME samples
        </button>
        {!s.done && (
          <span className="small muted">
            training, epoch {s.epoch} of {EX_EPOCHS}…
          </span>
        )}
      </div>
      <Plot
        x={EX_RANGE}
        y={EX_RANGE}
        height={340}
        xLabel="x₁"
        yLabel="x₂"
        ariaLabel="The model's probability as a heat map, with LIME's samples, the gradient and LIME's coefficients at the chosen point"
        onDrag={(a, b) => setX0([Math.max(-2.4, Math.min(2.4, a)), Math.max(-2.4, Math.min(2.4, b))])}
        draw={(f) => {
          f.heat((a, b) => {
            const p = predict(s.net, Float64Array.from([a, b]))[1];
            return p >= 0.5 ? mix(f.c.surface, f.c.s1, (p - 0.5) * 1.3) : mix(f.c.surface, f.c.s2, (0.5 - p) * 1.3);
          }, 56);
          fit.pts.forEach((q, k) => {
            f.ctx.globalAlpha = 0.25 + 0.75 * fit.ws[k];
            f.dots([q], fit.ps[k] >= 0.5 ? f.c.s1 : f.c.s2, 1.5 + 3 * fit.ws[k]);
          });
          f.ctx.globalAlpha = 1;
          if (gLine) f.line(gLine[0], gLine[1], f.c.ink, 1.5, [6, 4]);
          if (bLine) f.line(bLine[0], bLine[1], f.c.brand, 1.5, [2, 3]);
          arrow(f, x0[0], x0[1], g[0] * scale, g[1] * scale, f.c.ink);
          arrow(f, x0[0], x0[1], beta[0] * scale, beta[1] * scale, f.c.brand);
          f.dots([x0], f.c.ink, 6);
          f.dots([x0], f.c.surface, 3.5);
        }}
      />
      <Legend
        items={[
          ['ink', 'Gradient ∇p, and where its linear approximation crosses 0.5 (dashed)'],
          ['brand', 'LIME coefficients β, and where its fit crosses 0.5 (dotted)'],
        ]}
      />
      <p className="dl-caption">
        Blue: class 1, orange: class 0. Drag to move x₀. Dots are LIME&apos;s probes, larger for higher weight. Both
        arrows use the same scale.
      </p>
      <Readout
        items={[
          ['p at x₀', fmt(here.p, 3)],
          ['gradient (∂p/∂x₁, ∂p/∂x₂)', `(${fmt(g[0], 2)}, ${fmt(g[1], 2)})`],
          ['LIME (β₁, β₂)', `(${fmt(beta[0], 2)}, ${fmt(beta[1], 2)})`],
          ['angle between them', Number.isFinite(angle) ? `${angle.toFixed(0)}°` : '–'],
          ['LIME fit, weighted R²', fmt(fit.r2, 3)],
        ]}
      />
    </Notebook>
  );
}

export const CHAPTERS: ChapterDef[] = [
  {
    n: 20,
    title: 'Why does deep learning work?',
    blurb:
      'Experiments on questions the theory cannot yet answer: why big networks fit so easily, why they generalise, and why they are easy to fool.',
    notebooks: [
      { id: '20.1', title: 'Random data', Component: RandomData },
      { id: '20.2', title: 'Full-batch gradient descent', Component: FullBatch },
      { id: '20.3', title: 'Lottery tickets', Component: LotteryTickets },
      { id: '20.4', title: 'Adversarial attacks', Component: AdversarialAttacks },
    ],
  },
  {
    n: 21,
    title: 'Deep learning and ethics',
    blurb:
      'Two technical corners of AI ethics: what fairness criteria ask of a classifier, and what a local explanation does and does not tell you.',
    notebooks: [
      { id: '21.1', title: 'Bias mitigation', Component: BiasMitigation },
      { id: '21.2', title: 'Explainability', Component: Explainability },
    ],
  },
];
