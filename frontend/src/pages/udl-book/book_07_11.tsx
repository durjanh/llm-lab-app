/* Chapters 7 to 11 of Understanding Deep Learning: gradients and initialisation, measuring performance,
   regularisation, convolutional networks and residual networks. Two small demos cover examples the notebooks don't. */
import { useMemo, useState } from 'react';
import { Readout, Slider } from '../deep-learning/Notebook';
import { Plot } from '../deep-learning/Plot';
import { fmt, gauss, linspace, mean, rng } from '../deep-learning/kit';
import type { BookChapter } from './types';

// ---------- shared: the 1D regression problem of chapters 8 and 9 ----------

/** The wave the book's regression examples sample from, plus noise. */
const truth = (x: number) => Math.sin(2 * Math.PI * x) + 0.4 * x;
const GRID = linspace(0, 1, 101);
const TRUTH = GRID.map(truth);
const UNITS = 14; // hidden units, as in the book's figures 9.6 and 9.10
const NP = UNITS + 1; // their output weights plus one bias
const SIGMA = 0.3;

/** The simplified shallow network: ReLU units with fixed joints at 0, 1/14, …, 13/14, so only the output layer learns. */
function joints(x: number): Float64Array {
  const h = new Float64Array(NP);
  h[0] = 1;
  for (let k = 0; k < UNITS; k++) h[k + 1] = Math.max(0, x - k / UNITS);
  return h;
}

const GRID_PHI = GRID.map(joints);

function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** Fifteen noisy points, one in each fifteenth of [0, 1], and a small random starting point for training. */
const DATA = (() => {
  const r = rng(7);
  const xs = Array.from({ length: 15 }, (_, i) => (i + r()) / 15);
  const ys = xs.map((x) => truth(x) + SIGMA * gauss(r));
  const w0 = Array.from({ length: NP }, () => 0.2 * gauss(r));
  return { xs, ys, w0, phi: xs.map(joints) };
})();

/** The fitted curve, its mean squared error on the training points, and its mean squared distance from the truth. */
function assess(w: ArrayLike<number>) {
  const fit = GRID_PHI.map((h) => dot(w, h));
  return {
    fit,
    train: mean(DATA.phi.map((h, i) => (dot(w, h) - DATA.ys[i]) ** 2)),
    off: mean(fit.map((v, g) => (v - TRUTH[g]) ** 2)),
  };
}

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

/** Eigenvalues and eigenvectors of a small symmetric matrix by cyclic Jacobi rotations. Column i of `vectors` goes with values[i]. */
function symmetricEigen(A: Float64Array, n: number): { values: number[]; vectors: Float64Array } {
  const a = Float64Array.from(A);
  const V = new Float64Array(n * n);
  for (let i = 0; i < n; i++) V[i * n + i] = 1;
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p * n + q] ** 2;
    if (off < 1e-30) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = a[p * n + q];
        if (Math.abs(apq) < 1e-300) continue;
        const theta = (a[q * n + q] - a[p * n + p]) / (2 * apq);
        const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1),
          s = t * c;
        for (let k = 0; k < n; k++) {
          const kp = a[k * n + p],
            kq = a[k * n + q];
          a[k * n + p] = c * kp - s * kq;
          a[k * n + q] = s * kp + c * kq;
        }
        for (let k = 0; k < n; k++) {
          const pk = a[p * n + k],
            qk = a[q * n + k];
          a[p * n + k] = c * pk - s * qk;
          a[q * n + k] = s * pk + c * qk;
        }
        for (let k = 0; k < n; k++) {
          const kp = V[k * n + p],
            kq = V[k * n + q];
          V[k * n + p] = c * kp - s * kq;
          V[k * n + q] = s * kp + c * kq;
        }
      }
    }
  }
  return { values: Array.from({ length: n }, (_, i) => a[i * n + i]), vectors: V };
}

/** Solves A x = b for a small square system by Gaussian elimination with partial pivoting. */
function solve(A: Float64Array, b: ArrayLike<number>, n: number): Float64Array {
  const M = Array.from({ length: n }, (_, i) => [...A.slice(i * n, i * n + n), b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

// ---------- 9.3a Early stopping ----------

/**
 * Full-batch gradient descent on the mean squared error. The model is linear in its weights, so in the eigenvector
 * basis of the Hessian H each coordinate moves independently: after t steps of size α it has covered a fraction
 * 1 − (1 − αλ)^t of the way to its minimum. That gives the weights after any number of steps without running them.
 */
function earlyStoppingModel() {
  const n = DATA.xs.length;
  const H = new Float64Array(NP * NP),
    b = new Float64Array(NP);
  DATA.phi.forEach((h, i) => {
    for (let j = 0; j < NP; j++) {
      b[j] += (2 / n) * h[j] * DATA.ys[i];
      for (let k = 0; k < NP; k++) H[j * NP + k] += (2 / n) * h[j] * h[k];
    }
  });
  const { values, vectors: V } = symmetricEigen(H, NP);
  const top = Math.max(...values);
  const alpha = Math.min(0.05, 1 / top);
  const project = (v: ArrayLike<number>) =>
    values.map((_, i) => {
      let s = 0;
      for (let k = 0; k < NP; k++) s += V[k * NP + i] * v[k];
      return s;
    });
  const c0 = project(DATA.w0),
    d = project(b);
  const weightsAt = (steps: number) => {
    const w = new Float64Array(NP);
    values.forEach((l0, i) => {
      const l = Math.max(l0, 1e-14 * top);
      const covered = -Math.expm1(steps * Math.log1p(-alpha * l)) / l;
      const c = c0[i] + covered * (d[i] - l0 * c0[i]);
      for (let k = 0; k < NP; k++) w[k] += V[k * NP + i] * c;
    });
    return w;
  };
  const logs = linspace(0, 8, 161);
  const curve = logs.map((e) => assess(weightsAt(10 ** e - 1)));
  const off = curve.map((c) => c.off);
  const best = logs[off.indexOf(Math.min(...off))];
  return { weightsAt, logs, train: curve.map((c) => c.train), off, best };
}

function EarlyStoppingDemo() {
  const model = useMemo(earlyStoppingModel, []);
  const [e, setE] = useState(2);
  const steps = 10 ** e - 1;
  const w = model.weightsAt(steps);
  const now = assess(w);
  const top = Math.max(...model.off, ...model.train) * 1.08;
  return (
    <>
      <div className="dl-controls">
        <Slider
          label="training steps (log scale)"
          value={e}
          min={0}
          max={8}
          step={0.05}
          onChange={setE}
          show={() => Math.round(steps).toLocaleString('en-GB')}
        />
        <button className="btn small" onClick={() => setE(model.best)}>
          Stop at the best step
        </button>
      </div>
      <div className="dl-cols">
        <div>
          <Plot
            x={[0, 1]}
            y={[-2.5, 2.5]}
            xLabel="x"
            yLabel="y"
            ariaLabel="The fitted curve after the chosen number of steps, the true function and the training points"
            draw={(f) => {
              f.line(GRID, TRUTH, f.c.ink, 1.5, [5, 4]);
              f.line(GRID, now.fit, f.c.s1, 2.5);
              f.dots(
                DATA.xs.map((x, i) => [x, DATA.ys[i]] as [number, number]),
                f.c.s2,
                3.5,
              );
            }}
          />
          <div className="dl-caption">
            The 14-unit network from chapter 8 (blue), the true function (dashed) and 15 noisy training points.
          </div>
        </div>
        <div>
          <Plot
            x={[0, 8]}
            y={[0, top]}
            xLabel="log₁₀(1 + steps)"
            yLabel="mean squared error"
            ariaLabel="Training error and distance from the true function against the number of steps"
            draw={(f) => {
              f.line(model.logs, model.train, f.c.s2, 2);
              f.line(model.logs, model.off, f.c.s1, 2);
              f.vline(e, f.c.muted, [4, 3]);
              f.dots([[model.best, Math.min(...model.off)]], f.c.ink, 4);
            }}
          />
          <Legend
            items={[
              ['s2', 'error on the training points'],
              ['s1', 'distance from the true function'],
            ]}
          />
        </div>
      </div>
      <Readout
        items={[
          ['steps', Math.round(steps).toLocaleString('en-GB')],
          ['training error', fmt(now.train)],
          ['distance from the truth', fmt(now.off)],
          ['size of the weights ‖w‖', fmt(Math.hypot(...w))],
        ]}
      />
      <p className="dl-caption">
        Full-batch gradient descent with step size 0.05 from small random weights, worked out in closed form so you can
        jump to any step up to 10⁸. The black dot is where a validation set would tell you to stop. Move past it and the
        training error keeps falling while the curve bends towards the noise and the weights grow.
      </p>
    </>
  );
}

// ---------- 9.3d Adding noise to the inputs ----------

const COPIES = 40; // noisy copies of each training point, standing in for many steps of SGD
const SHOWN = 8; // how many of them to draw
const NOISE_STEP = 0.005;
const NOISE_LEVELS = linspace(0, 0.15, 31);
const EPS = (() => {
  const r = rng(71);
  return DATA.xs.map(() => Array.from({ length: COPIES }, () => gauss(r)));
})();

/** Least squares over every noisy copy: the fit that SGD with fresh input noise at each step settles towards. */
function noisyFit(sx: number): Float64Array {
  const A = new Float64Array(NP * NP),
    b = new Float64Array(NP);
  DATA.xs.forEach((x, i) => {
    for (const e of EPS[i]) {
      const h = joints(x + sx * e);
      for (let j = 0; j < NP; j++) {
        b[j] += h[j] * DATA.ys[i];
        for (let k = 0; k < NP; k++) A[j * NP + k] += h[j] * h[k];
      }
    }
  });
  for (let j = 0; j < NP; j++) A[j * NP + j] += 1e-9;
  return solve(A, b, NP);
}

function InputNoiseDemo() {
  const sweep = useMemo(() => NOISE_LEVELS.map((s) => assess(noisyFit(s))), []);
  const [sx, setSx] = useState(0);
  const idx = Math.round(sx / NOISE_STEP);
  const now = sweep[idx];
  const top = Math.max(...sweep.map((s) => Math.max(s.off, s.train))) * 1.08;
  const copies: [number, number][] = [];
  DATA.xs.forEach((x, i) => EPS[i].slice(0, SHOWN).forEach((e) => copies.push([x + sx * e, DATA.ys[i]])));
  return (
    <>
      <div className="dl-controls">
        <Slider
          label="input noise σₓ"
          value={sx}
          min={0}
          max={0.15}
          step={NOISE_STEP}
          onChange={setSx}
          show={(v) => v.toFixed(3)}
        />
      </div>
      <div className="dl-cols">
        <div>
          <Plot
            x={[0, 1]}
            y={[-2.5, 2.5]}
            xLabel="x"
            yLabel="y"
            ariaLabel="The fit trained on noisy copies of the inputs, the true function and the training points"
            draw={(f) => {
              f.dots(copies, f.c.muted, 1.5);
              f.line(GRID, TRUTH, f.c.ink, 1.5, [5, 4]);
              f.line(GRID, now.fit, f.c.s1, 2.5);
              f.dots(
                DATA.xs.map((x, i) => [x, DATA.ys[i]] as [number, number]),
                f.c.s2,
                3.5,
              );
            }}
          />
          <div className="dl-caption">
            Grey: {SHOWN} of the {COPIES} jittered copies of each point. Each keeps its y but moves its x.
          </div>
        </div>
        <div>
          <Plot
            x={[0, 0.15]}
            y={[0, top]}
            xLabel="input noise σₓ"
            yLabel="mean squared error"
            ariaLabel="Training error and distance from the true function against the input noise"
            draw={(f) => {
              f.line(
                NOISE_LEVELS,
                sweep.map((s) => s.train),
                f.c.s2,
                2,
              );
              f.line(
                NOISE_LEVELS,
                sweep.map((s) => s.off),
                f.c.s1,
                2,
              );
              f.vline(sx, f.c.muted, [4, 3]);
            }}
          />
          <Legend
            items={[
              ['s2', 'error on the training points'],
              ['s1', 'distance from the true function'],
            ]}
          />
        </div>
      </div>
      <Readout
        items={[
          ['training error', fmt(now.train)],
          ['distance from the truth', fmt(now.off)],
        ]}
      />
      <p className="dl-caption">
        The same 15 points and 14-unit network as the early-stopping demo. With no noise the fit passes through every
        point and swings wildly between them. A little noise on x stops the curve from changing steeply near any point,
        because the copies either side would then disagree with it. Too much noise blurs the wave itself.
      </p>
    </>
  );
}

// ---------- the chapters ----------

export const CHAPTERS: BookChapter[] = [
  {
    n: 7,
    title: 'Gradients and initialisation',
    offers: (
      <p>
        How a network gets the gradient of its loss with respect to every parameter in one sweep, and why the starting
        weights decide whether that gradient is any use. Backpropagation is derived first on a chain of scalar
        functions, then for a deep ReLU network. Initialisation is then worked out from how variance changes from one
        layer to the next. A short PyTorch loop at the end puts the first seven chapters together.
      </p>
    ),
    examples: [
      {
        id: '7.3',
        title: 'Backpropagation on a chain of functions',
        page: 100,
        shows: (
          <>
            <p>
              The model is a single path: f = β₃ + ω₃·cos(β₂ + ω₂·exp(β₁ + ω₁·sin(β₀ + ω₀x))), with a squared loss.
              Writing out ∂ℓ/∂ω₀ by hand gives a long expression in which the same pieces appear several times. The
              example instead breaks the computation into eight small steps. The forward pass stores every intermediate
              value. The backward pass starts at the loss and works back, multiplying one local derivative at a time.
            </p>
            <p>
              Each derivative on the way back is built from the one before it, so nothing is computed twice. A
              weight&apos;s gradient is then the value stored at its input times the derivative that reached its output.
              That reuse is the whole of backpropagation.
            </p>
          </>
        ),
        notebooks: ['7.1'],
      },
      {
        id: '7.4',
        title: 'Backpropagation in a deep ReLU network',
        page: 103,
        shows: (
          <>
            <p>
              The same steps with vectors and matrices. Going back through each layer alternates two operations:
              multiply by the transposed weight matrix Ωᵀ, then zero the entries where the ReLU was off on the way
              forward. The gradient for a bias is the derivative at that layer&apos;s pre-activations; the gradient for
              a weight matrix is that derivative times the stored activations, hᵀ.
            </p>
            <p>
              Both passes are dominated by matrix multiplication, which GPUs do well. The catch is memory: every
              activation from the forward pass must be kept until the backward pass uses it. The same method works for
              any graph without loops, which is what frameworks such as PyTorch automate.
            </p>
          </>
        ),
        notebooks: ['7.2'],
      },
      {
        id: '7.5',
        title: 'Initialisation: keeping the variance level',
        page: 107,
        shows: (
          <>
            <p>
              With zero biases and weights drawn with variance σ², one ReLU layer turns pre-activations of variance σ²
              <sub>f</sub> into ones of variance ½·D<sub>h</sub>·σ²·σ²<sub>f</sub>. The half comes from the ReLU zeroing
              half its inputs. Setting σ² = 2/D<sub>h</sub> (He initialisation) keeps the variance constant on the way
              forward. The backward pass gives 2/D<sub>h′</sub>, and 4/(D<sub>h</sub> + D<sub>h′</sub>) is a compromise
              between the two.
            </p>
            <p>
              The book checks this on a network with 50 layers of 100 units, trying σ² from 0.001 to 1. Only 2/100 =
              0.02 keeps both the activations and the gradients level. Smaller values make them shrink exponentially
              with depth (vanishing gradients) and larger ones make them blow up (exploding gradients).
            </p>
          </>
        ),
        notebooks: ['7.3'],
      },
      {
        id: '7.6',
        title: 'Example training code',
        page: 111,
        shows: (
          <p>
            A complete PyTorch script: a network with two hidden layers of 40 units, He initialisation through{' '}
            <i>kaiming_normal_</i>, a least squares loss, SGD with momentum 0.9, and a scheduler that halves the
            learning rate every ten epochs. It trains on 100 random input–output pairs in batches of 10 for 100 epochs.
            The data mean nothing, so the network can only memorise them; the point is that the machinery runs. All of
            backpropagation sits behind one line, <i>loss.backward()</i>.
          </p>
        ),
      },
    ],
    inLlms: (
      <>
        <p>
          Every LLM is trained with this reverse-mode differentiation, through dozens of layers and often more than a
          hundred. What runs out first is memory, not arithmetic: the activations of every token at every layer must be
          kept for the backward pass. Large training runs therefore store only some of them and recompute the rest, and
          attention kernels such as FlashAttention never store the full attention matrix at all.
        </p>
        <p>
          Initialisation follows the variance argument of 7.5. GPT-style models draw their weights from a normal
          distribution with a small fixed standard deviation, and GPT-2 scaled the initial weights of the layers that
          write into the residual path by 1/√N, where N is the number of residual layers, so that their sum does not
          grow with depth. Gradients are clipped by their global norm to stop a rare exploding step, and training in
          bf16, which has the same exponent range as fp32, avoids the underflow of tiny gradients that fp16 suffered
          from.
        </p>
      </>
    ),
    next: [
      <>
        <b>Activation checkpointing</b> (Chen et al., 2016): store activations only every few layers and recompute the
        rest during the backward pass. It costs about one extra forward pass and saves much of the memory, and it is
        standard in large-model training.
      </>,
      <>
        <b>FlashAttention</b> (Dao et al., 2022): computes attention in tiles that fit in fast on-chip memory and
        recomputes them in the backward pass, so memory grows linearly with sequence length instead of quadratically.
      </>,
      <>
        <b>Mixed-precision training</b> (Micikevicius et al., 2018): 16-bit arithmetic with a 32-bit master copy of the
        weights, and loss scaling to stop small gradients rounding to zero. It is the vanishing-gradient problem met
        again in the number format.
      </>,
      <>
        <b>μP, or Tensor Programs V</b> (Yang et al., 2022): scales the initialisation and per-layer learning rates with
        width so that hyperparameters tuned on a small model carry over to a large one.
      </>,
      <>
        <b>T-Fixup</b> (Huang et al., 2020): an initialisation for transformers that lets them train without
        learning-rate warm-up or layer normalisation.
      </>,
    ],
    labs: [
      ['/training', 'Training Lab'],
      ['/training-at-scale', 'Training at Scale'],
      ['/hardware', 'Hardware for AI'],
      ['/deep-learning', 'Deep Learning Notebooks'],
    ],
  },
  {
    n: 8,
    title: 'Measuring performance',
    offers: (
      <p>
        How to tell whether a trained model is any good, and why it can do well on its training data and badly on
        anything new. The test error splits into noise, bias and variance, and adding capacity trades bias for variance,
        until double descent breaks that classical picture. The chapter closes with how to choose hyperparameters
        without tuning to the test set.
      </p>
    ),
    examples: [
      {
        id: '8.1',
        title: 'Training a simple model on MNIST-1D',
        page: 118,
        shows: (
          <>
            <p>
              MNIST-1D has 4,000 training examples of 40 values each, in ten classes. A network with two hidden layers
              of 100 units, trained by SGD (batch 100, learning rate 0.1, 6,000 steps), classifies every training
              example correctly after about 4,000 steps. On 1,000 fresh test examples it is wrong about 40% of the time:
              better than the 90% of guessing, far worse than on the training set.
            </p>
            <p>
              The test loss falls for about 1,500 steps and then rises, while the test error stays flat. The network is
              making the same mistakes with more and more confidence, because the softmax keeps pushing its outputs to
              extremes to fit the training labels. Loss and error can disagree.
            </p>
          </>
        ),
        notebooks: ['8.1'],
      },
      {
        id: '8.2',
        title: 'Noise, bias and variance',
        page: 120,
        shows: (
          <>
            <p>
              A 1D regression problem where the true function is known: a wave sampled with Gaussian noise. The model is
              the simplified network whose joints are fixed and evenly spaced, so least squares fits it exactly and
              training always finds the global minimum.
            </p>
            <p>
              Three things cause test error. <b>Noise</b>: the data themselves vary, and no model can predict that.{' '}
              <b>Bias</b>: even with its best parameters, a model with three linear pieces cannot follow the wave.{' '}
              <b>Variance</b>: with few noisy points, the fit depends on which points you happened to draw. For a
              squared loss the expected test error is exactly the sum: variance plus squared bias plus the noise σ².
            </p>
          </>
        ),
        notebooks: ['8.2'],
      },
      {
        id: '8.3',
        title: 'More data, more capacity, and the trade-off',
        page: 124,
        shows: (
          <>
            <p>
              Fitting the three-piece model to many datasets of 6, 10 and 100 points shows the variance shrinking as the
              data grow. Adding hidden units cuts the bias: with ten pieces the model can follow the wave closely.
            </p>
            <p>
              But with only 15 points the ten-piece model spends its extra freedom on the noise, and its fits differ
              widely between datasets. That is overfitting. Plotting both terms against capacity, their sum is lowest at
              four hidden units for this data: the classical bias–variance trade-off.
            </p>
          </>
        ),
        notebooks: ['8.2'],
      },
      {
        id: '8.4a',
        title: 'Double descent',
        page: 127,
        shows: (
          <>
            <p>
              The trade-off is tested on MNIST-1D with 10,000 training and 5,000 test examples, widening a network with
              two hidden layers (Adam, step 0.005, full batch, 4,000 steps). With clean labels the test error simply
              keeps falling, even after the training set is memorised.
            </p>
            <p>
              With 15% of the labels randomised, the test error rises as the number of parameters nears the number of
              examples, peaks there, then falls again and ends lower than its first minimum. The book names the three
              parts the classical, critical and modern regimes. The same shape is shown for MNIST and for CIFAR-100 with
              a ResNet.
            </p>
          </>
        ),
        notebooks: ['8.3'],
      },
      {
        id: '8.4b',
        title: 'Why double descent happens: sparse data in high dimensions',
        page: 129,
        shows: (
          <>
            <p>
              Cut each of MNIST-1D&apos;s 40 dimensions into 10 bins and there are 10⁴⁰ cells for 10⁴ examples: one
              example per 10³⁶ cells. Almost everything the model does happens between training points, so what matters
              is its inductive bias, its preference among functions that fit the data equally well.
            </p>
            <p>
              Just past the threshold a model has to contort itself to pass through every point. With more capacity it
              can interpolate more smoothly. But nothing obliges it to: the book shows three zero-loss fits of a 50-unit
              model, two of them wild. Something in the initialisation or the training must favour the smooth ones,
              which leads to the implicit regularisation of chapter 9.
            </p>
          </>
        ),
        notebooks: ['8.4', '8.3'],
      },
      {
        id: '8.5',
        title: 'Choosing hyperparameters',
        page: 132,
        shows: (
          <p>
            Bias and variance cannot be measured in practice, and in the modern regime nothing says when to stop adding
            capacity. So hyperparameters (layers, widths, learning rate, batch size) are chosen by experiment. Train
            each candidate on the training set, compare them on a separate validation set, and touch the test set only
            once, for the final estimate. Many hyperparameters are discrete or depend on one another, so gradient
            descent cannot search them, and each trial costs a full training run. The notes add k-fold cross-validation
            for when data are scarce.
          </p>
        ),
      },
    ],
    inLlms: (
      <>
        <p>
          LLM pre-training usually sees each token once or only a few times, so the training loss is already close to a
          held-out loss and there is little gap to measure. Builders still hold validation text aside. The harder
          problem has moved to benchmarks: a test question that has leaked into web-scale training data measures memory,
          not skill. That is this chapter&apos;s train/test split at internet scale.
        </p>
        <p>
          Scaling laws have taken the place of the bias–variance curve. Chinchilla&apos;s fit writes the loss as a
          constant, plus a term that shrinks as parameters grow, plus one that shrinks as tokens grow. The constant
          plays the part of the noise term: the uncertainty in text that no model can remove. Large models sit deep in
          the over-parameterised regime and still generalise. And the over-confidence of 8.1 is why the calibration of
          an LLM&apos;s probabilities is a separate question from its accuracy.
        </p>
      </>
    ),
    next: [
      <>
        <b>Scaling laws</b> (Kaplan et al., 2020) and <b>compute-optimal training</b> (Hoffmann et al., 2022): test loss
        falls as a power law in parameters, data and compute, so the size of a large model and its data can be chosen
        from small pilot runs.
      </>,
      <>
        <b>Deep double descent</b> (Nakkiran et al., 2020): the peak appears as a function of model size and also of
        training time, and more data can sometimes make a model worse near the threshold.
      </>,
      <>
        <b>Grokking</b> (Power et al., 2022): on small algorithmic tasks, test accuracy can jump from chance to near
        perfect long after the training set has been memorised.
      </>,
      <>
        <b>Fresh test sets against contamination</b>: GSM1k (Zhang et al., 2024) wrote new problems in the style of a
        well-known maths benchmark to measure how far models had overfitted the original.
      </>,
    ],
    labs: [
      ['/benchmarks', 'Benchmarks'],
      ['/evals', 'Evals Lab'],
      ['/confidence', 'Confidence and Calibration'],
      ['/ml', 'Machine Learning Algorithms'],
    ],
  },
  {
    n: 9,
    title: 'Regularisation',
    offers: (
      <p>
        A tour of the methods that narrow the gap between training and test performance. It starts with explicit
        penalties such as L2, shows that gradient descent and SGD regularise without being asked, then works through the
        practical heuristics: early stopping, ensembles, dropout, added noise, Bayesian averaging, transfer and
        self-supervised learning, and augmentation. The summary sorts them by four aims: smoother functions, more data,
        combined models and wider minima.
      </p>
    ),
    examples: [
      {
        id: '9.1',
        title: 'Explicit regularisation and L2',
        page: 138,
        shows: (
          <>
            <p>
              Add a penalty λ·g(φ) to the loss. Read as probability, the penalty is a prior on the parameters and the
              fit becomes a maximum a posteriori estimate. On the two-parameter Gabor model from chapter 6, a penalty
              pulling towards the centre removes several local minima and moves the global one.
            </p>
            <p>
              With an L2 penalty on the weights (weight decay), the 14-unit simplified network shows the full range:
              tiny λ passes through every noisy point, moderate λ gives a smooth curve close to the truth, and large λ
              flattens the curve until it fits nothing well.
            </p>
          </>
        ),
        notebooks: ['9.1'],
      },
      {
        id: '9.2',
        title: 'Implicit regularisation in gradient descent and SGD',
        page: 141,
        shows: (
          <>
            <p>
              Gradient descent with step size α does not follow the continuous downhill path. It behaves like that path
              on a modified loss, L + (α/4)·|∇L|², which steers it away from steep regions. SGD adds a further term
              proportional to the variance of the batch gradients, so it favours places where every batch agrees on the
              slope.
            </p>
            <p>
              On MNIST-1D (4,000 training and 4,000 test examples), larger learning rates and smaller batches both give
              better test performance, consistent with these hidden penalties.
            </p>
          </>
        ),
        notebooks: ['9.2'],
      },
      {
        id: '9.3a',
        title: 'Early stopping',
        page: 145,
        shows: (
          <>
            <p>
              The 14-unit network starts from random weights and is trained by SGD (batch 5, learning rate 0.05). It
              picks up the broad shape of the true function first and only later bends to fit the noise. The training
              loss falls the whole time, but the curves part-way through are the closest to the truth.
            </p>
            <p>
              The weights start small and have not had time to grow, so stopping early acts much like L2. There is one
              hyperparameter, when to stop, and it needs only one training run: check the validation loss every few
              steps and keep the best snapshot. The demo below uses full-batch gradient descent, solved in closed form,
              so you can move across a hundred million steps at once.
            </p>
          </>
        ),
        Demo: EarlyStoppingDemo,
      },
      {
        id: '9.3b',
        title: 'Ensembling',
        page: 145,
        shows: (
          <p>
            Train several models and average them: the outputs for regression, the pre-softmax activations for
            classification, or a median or majority vote for robustness. The models can differ by initialisation, by
            hyperparameters or by family. Bagging trains each on a bootstrap sample of the data, drawn with replacement;
            where a point is missing, that model interpolates from its neighbours, so an outlier pulls the average less.
            The average of four bagged fits is smoother than one fit to all the data.
          </p>
        ),
        notebooks: ['9.3'],
      },
      {
        id: '9.3c',
        title: 'Dropout',
        page: 147,
        shows: (
          <>
            <p>
              At each SGD step, set a random subset of hidden units (often half) to zero. The network cannot rely on any
              one unit, and its weights stay smaller.
            </p>
            <p>
              The book&apos;s example is a kink: three units that raise the slope, lower it, then raise it again, making
              a bump between data points. The bump costs nothing on the training loss, so gradient descent never removes
              it. Dropping one of the three changes the output where there are data, the next gradient step compensates,
              and after 2,000 such steps the bump has gone. At test time all units run and the weights are scaled by one
              minus the dropout rate. Alternatively, Monte Carlo dropout runs several random versions and averages them,
              an ensemble from a single trained network.
            </p>
          </>
        ),
      },
      {
        id: '9.3d',
        title: 'Adding noise: inputs, weights and labels',
        page: 149,
        shows: (
          <>
            <p>
              Dropout is multiplicative noise on the activations, which suggests adding noise elsewhere. Noise on the
              inputs smooths the fitted function; for regression it is equivalent to penalising the slope of the output
              with respect to the input. Adversarial training is the worst case of this, searching for the small input
              change that moves the output most. Noise on the weights favours wide, flat minima.
            </p>
            <p>
              Noise on the labels gives <b>label smoothing</b>: train towards a target that puts 1 − ρ on the true class
              and spreads ρ over the others, so the network stops pushing its outputs to extremes. The demo below adds
              noise to the inputs of the same 15 points as the early-stopping demo.
            </p>
          </>
        ),
        Demo: InputNoiseDemo,
      },
      {
        id: '9.3e',
        title: 'Bayesian inference',
        page: 150,
        shows: (
          <p>
            Rather than keep the single most likely parameters, keep a probability for every setting, from Bayes&apos;
            rule, and predict with a weighted average over all of them: an infinite ensemble whose weights combine the
            prior and the fit to the data. On the simplified network, a narrow prior gives smooth sampled curves, and
            the averaged prediction comes with an uncertainty band. For real networks the full posterior is intractable,
            so every practical method approximates it.
          </p>
        ),
        notebooks: ['9.4'],
      },
      {
        id: '9.3f',
        title: 'Transfer, multi-task and self-supervised learning',
        page: 151,
        shows: (
          <>
            <p>
              When labelled data for a task are scarce, borrow from elsewhere. Transfer learning trains on a related
              task with plenty of data, replaces the final layers, then trains only the new layers or fine-tunes
              everything: in effect a well-placed initialisation. Multi-task learning trains one network on several
              tasks at once, such as segmentation, depth and captions for the same image.
            </p>
            <p>
              Self-supervised learning makes its own labels. The generative kind hides part of each example and predicts
              it, such as filling in a masked region of an image or masked words in text. The contrastive kind learns to
              tell related pairs from unrelated ones. The book points ahead to chapter 12 for the language version.
            </p>
          </>
        ),
      },
      {
        id: '9.3g',
        title: 'Data augmentation',
        page: 152,
        shows: (
          <p>
            Grow the dataset with transformations that leave the label unchanged: rotate, flip, blur or recolour an
            image of a bird and it is still a bird. Text can be augmented by swapping synonyms or translating to another
            language and back, audio by boosting or cutting frequency bands. The model learns to ignore changes that do
            not matter.
          </p>
        ),
        notebooks: ['9.5'],
      },
    ],
    inLlms: (
      <>
        <p>
          The LLM recipe is transfer learning built on generative self-supervision: predict the next token over a vast
          corpus, then fine-tune for the task. Instruction tuning across many tasks at once is multi-task learning, and
          adapter methods fine-tune a small set of new weights on a frozen base. Paraphrase and back-translation are
          text augmentation; synthetic data written by other models is the same idea at scale. Sampling several answers
          and taking the majority (self-consistency) is an ensemble at inference time.
        </p>
        <p>
          Weight decay is in nearly every recipe, applied through AdamW; GPT-3 used 0.1. The original Transformer used
          dropout and label smoothing, both at 0.1, but many recent large pre-training runs leave dropout out: with each
          token seen about once, there is little to overfit. Classic early stopping is rare in pre-training, where the
          compute budget sets the end, but it is routine when fine-tuning on a small dataset.
        </p>
      </>
    ),
    next: [
      <>
        <b>AdamW</b> (Loshchilov &amp; Hutter, 2019): with adaptive optimisers an L2 penalty in the loss is not the same
        as decaying the weights. Decoupling the two improved generalisation, and the decoupled form is what LLMs use.
      </>,
      <>
        <b>Sharpness-aware minimisation</b> (Foret et al., 2021): takes each step from the worst point in a small
        neighbourhood, searching on purpose for the flat minima that SGD&apos;s implicit regulariser drifts towards.
      </>,
      <>
        <b>Model soups</b> (Wortsman et al., 2022): average the weights of several fine-tuned models, getting much of an
        ensemble&apos;s gain for the cost of running one model.
      </>,
      <>
        <b>LoRA</b> (Hu et al., 2022): transfer learning with the base frozen and small low-rank updates trained on top,
        so fine-tuning touches a tiny fraction of the parameters.
      </>,
      <>
        <b>Data-constrained scaling</b> (Muennighoff et al., 2023): when fresh text runs out, repeating data for a few
        epochs is almost as good as new data, but the value of further repeats falls away. Overfitting returns at LLM
        scale.
      </>,
    ],
    labs: [
      ['/training', 'Training Lab'],
      ['/building', 'How LLMs Are Built'],
      ['/preference-tuning', 'Preference Tuning'],
      ['/training-at-scale', 'Training at Scale'],
    ],
  },
  {
    n: 10,
    title: 'Convolutional networks',
    offers: (
      <p>
        Why images need something other than fully connected layers, and how convolution provides it: small kernels,
        shared across positions, stacked so each unit sees more of the input. The chapter builds 1D and 2D convolutional
        networks, shows how to shrink and grow feature maps, and walks through AlexNet, VGG, YOLO and an early
        segmentation network.
      </p>
    ),
    examples: [
      {
        id: '10.1',
        title: 'Invariance and equivariance',
        page: 161,
        shows: (
          <p>
            A function is invariant to a transformation if transforming the input leaves the output unchanged, f(t(x)) =
            f(x), and equivariant if the output transforms the same way, f(t(x)) = t(f(x)). Classifying a shifted photo
            should give the same label (invariance); segmenting it should give a shifted mask (equivariance). A fully
            connected network has neither built in: it has no idea which pixels are neighbours, and would train just as
            well on images whose pixels were all shuffled the same way. Convolution is equivariant to shifts, and
            pooling adds partial invariance.
          </p>
        ),
        notebooks: ['10.1'],
      },
      {
        id: '10.2a',
        title: '1D convolution: padding, stride, kernel size and dilation',
        page: 163,
        shows: (
          <p>
            Each output is a weighted sum of nearby inputs, zᵢ = ω₁xᵢ₋₁ + ω₂xᵢ + ω₃xᵢ₊₁, with the same three weights at
            every position (strictly a cross-correlation, but machine learning calls it convolution). At the edges,
            either pad with zeros or keep only the &apos;valid&apos; outputs, which shrinks the result. A stride of two
            halves the number of outputs; a larger kernel covers more inputs with more weights; a dilated kernel spaces
            its weights out, so three weights can span five inputs.
          </p>
        ),
        notebooks: ['10.1'],
      },
      {
        id: '10.2b',
        title: 'Convolutional layers and channels',
        page: 165,
        shows: (
          <p>
            A convolutional layer adds a bias and an activation to the convolution. It is a fully connected layer with
            most weights fixed at zero and the rest tied together: with D inputs and D outputs, the fully connected
            version has D² weights, the kernel-3 convolution three and a bias. One convolution loses information, so
            several run in parallel, each producing a channel. With Cᵢ input channels, Cₒ output channels and kernel
            size K, a layer has Cᵢ·Cₒ·K weights and Cₒ biases.
          </p>
        ),
      },
      {
        id: '10.2c',
        title: 'Receptive fields',
        page: 167,
        shows: (
          <p>
            The receptive field of a unit is the part of the input that can affect it. With kernel size three, units in
            the first layer see three inputs and units in the second see five. A stride of two in the third layer takes
            it to seven, and by the fourth layer a unit near the middle sees all eleven inputs of the example. Stacking
            small kernels gathers information from across the input a step at a time.
          </p>
        ),
        notebooks: ['10.3'],
      },
      {
        id: '10.2d',
        title: 'A convolutional network for MNIST-1D',
        page: 167,
        shows: (
          <>
            <p>
              Three convolutional layers, each with 15 channels, kernel size 3, stride 2 and valid padding, take the 40
              inputs to 19, 9 and then 4 positions. The 60 resulting values feed a fully connected layer with ten
              outputs. It has 2,050 parameters. A fully connected network with the same layer sizes (285, 135 and 60
              units) has 59,065.
            </p>
            <p>
              Both fit the 4,000 training examples perfectly. The convolutional network gets about 17% test error, the
              fully connected one about 40%. The larger network could represent the smaller one exactly but does not
              find it. Treating every position the same suits data made by shifting templates around, so the
              convolutional structure acts as a regulariser that rules out most of the fully connected solutions.
            </p>
          </>
        ),
        notebooks: ['10.2'],
      },
      {
        id: '10.3',
        title: '2D convolution',
        page: 170,
        shows: (
          <p>
            In 2D the kernel is a small grid, typically 3×3, slid both across and down the image. For an RGB input each
            output channel uses 3×3×3 weights, one 3×3 kernel per colour, plus a bias. In general a layer with Cᵢ input
            and Cₒ output channels and a K×K kernel has Cᵢ·Cₒ·K·K weights and Cₒ biases, however large the image.
          </p>
        ),
        notebooks: ['10.3'],
      },
      {
        id: '10.4',
        title: 'Downsampling, upsampling and 1×1 convolution',
        page: 171,
        shows: (
          <>
            <p>
              To halve a feature map: keep every other value (what a stride of two does), take the largest of each 2×2
              block (max pooling, which adds some invariance to small shifts), or take their mean. To double it: copy
              each value four times, put each maximum back where it came from (max unpooling), interpolate bilinearly,
              or use a transposed convolution, whose weight matrix is the transpose of a strided convolution&apos;s.
            </p>
            <p>
              A 1×1 convolution changes the number of channels without touching the spatial size. It is the same small
              fully connected layer applied at every position.
            </p>
          </>
        ),
        notebooks: ['10.4'],
      },
      {
        id: '10.5a',
        title: 'Image classification: AlexNet and VGG',
        page: 174,
        shows: (
          <>
            <p>
              ImageNet has about 1.28 million training images in 1,000 classes, resized to 224×224. AlexNet (2012) has
              five convolutional and three fully connected layers, starting with 11×11 kernels at stride 4. Most of its
              roughly 60 million parameters are in the fully connected layers. It was trained with heavy augmentation,
              dropout and weight decay, and averaged its predictions over crops and mirror images at test time. It
              reached 16.4% top-5 and 38.1% top-1 error, far ahead of earlier methods.
            </p>
            <p>
              VGG kept the same pattern of convolutions and pooling, with resolution falling and channels rising, but
              went to 19 layers and 144 million parameters. It reached 6.8% top-5 and 23.7% top-1 error. Depth was the
              main change, evidence that depth matters.
            </p>
          </>
        ),
        notebooks: ['10.5'],
      },
      {
        id: '10.5b',
        title: 'Object detection: YOLO',
        page: 177,
        shows: (
          <p>
            YOLO takes a 448×448 image through 24 convolutional layers to a 7×7 map with 1,024 channels, then through
            fully connected layers to its output. For each cell of a 7×7 grid it predicts a class and a fixed number of
            boxes, each with a centre, a width, a height and a confidence. It is first trained on ImageNet
            classification and then fine-tuned for detection. Afterwards, low-confidence boxes are dropped and
            overlapping boxes for the same object are reduced to the most confident one.
          </p>
        ),
      },
      {
        id: '10.5c',
        title: 'Semantic segmentation',
        page: 178,
        shows: (
          <p>
            The network of Noh et al. (2015) labels every pixel with one of 21 classes. A cut-down VGG encoder shrinks
            the 224×224 image to 14×14, fully connected layers summarise the whole image, and another reshapes it to
            7×7×512. A mirror-image decoder of max unpooling and transposed convolutions grows it back to full size, and
            a 1×1 convolution with a per-pixel softmax gives the class probabilities. This encoder–decoder, or
            hourglass, shape returns in U-Nets in chapter 11.
          </p>
        ),
      },
    ],
    inLlms: (
      <>
        <p>
          LLMs are not convolutional, but the chapter&apos;s ideas run through them. The MLP in each transformer block
          applies the same weights at every token position, which is a 1×1 convolution over the sequence. Sharing
          weights across positions is why a model handles a phrase the same way wherever it appears in the context. With
          relative position encodings such as RoPE, attention scores depend on how far apart two tokens are, not on
          where they sit: a form of shift equivariance.
        </p>
        <p>
          Convolutions also appear directly at the edges. Vision transformers, including the image encoders of
          multimodal LLMs, cut an image into patches with what is in effect a convolution whose stride equals its kernel
          size. Whisper&apos;s audio encoder begins with two 1D convolutions over the spectrogram. State-space models
          such as Mamba place a short causal 1D convolution before their sequence mixing. And sliding-window attention
          stacks a fixed local window over many layers, so the receptive field grows with depth just as in 10.2c.
        </p>
      </>
    ),
    next: [
      <>
        <b>Vision Transformer</b> (Dosovitskiy et al., 2021): attention over 16×16 patches instead of convolution.
        Pre-trained on enough data it matches strong CNNs, which suggests the convolutional inductive bias matters most
        when data are scarce.
      </>,
      <>
        <b>ConvNeXt</b> (Liu et al., 2022): modernised a ResNet step by step with transformer-era design and training
        choices and made it competitive again, so part of the gap had been the recipe rather than convolution itself.
      </>,
      <>
        <b>Hyena</b> (Poli et al., 2023): replaces attention with long implicit convolutions and gating, aiming for cost
        that grows more slowly than quadratically with sequence length.
      </>,
      <>
        <b>Mamba</b> (Gu &amp; Dao, 2023): a selective state-space model, with a short convolution in each block, whose
        cost grows linearly with sequence length. Hybrid models interleave such layers with attention.
      </>,
      <>
        <b>Primer</b> (So et al., 2021): an architecture search for language models that found small depthwise
        convolutions after the query, key and value projections made training more efficient.
      </>,
    ],
    labs: [
      ['/vision', 'Images as Tokens'],
      ['/transformer-tricks', 'Transformer Tricks'],
      ['/deep-learning', 'Deep Learning Notebooks'],
    ],
  },
  {
    n: 11,
    title: 'Residual networks',
    offers: (
      <p>
        Why stacking more and more layers stopped helping, and the two changes that made very deep networks trainable:
        residual connections and normalisation. The chapter explains shattered gradients, reads a residual network as an
        ensemble of shorter paths, works out why its variance grows with depth, and uses batch normalisation to control
        it. It ends with ResNet, DenseNet and U-Net.
      </p>
    ),
    examples: [
      {
        id: '11.1',
        title: 'The limits of sequential networks: shattered gradients',
        page: 187,
        shows: (
          <>
            <p>
              A 56-layer convolutional network does worse than a 20-layer one on CIFAR-10, on the training set as well
              as the test set. So the deeper network is failing to train, not failing to generalise.
            </p>
            <p>
              One explanation: plot the gradient of a network&apos;s output with respect to its input across a range of
              inputs. For a shallow network with 200 hidden units it changes slowly. For one with 24 layers it looks
              like noise, and its autocorrelation falls to zero almost at once. Any finite optimisation step then lands
              where the gradient has nothing to do with the one just used.
            </p>
          </>
        ),
        notebooks: ['11.1'],
      },
      {
        id: '11.2a',
        title: 'Residual connections and the unravelled network',
        page: 189,
        shows: (
          <p>
            Each block adds its result to its input: h₁ = x + f₁(x), h₂ = h₁ + f₂(h₁), and so on. Expanding four blocks
            shows the output as the input plus four smaller networks, or equivalently as 16 paths of different lengths
            from input to output. The first block lies on eight of them. The derivative of the output with respect to it
            starts with the identity, a direct route, and adds chains of every length. The short chains behave well, so
            residual networks suffer much less from shattered gradients.
          </p>
        ),
        notebooks: ['11.2'],
      },
      {
        id: '11.2b',
        title: 'Order of operations inside a residual block',
        page: 191,
        shows: (
          <p>
            If a block ends with a ReLU it can only add non-negative values, so the representation could only grow. The
            fix is to apply the activation first and end the block with a linear layer, so it can add or subtract.
            Because a block that starts with a ReLU does nothing to an all-negative input, the network itself starts
            with a plain linear layer. Residual connections on their own roughly double the depth that can be trained
            before performance drops.
          </p>
        ),
      },
      {
        id: '11.3',
        title: 'Exploding variance in residual networks',
        page: 192,
        shows: (
          <p>
            He initialisation keeps the variance unchanged through each block&apos;s branch. But the branch output is
            then added to the block&apos;s input, and the two vary independently, so the variance doubles at every block
            and grows as 2ᴷ over K blocks. The same happens to the gradients on the way back. Multiplying each
            block&apos;s output by 1/√2 would cancel the doubling; batch normalisation is the more common fix.
          </p>
        ),
        notebooks: ['11.2'],
      },
      {
        id: '11.4',
        title: 'Batch normalisation',
        page: 192,
        shows: (
          <>
            <p>
              For each hidden unit, subtract its mean over the batch, divide by its standard deviation, then apply a
              learned scale γ and offset δ. In a convolutional network the statistics are taken over the batch and the
              spatial positions. At test time there is no batch, so statistics from the whole training set are frozen
              into the network.
            </p>
            <p>
              Placed at the start of each residual branch with γ = 1 and δ = 0, it makes each branch add one unit of
              variance, so the total grows linearly rather than exponentially. Later blocks start close to the identity,
              and the network can deepen itself as γ grows. It also smooths the loss surface, allowing larger learning
              rates, and the noise of batch statistics regularises. The cost is redundancy: the output no longer depends
              on the scale of the incoming weights. The notes cover LayerNorm and GroupNorm for when batch statistics
              are unreliable, as in language models.
            </p>
          </>
        ),
        notebooks: ['11.3'],
      },
      {
        id: '11.5a',
        title: 'ResNet',
        page: 195,
        shows: (
          <p>
            A ResNet block runs batch norm, ReLU and a 3×3 convolution twice, then adds the result to its input. The
            bottleneck block saves parameters with a 1×1 convolution to cut the channels, a 3×3 convolution, and a 1×1
            convolution to restore them. ResNet-200 starts with a 7×7 convolution and pooling, then stacks bottleneck
            blocks, halving resolution with stride-2 convolutions as the channels grow, and ends with average pooling
            and a fully connected layer. It reached 4.8% top-5 and 20.1% top-1 error on ImageNet, against 16.4% and
            38.1% for AlexNet and 6.8% and 23.7% for VGG. Human top-5 error is quoted at 5.1%.
          </p>
        ),
      },
      {
        id: '11.5b',
        title: 'DenseNet',
        page: 195,
        shows: (
          <p>
            Instead of adding a block&apos;s output to its input, DenseNet concatenates it, so each layer sees the
            outputs of all the layers before it. The channel count grows quickly, so 1×1 convolutions shrink it, and the
            chain restarts whenever the resolution is halved. DenseNet competes with ResNet and can do better for the
            same number of parameters, perhaps because it reuses earlier features more flexibly.
          </p>
        ),
      },
      {
        id: '11.5c',
        title: 'U-Nets and hourglass networks',
        page: 197,
        shows: (
          <p>
            An encoder–decoder has to squeeze fine detail through its smallest layer. A U-Net avoids this by
            concatenating each encoder stage onto the decoder stage of the same size, so detail skips the bottleneck.
            The original used valid convolutions and cropped the encoder features to fit. Being fully convolutional, it
            runs on images of any size. The book shows it segmenting cells in microscope images, including in 3D with an
            ensemble of five U-Nets. Stacked hourglass networks process the skip connections and add rather than
            concatenate; they estimate body pose as one heatmap per joint. U-Nets return in diffusion models.
          </p>
        ),
      },
      {
        id: '11.6',
        title: 'Why residual networks work so well',
        page: 199,
        shows: (
          <p>
            Depth is not the whole story. Wider, shallower residual networks sometimes beat deeper, narrower ones with
            the same number of parameters, and gradients do not travel well along the longest paths: in one 54-block
            network almost all the gradient came from paths 5 to 17 blocks long. Visualising the loss around a minimum
            shows it is much smoother with skip connections than without. Residual connections seem to help in their own
            right, not only by allowing more layers.
          </p>
        ),
      },
    ],
    inLlms: (
      <>
        <p>
          A transformer is a residual network. Each token carries a vector, the residual stream, and every block adds to
          it: x ← x + Attention(Norm(x)), then x ← x + MLP(Norm(x)). Interpretability research treats this stream as a
          shared channel that each layer reads from and writes to. The unravelled view of 11.2a explains why removing
          some middle layers from a trained LLM often costs less than you would expect.
        </p>
        <p>
          Layer normalisation replaced batch normalisation. Sequences vary in length, batches are split across devices,
          and each token must be processed without looking at other examples. Many recent models use RMSNorm, which
          drops the mean subtraction and the offset. The original Transformer normalised after each addition
          (post-norm). GPT-2 moved the normalisation to the start of each branch (pre-norm), the same move as the
          reordered block in 11.2b: the identity path stays clean, so gradients reach early layers directly and deep
          stacks are easier to train. The price is the variance growth of 11.3. The stream grows with depth, which is
          one reason pre-norm models add a final normalisation before the output layer and shrink residual branches at
          initialisation.
        </p>
      </>
    ),
    next: [
      <>
        <b>Pre-norm analysis</b> (Xiong et al., 2020): shows that post-norm transformers have large gradients near the
        output at initialisation, which is why they need learning-rate warm-up, and that pre-norm can train without it.
      </>,
      <>
        <b>DeepNorm</b> (Wang et al., 2022): scales up the residual path and scales down the branch weights at
        initialisation in a post-norm transformer, and trained one with 1,000 layers.
      </>,
      <>
        <b>RMSNorm</b> (Zhang &amp; Sennrich, 2019) and <b>Dynamic Tanh</b> (Zhu et al., 2025): a cheaper normalisation
        now common in LLMs, and an element-wise tanh with a learned scale that can replace normalisation layers
        altogether.
      </>,
      <>
        <b>Hyper-connections</b> (Zhu et al., 2024): replace the single residual stream with several, mixed by learned
        weights, so the network learns how strong its skip connections should be.
      </>,
      <>
        <b>LayerDrop</b> (Fan et al., 2020): drops whole transformer layers at random during training, stochastic depth
        for transformers, so layers can be removed at inference with little loss.
      </>,
    ],
    labs: [
      ['/transformer', 'Transformer Explainer'],
      ['/transformer-tricks', 'Transformer Tricks'],
      ['/building', 'How LLMs Are Built'],
      ['/deep-learning', 'Deep Learning Notebooks'],
    ],
  },
];
