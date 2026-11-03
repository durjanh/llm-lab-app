/* Chapters 7 and 11: backpropagation, initialisation, shattered gradients, residual networks and batch norm. */
import { useMemo, useState } from 'react';
import type { ChapterDef } from './chapters';
import { fmt, gauss, linspace, rng } from './kit';
import { Notebook, Readout, Slider } from './Notebook';
import { Plot, type Frame } from './Plot';

// ---------- shared helpers ----------

const relu = (v: number) => (v > 0 ? v : 0);

/** n samples from N(0, std²), seeded. */
function randn(r: () => number, n: number, std = 1): Float64Array {
  const a = new Float64Array(n);
  for (let i = 0; i < n; i++) a[i] = gauss(r) * std;
  return a;
}

/** W x, with W stored row by row (rows × cols), times a scale. */
function mv(W: Float64Array, x: Float64Array, rows: number, cols: number, scale = 1): Float64Array {
  const out = new Float64Array(rows);
  for (let i = 0; i < rows; i++) {
    let s = 0;
    const o = i * cols;
    for (let j = 0; j < cols; j++) s += W[o + j] * x[j];
    out[i] = s * scale;
  }
  return out;
}

/** Wᵀ g, the step backpropagation takes through a weight matrix. */
function mtv(W: Float64Array, g: Float64Array, rows: number, cols: number, scale = 1): Float64Array {
  const out = new Float64Array(cols);
  for (let i = 0; i < rows; i++) {
    const gi = g[i] * scale;
    if (gi === 0) continue;
    const o = i * cols;
    for (let j = 0; j < cols; j++) out[j] += W[o + j] * gi;
  }
  return out;
}

function meanSquare(a: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * a[i];
  return s / a.length;
}

/** Normalises each unit over the batch to mean 0 and variance 1, as batch norm does (without its learned scale and shift). */
function batchNorm(batch: Float64Array[], width: number): Float64Array[] {
  const out = batch.map(() => new Float64Array(width));
  for (let j = 0; j < width; j++) {
    let m = 0;
    for (const v of batch) m += v[j];
    m /= batch.length;
    let s = 0;
    for (const v of batch) s += (v[j] - m) ** 2;
    const sd = Math.sqrt(s / batch.length + 1e-5);
    batch.forEach((v, k) => (out[k][j] = (v[j] - m) / sd));
  }
  return out;
}

/** A y range for series of log values, rounded out to whole numbers and kept within sensible bounds. */
function logRange(series: number[][], lo = -30, hi = 30): [number, number] {
  const all = series.flat().filter(Number.isFinite);
  let a = Math.max(lo, Math.floor(Math.min(...all, 0) - 0.5));
  let b = Math.min(hi, Math.ceil(Math.max(...all, 0) + 0.5));
  if (b - a < 2) [a, b] = [a - 1, b + 1];
  return [a, b];
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

/** Draws a histogram's bars: counts over equal bins from x0 to x1. */
function bars(f: Frame, x0: number, x1: number, fractions: number[], colour: string) {
  const w = (x1 - x0) / fractions.length;
  f.ctx.fillStyle = colour;
  fractions.forEach((v, i) => {
    const left = f.x(x0 + i * w), right = f.x(x0 + (i + 1) * w);
    const top = f.y(v), base = f.y(0);
    f.ctx.fillRect(left + 0.5, top, Math.max(1, right - left - 1), base - top);
  });
}

function histogram(values: ArrayLike<number>, x0: number, x1: number, bins: number) {
  const counts = new Array<number>(bins).fill(0);
  let outside = 0;
  for (let i = 0; i < values.length; i++) {
    const k = Math.floor(((values[i] - x0) / (x1 - x0)) * bins);
    if (k < 0 || k >= bins) outside++;
    else counts[k]++;
  }
  return { fractions: counts.map((c) => c / values.length), outside: outside / values.length };
}

// ---------- 7.1 Backpropagation in a toy model ----------

const TOY_START = { beta0: 1, omega0: 0.1, beta1: 2, omega1: -0.4, beta2: -3, omega2: 2, beta3: 0.4, omega3: 3 };
type ToyParams = typeof TOY_START;
type ToyKey = keyof ToyParams;
const TOY_KEYS = Object.keys(TOY_START) as ToyKey[];
const TOY_LABEL: Record<ToyKey, string> = {
  beta0: 'β₀', omega0: 'ω₀', beta1: 'β₁', omega1: 'ω₁', beta2: 'β₂', omega2: 'ω₂', beta3: 'β₃', omega3: 'ω₃',
};

function toyForward(p: ToyParams, x: number) {
  const f0 = p.beta0 + p.omega0 * x;
  const h1 = Math.sin(f0);
  const f1 = p.beta1 + p.omega1 * h1;
  const h2 = Math.exp(f1);
  const f2 = p.beta2 + p.omega2 * h2;
  const h3 = Math.cos(f2);
  const f3 = p.beta3 + p.omega3 * h3;
  return { f0, h1, f1, h2, f2, h3, f3 };
}

const toyLoss = (p: ToyParams, x: number, y: number) => (toyForward(p, x).f3 - y) ** 2;

/** The backward pass: each derivative from the one after it, by the chain rule. */
function toyBackward(p: ToyParams, x: number, y: number) {
  const v = toyForward(p, x);
  const f3 = 2 * (v.f3 - y);
  const h3 = p.omega3 * f3;
  const f2 = -Math.sin(v.f2) * h3;
  const h2 = p.omega2 * f2;
  const f1 = Math.exp(v.f1) * h2;
  const h1 = p.omega1 * f1;
  const f0 = Math.cos(v.f0) * h1;
  const params: Record<ToyKey, number> = {
    beta3: f3, omega3: f3 * v.h3, beta2: f2, omega2: f2 * v.h2, beta1: f1, omega1: f1 * v.h1, beta0: f0, omega0: f0 * x,
  };
  return { v, nodes: { f0, h1, f1, h2, f2, h3, f3 }, params };
}

function ToyBackprop() {
  const [p, setP] = useState<ToyParams>(TOY_START);
  const [x, setX] = useState(2.3);
  const [y, setY] = useState(2.0);
  const set = (k: ToyKey) => (v: number) => setP((cur) => ({ ...cur, [k]: v }));
  const { v, nodes, params } = toyBackward(p, x, y);
  const loss = (v.f3 - y) ** 2;
  const h = 1e-5;
  const numeric = (k: ToyKey) => (toyLoss({ ...p, [k]: p[k] + h }, x, y) - toyLoss({ ...p, [k]: p[k] - h }, x, y)) / (2 * h);

  const xs = linspace(-3, 3, 241);
  const fs = xs.map((xv) => toyForward(p, xv).f3);
  const lo = Math.min(...fs, y), hi = Math.max(...fs, y);
  const pad = Math.max(0.5, (hi - lo) * 0.1);

  const rows: [string, string, number, number][] = [
    ['f₀', 'β₀ + ω₀·x', v.f0, nodes.f0],
    ['h₁', 'sin(f₀)', v.h1, nodes.h1],
    ['f₁', 'β₁ + ω₁·h₁', v.f1, nodes.f1],
    ['h₂', 'exp(f₁)', v.h2, nodes.h2],
    ['f₂', 'β₂ + ω₂·h₂', v.f2, nodes.f2],
    ['h₃', 'cos(f₂)', v.h3, nodes.h3],
    ['f₃', 'β₃ + ω₃·h₃', v.f3, nodes.f3],
  ];

  return (
    <Notebook
      id="7.1"
      title="Backpropagation in a toy model"
      intro={
        <>
          A model built from a chain of simple functions: f = β₃ + ω₃·cos(β₂ + ω₂·exp(β₁ + ω₁·sin(β₀ + ω₀·x))), with the
          squared loss ℓ = (f − y)². The forward pass works out each step from the input up. The backward pass then works out
          how the loss changes with each step, from the loss down, reusing the step above every time. That reuse is
          backpropagation.
        </>
      }
      tryThis={[
        'Compare the backpropagation and finite-difference columns: they agree to about ten decimal places.',
        'Set y equal to f₃. The loss is zero, and so is every derivative: there is nothing left to learn from this example.',
        'Move ω₁ towards 0. Every derivative below it (f₁ and lower) shrinks too, because the chain passes through ω₁.',
      ]}
      takeaway="Backpropagation gives every parameter's derivative for about the cost of one more forward pass. Finite differences need two forward passes per parameter, which is impossible for millions of parameters, but they make a good check."
    >
      <div className="dl-controls">
        <Slider label="x" value={x} min={-3} max={3} onChange={setX} />
        <Slider label="target y" value={y} min={-4} max={4} onChange={setY} />
        <Slider label="ω₀" value={p.omega0} min={-1.5} max={1.5} onChange={set('omega0')} />
        <Slider label="ω₁" value={p.omega1} min={-1} max={1} onChange={set('omega1')} />
        <Slider label="β₂" value={p.beta2} min={-5} max={5} onChange={set('beta2')} />
        <button className="btn small" onClick={() => (setP(TOY_START), setX(2.3), setY(2))}>
          Reset
        </button>
      </div>
      <div className="dl-cols">
        <div>
          <Plot
            x={[-3, 3]}
            y={[lo - pad, hi + pad]}
            height={230}
            xLabel="x"
            yLabel="f(x)"
            ariaLabel="The toy model's output across inputs, with the chosen input and its target"
            draw={(f) => {
              f.line(xs, fs, f.c.s1);
              f.hline(y, f.c.s2);
              f.line([x, x], [v.f3, y], f.c.muted, 1, [3, 3]);
              f.dots([[x, v.f3]], f.c.s1, 5);
              f.dots([[x, y]], f.c.s2, 5);
            }}
          />
          <p className="dl-caption">Blue: the model. Orange: the target y. The dotted gap is what the loss squares.</p>
          <Readout items={[['loss ℓ', fmt(loss, 4)], ['f₃ = f(x)', fmt(v.f3, 4)]]} />
        </div>
        <div className="dl-scroll">
          <table className="dl-table">
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>Step</th>
                <th style={{ textAlign: 'left' }}>Forward</th>
                <th>Value</th>
                <th>∂ℓ/∂ step</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(([name, formula, value, grad]) => (
                <tr key={name}>
                  <td style={{ textAlign: 'left' }}>{name}</td>
                  <td style={{ textAlign: 'left' }} className="mono">{formula}</td>
                  <td>{fmt(value, 4)}</td>
                  <td>{fmt(grad, 4)}</td>
                </tr>
              ))}
              <tr>
                <td style={{ textAlign: 'left' }}>ℓ</td>
                <td style={{ textAlign: 'left' }} className="mono">(f₃ − y)²</td>
                <td>{fmt(loss, 4)}</td>
                <td>1</td>
              </tr>
            </tbody>
          </table>
          <p className="dl-caption">Read the value column top down (forward), then the last column bottom up (backward).</p>
        </div>
      </div>
      <div className="dl-scroll">
        <table className="dl-table">
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>Parameter</th>
              <th>Value</th>
              <th>∂ℓ/∂ by backpropagation</th>
              <th>by finite differences</th>
              <th>Difference</th>
            </tr>
          </thead>
          <tbody>
            {TOY_KEYS.map((k) => {
              const n = numeric(k);
              return (
                <tr key={k}>
                  <td style={{ textAlign: 'left' }}>{TOY_LABEL[k]}</td>
                  <td>{fmt(p[k], 3)}</td>
                  <td>{fmt(params[k], 6)}</td>
                  <td>{fmt(n, 6)}</td>
                  <td>{fmt(Math.abs(params[k] - n), 2)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Notebook>
  );
}

// ---------- 7.2 Backpropagation in a small network ----------

type Vec = number[];
type Mat = number[][]; // [out][in]
interface Net {
  W: Mat[];
  b: Vec[];
}
const SIZES = [1, 3, 3, 1];

function initNet(seed: number): Net {
  const r = rng(seed);
  const W: Mat[] = [], b: Vec[] = [];
  for (let l = 0; l < SIZES.length - 1; l++) {
    const std = Math.sqrt(2 / SIZES[l]);
    W.push(Array.from({ length: SIZES[l + 1] }, () => Array.from({ length: SIZES[l] }, () => gauss(r) * std)));
    b.push(Array.from({ length: SIZES[l + 1] }, () => gauss(r) * 0.2));
  }
  return { W, b };
}

/** post[0] is the input; post[l + 1] = ReLU(pre[l]) for hidden layers, and the last is the output, without ReLU. */
function netForward(net: Net, x: number) {
  const pre: Vec[] = [], post: Vec[] = [[x]];
  let h = [x];
  net.W.forEach((W, l) => {
    const z = W.map((row, i) => row.reduce((s, w, j) => s + w * h[j], net.b[l][i]));
    pre.push(z);
    h = l < net.W.length - 1 ? z.map(relu) : z;
    post.push(h);
  });
  return { pre, post };
}

/** Gradients of a loss whose derivative with respect to the output is dOut. dPost[l] is ∂ℓ/∂ post[l]. */
function netBackward(net: Net, cache: ReturnType<typeof netForward>, dOut: number) {
  const L = net.W.length;
  const dW: Mat[] = new Array(L), db: Vec[] = new Array(L), dPost: Vec[] = new Array(L + 1);
  let g: Vec = [dOut];
  for (let l = L - 1; l >= 0; l--) {
    dPost[l + 1] = g;
    const dz = l < L - 1 ? g.map((v, i) => (cache.pre[l][i] > 0 ? v : 0)) : g;
    dW[l] = dz.map((d) => cache.post[l].map((h) => d * h));
    db[l] = dz;
    g = cache.post[l].map((_, j) => net.W[l].reduce((s, row, i) => s + row[j] * dz[i], 0));
  }
  dPost[0] = g;
  return { dW, db, dPost };
}

const flatten = (n: Net) => n.W.flatMap((W, l) => [...W.flat(), ...n.b[l]]);
const PARAM_NAMES = SIZES.slice(1).flatMap((rows, l) => [
  ...Array.from({ length: rows * SIZES[l] }, (_, k) => `W${l + 1}[${Math.floor(k / SIZES[l]) + 1},${(k % SIZES[l]) + 1}]`),
  ...Array.from({ length: rows }, (_, i) => `b${l + 1}[${i + 1}]`),
]);

function rebuild(values: number[]): Net {
  let k = 0;
  const W: Mat[] = [], b: Vec[] = [];
  for (let l = 0; l < SIZES.length - 1; l++) {
    W.push(Array.from({ length: SIZES[l + 1] }, () => Array.from({ length: SIZES[l] }, () => values[k++])));
    b.push(Array.from({ length: SIZES[l + 1] }, () => values[k++]));
  }
  return { W, b };
}

const DATA: [number, number][] = (() => {
  const r = rng(7);
  return Array.from({ length: 14 }, (_, i) => {
    const x = -1.6 + (3.2 * i) / 13;
    return [x, 0.8 * Math.sin(2.2 * x) + 0.08 * gauss(r)] as [number, number];
  });
})();

function datasetLoss(net: Net) {
  return DATA.reduce((s, [x, y]) => s + (netForward(net, x).post[SIZES.length - 1][0] - y) ** 2, 0) / DATA.length;
}

/** The mean squared loss over the data and its gradient, as one flat list in the order of flatten(). */
function datasetGradient(net: Net) {
  const total = flatten(net).map(() => 0);
  let loss = 0;
  for (const [x, y] of DATA) {
    const cache = netForward(net, x);
    const out = cache.post[SIZES.length - 1][0];
    loss += (out - y) ** 2 / DATA.length;
    const g = netBackward(net, cache, (2 * (out - y)) / DATA.length);
    flatten({ W: g.dW, b: g.db }).forEach((v, k) => (total[k] += v));
  }
  return { loss, grad: total };
}

function NetGraph({ net, x, y }: { net: Net; x: number; y: number }) {
  const cache = netForward(net, x);
  const out = cache.post[SIZES.length - 1][0];
  const { dPost } = netBackward(net, cache, 2 * (out - y));
  const cols = [70, 240, 410, 560];
  const at = (l: number, i: number) => [cols[l], 120 + (i - (SIZES[l] - 1) / 2) * 76] as const;
  const names = ['x', 'h₁', 'h₂', 'f'];
  return (
    <svg viewBox="0 0 630 250" style={{ width: '100%', maxWidth: 660, display: 'block' }} role="img" aria-label="The network's nodes with their values and gradients">
      {net.W.map((W, l) =>
        W.map((row, i) =>
          row.map((w, j) => {
            const [x1, y1] = at(l, j), [x2, y2] = at(l + 1, i);
            return (
              <line
                key={`${l}-${i}-${j}`}
                x1={x1}
                y1={y1}
                x2={x2}
                y2={y2}
                style={{ stroke: w >= 0 ? 'var(--s1)' : 'var(--s2)', strokeWidth: 0.6 + 2.2 * Math.min(Math.abs(w), 2), opacity: 0.55 }}
              />
            );
          }),
        ),
      )}
      {SIZES.map((n, l) =>
        Array.from({ length: n }, (_, i) => {
          const [cx, cy] = at(l, i);
          const off = l > 0 && l < SIZES.length - 1 && cache.pre[l - 1][i] <= 0;
          return (
            <g key={`${l}-${i}`}>
              <circle cx={cx} cy={cy} r={31} style={{ fill: 'var(--surface)', stroke: off ? 'var(--muted)' : 'var(--ink2)', strokeDasharray: off ? '4 3' : undefined, strokeWidth: 1.5 }} />
              <text x={cx} y={cy - 4} textAnchor="middle" style={{ fill: 'var(--ink)', fontSize: 12, fontWeight: 600 }}>
                {fmt(cache.post[l][i], 3)}
              </text>
              <text x={cx} y={cy + 12} textAnchor="middle" style={{ fill: 'var(--s2)', fontSize: 11 }}>
                ∂ {fmt(dPost[l][i], 3)}
              </text>
            </g>
          );
        }),
      )}
      {names.map((n, l) => (
        <text key={n} x={cols[l]} y={244} textAnchor="middle" style={{ fill: 'var(--muted)', fontSize: 12 }}>
          {n}
        </text>
      ))}
    </svg>
  );
}

function SmallNetBackprop() {
  const [seed, setSeed] = useState(3);
  const [net, setNet] = useState(() => initNet(3));
  const [steps, setSteps] = useState(0);
  const [lr, setLr] = useState(0.1);
  const [example, setExample] = useState(4);
  const { loss, grad } = useMemo(() => datasetGradient(net), [net]);
  const check = useMemo(() => {
    const base = flatten(net);
    const h = 1e-6;
    return base.map((_, k) => {
      const up = [...base], down = [...base];
      up[k] += h;
      down[k] -= h;
      return (datasetLoss(rebuild(up)) - datasetLoss(rebuild(down))) / (2 * h);
    });
  }, [net]);
  const worst = Math.max(...check.map((n, k) => Math.abs(n - grad[k])));

  const train = (n: number) => {
    let cur = net;
    for (let i = 0; i < n; i++) {
      const g = datasetGradient(cur).grad;
      cur = rebuild(flatten(cur).map((v, k) => v - lr * g[k]));
    }
    setNet(cur);
    setSteps((s) => s + n);
  };
  const restart = () => {
    const next = seed + 1;
    setSeed(next);
    setNet(initNet(next));
    setSteps(0);
  };

  const [ex, ey] = DATA[example];
  const xs = linspace(-2, 2, 161);
  return (
    <Notebook
      id="7.2"
      title="Backpropagation"
      intro={
        <>
          The same idea in a real network: one input, two hidden layers of three ReLU units, one output. The forward pass
          fills in each node&apos;s value; the backward pass sends the loss&apos;s derivative back along the same edges, multiplied
          by each weight, and stopped by any ReLU that was off. Those node derivatives then give every weight&apos;s gradient, and
          gradient descent uses them to fit the data.
        </>
      }
      tryThis={[
        'Pick different examples: the orange gradients change with the example, because each example pulls the weights its own way.',
        'Press Train 100 steps a few times and watch the loss and the fit. Training uses the gradient averaged over all 14 examples.',
        'Find a dashed node: its ReLU is off for this input, so the gradient through it is exactly zero. If it is off for every input, that unit is dead and never learns; press New start to try other starting weights.',
      ]}
      takeaway="Backpropagation is the chain rule applied node by node, from the output back. The gradient check shows it is exact, not an approximation."
    >
      <div className="dl-controls">
        <Slider label="Example" value={example} min={0} max={DATA.length - 1} step={1} onChange={setExample} show={(v) => `${v + 1} of ${DATA.length}`} />
        <Slider label="Learning rate" value={lr} min={0.01} max={0.5} onChange={setLr} />
        <button className="btn small" onClick={() => train(1)}>
          Train step
        </button>
        <button className="btn small primary" onClick={() => train(100)}>
          Train 100 steps
        </button>
        <button className="btn small" onClick={restart}>
          New start
        </button>
      </div>
      <NetGraph net={net} x={ex} y={ey} />
      <p className="dl-caption">
        For example {example + 1} (x = {fmt(ex, 3)}, y = {fmt(ey, 3)}). Each node shows its value on the forward pass and, in orange, ∂ℓ/∂node on
        the backward pass, for this example&apos;s loss (f − y)². Edges: blue positive, orange negative weights, thicker for larger ones. Dashed
        nodes are ReLUs that are off. Biases are not drawn.
      </p>
      <div className="dl-cols">
        <div>
          <Plot
            x={[-2, 2]}
            y={[-1.6, 1.6]}
            height={220}
            xLabel="x"
            yLabel="y"
            ariaLabel="The training data and the network's fit"
            draw={(f) => {
              f.line(xs, xs.map((xv) => netForward(net, xv).post[SIZES.length - 1][0]), f.c.s1);
              f.dots(DATA, f.c.ink2, 3.5);
              f.dots([[ex, ey]], f.c.s2, 6);
            }}
          />
          <Readout items={[['steps', steps], ['mean squared loss', fmt(loss, 4)]]} />
        </div>
        <div>
          <b className="small">Gradient check over all {PARAM_NAMES.length} parameters</b>
          <div className="dl-scroll" style={{ maxHeight: 220, overflowY: 'auto', marginTop: 6 }}>
            <table className="dl-table">
              <thead>
                <tr>
                  <th style={{ textAlign: 'left' }}>Parameter</th>
                  <th>Backpropagation</th>
                  <th>Finite differences</th>
                </tr>
              </thead>
              <tbody>
                {PARAM_NAMES.map((name, k) => (
                  <tr key={name}>
                    <td style={{ textAlign: 'left' }}>{name}</td>
                    <td>{fmt(grad[k], 5)}</td>
                    <td>{fmt(check[k], 5)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="dl-caption">Largest difference: {fmt(worst, 2)}.</p>
        </div>
      </div>
    </Notebook>
  );
}

// ---------- 7.3 Initialisation ----------

const INIT_BATCH = 32;

function initBase(depth: number, width: number) {
  const r = rng(11);
  return {
    Z: Array.from({ length: depth }, () => randn(r, width * width)),
    inputs: Array.from({ length: INIT_BATCH }, () => randn(r, width)),
    topGrads: Array.from({ length: INIT_BATCH }, () => randn(r, width)),
  };
}

/** Mean square of each layer's pre-activations going forward, and of their gradients going back. */
function initStats(base: ReturnType<typeof initBase>, depth: number, width: number, sigma: number) {
  const fwd = new Array<number>(depth).fill(0), bwd = new Array<number>(depth).fill(0);
  for (let s = 0; s < INIT_BATCH; s++) {
    const pres: Float64Array[] = [];
    let h = base.inputs[s];
    for (let l = 0; l < depth; l++) {
      const z = mv(base.Z[l], h, width, width, sigma);
      pres.push(z);
      fwd[l] += meanSquare(z) / INIT_BATCH;
      h = z.map(relu);
    }
    let dz = base.topGrads[s];
    bwd[depth - 1] += meanSquare(dz) / INIT_BATCH;
    for (let l = depth - 1; l >= 1; l--) {
      const dh = mtv(base.Z[l], dz, width, width, sigma);
      dz = dh.map((g, j) => (pres[l - 1][j] > 0 ? g : 0));
      bwd[l - 1] += meanSquare(dz) / INIT_BATCH;
    }
  }
  return { fwd, bwd };
}

function Initialization() {
  const [depth, setDepth] = useState(30);
  const [width, setWidth] = useState(50);
  const [sigma, setSigma] = useState(0.1);
  const he = Math.sqrt(2 / width);
  const base = useMemo(() => initBase(depth, width), [depth, width]);
  const { fwd, bwd } = useMemo(() => initStats(base, depth, width, sigma), [base, depth, width, sigma]);
  const lf = fwd.map((v) => Math.log10(Math.max(v, 1e-300)));
  const lb = bwd.map((v) => Math.log10(Math.max(v, 1e-300)));
  const layers = fwd.map((_, i) => i + 1);
  const [y0, y1] = logRange([lf, lb]);
  const verdict = Math.abs(sigma - he) / he < 0.04 ? 'stable' : sigma < he ? 'vanishing' : 'exploding';
  return (
    <Notebook
      id="7.3"
      title="Initialization"
      intro={
        <>
          Before training, the weights are random. Their spread decides whether signals survive a deep network. Each ReLU
          layer multiplies the size of its input by about width × σ² / 2 on the way forward, and the gradients by the same
          on the way back. Over many layers, a factor slightly below 1 makes them vanish and slightly above makes them
          explode. He initialisation picks σ = √(2 / width), which makes the factor exactly 1.
        </>
      }
      tryThis={[
        'Press He and see both lines go flat: the signal and the gradient keep their size through every layer.',
        'Move σ 20% either side of He. The lines tilt, and at 30 layers they are already hundreds or thousands of times off.',
        'Change the width: the He value changes with it, because each unit adds up width inputs.',
      ]}
      takeaway="With the wrong scale, a deep network cannot train at all: the gradients reaching the early layers are effectively zero or overflow. He (for ReLU) or Glorot (for tanh) initialisation fixes the scale at the start; normalisation layers keep it fixed during training."
    >
      <div className="dl-controls">
        <Slider label="Layers" value={depth} min={2} max={50} step={1} onChange={setDepth} show={(v) => String(v)} />
        <Slider label="Width" value={width} min={10} max={100} step={10} onChange={setWidth} show={(v) => String(v)} />
        <Slider label="Weight std σ" value={sigma} min={0.01} max={0.6} step={0.001} onChange={setSigma} show={(v) => v.toFixed(3)} />
        <button className="btn small primary" onClick={() => setSigma(+he.toFixed(4))}>
          He: √(2/width) = {he.toFixed(3)}
        </button>
      </div>
      <Plot
        x={[1, depth]}
        y={[y0, y1]}
        height={250}
        xLabel="layer"
        yLabel="log₁₀ mean square"
        ariaLabel="Size of activations and gradients per layer"
        draw={(f) => {
          f.hline(0, f.c.muted);
          f.line(layers, lf, f.c.s1);
          f.line(layers, lb, f.c.s2);
        }}
      />
      <Legend items={[['s1', 'Pre-activations, forward pass'], ['s2', 'Gradients ∂ℓ/∂pre-activation, backward pass']]} />
      <Readout
        items={[
          ['σ relative to He', `${(sigma / he).toFixed(2)}×`],
          ['signal at the last layer', fmt(fwd[depth - 1], 3)],
          ['gradient at the first layer', fmt(bwd[0], 3)],
          ['behaviour', verdict],
        ]}
      />
    </Notebook>
  );
}

// ---------- 11.1 Shattered gradients ----------

const SH_WIDTH = 40, SH_POINTS = 200, SH_MAX = 50;
const SH_XS = linspace(-2, 2, SH_POINTS);

function shatterBase() {
  const r = rng(3);
  return {
    win: randn(r, SH_WIDTH),
    bin: randn(r, SH_WIDTH),
    W: Array.from({ length: SH_MAX }, () => randn(r, SH_WIDTH * SH_WIDTH, Math.sqrt(2 / SH_WIDTH))),
    b: Array.from({ length: SH_MAX }, () => randn(r, SH_WIDTH, 0.1)),
    wout: randn(r, SH_WIDTH, 1 / Math.sqrt(SH_WIDTH)),
  };
}

/** dy/dx at each input, carried forward alongside the activations (forward-mode differentiation), standardised. */
function inputGradients(base: ReturnType<typeof shatterBase>, depth: number, residual: boolean): number[] {
  const g = SH_XS.map((x) => {
    let h = new Float64Array(SH_WIDTH), dh = new Float64Array(SH_WIDTH);
    for (let j = 0; j < SH_WIDTH; j++) {
      const z = base.win[j] * x + base.bin[j];
      h[j] = relu(z);
      dh[j] = z > 0 ? base.win[j] : 0;
    }
    for (let l = 0; l < depth; l++) {
      const z = mv(base.W[l], h, SH_WIDTH, SH_WIDTH);
      const dz = mv(base.W[l], dh, SH_WIDTH, SH_WIDTH);
      const nh = new Float64Array(SH_WIDTH), ndh = new Float64Array(SH_WIDTH);
      for (let j = 0; j < SH_WIDTH; j++) {
        const zj = z[j] + base.b[l][j];
        const a = relu(zj), da = zj > 0 ? dz[j] : 0;
        nh[j] = residual ? h[j] + a : a;
        ndh[j] = residual ? dh[j] + da : da;
      }
      h = nh;
      dh = ndh;
    }
    let s = 0;
    for (let j = 0; j < SH_WIDTH; j++) s += base.wout[j] * dh[j];
    return s;
  });
  const m = g.reduce((a, b) => a + b, 0) / g.length;
  const sd = Math.sqrt(g.reduce((a, b) => a + (b - m) ** 2, 0) / g.length) || 1;
  return g.map((v) => (v - m) / sd);
}

function autocorrelation(z: number[], maxLag: number): number[] {
  return Array.from({ length: maxLag + 1 }, (_, lag) => {
    let s = 0;
    for (let i = 0; i + lag < z.length; i++) s += z[i] * z[i + lag];
    return s / (z.length - lag);
  });
}

function ShatteredGradients() {
  const [depth, setDepth] = useState(24);
  const base = useMemo(shatterBase, []);
  const plain = useMemo(() => inputGradients(base, depth, false), [base, depth]);
  const res = useMemo(() => inputGradients(base, depth, true), [base, depth]);
  const lags = Array.from({ length: 31 }, (_, i) => i);
  const acPlain = autocorrelation(plain, 30), acRes = autocorrelation(res, 30);
  const gradPlot = (g: number[], colour: 's1' | 's3', label: string) => (
    <div>
      <b className="small">{label}</b>
      <Plot
        x={[-2, 2]}
        y={[-4, 4]}
        height={170}
        xLabel="input x"
        ariaLabel={`${label}: the gradient of the output with respect to the input`}
        draw={(f) => f.line(SH_XS, g, f.c[colour], 1.5)}
      />
    </div>
  );
  return (
    <Notebook
      id="11.1"
      title="Shattered gradients"
      intro={
        <>
          Take a network with a single input x and plot how its output responds to x: the gradient dy/dx at 200 inputs in a row.
          In a shallow network neighbouring inputs have similar gradients. As a plain network gets deeper, the gradient breaks
          into noise: nearby inputs get unrelated gradients, so a gradient step learned at one input says nothing about the
          next. Residual connections keep the gradient smooth.
        </>
      }
      tryThis={[
        'Start at 2 layers: both gradients are smooth. Move to 50 and watch the plain network’s gradient turn to static.',
        'Watch the correlation plot: for the plain network it falls to zero within a few steps; for the residual network it stays high.',
      ]}
      takeaway="Shattered gradients are a reason deep plain networks train badly even when their gradients neither vanish nor explode. Residual connections are why networks of hundreds of layers, including transformers, can be trained."
    >
      <div className="dl-controls">
        <Slider label="Layers" value={depth} min={1} max={SH_MAX} step={1} onChange={setDepth} show={(v) => String(v)} />
      </div>
      <div className="dl-cols">
        {gradPlot(plain, 's1', 'Plain network: dy/dx (standardised)')}
        {gradPlot(res, 's3', 'Residual network: dy/dx (standardised)')}
      </div>
      <Plot
        x={[0, 30]}
        y={[-0.3, 1]}
        height={180}
        xLabel="distance between inputs (steps of 0.02)"
        yLabel="correlation"
        ariaLabel="Autocorrelation of the gradient for the plain and residual networks"
        draw={(f) => {
          f.hline(0, f.c.muted);
          f.line(lags, acPlain, f.c.s1);
          f.line(lags, acRes, f.c.s3);
        }}
      />
      <Legend items={[['s1', 'Plain'], ['s3', 'Residual']]} />
      <Readout
        items={[
          ['plain: correlation of neighbours', fmt(acPlain[1], 2)],
          ['residual: correlation of neighbours', fmt(acRes[1], 2)],
          ['width', SH_WIDTH],
        ]}
      />
    </Notebook>
  );
}

// ---------- 11.2 Residual networks ----------

const RES_WIDTH = 50, RES_BATCH = 32, RES_MAX = 50;

/** Variance of the activations after each block, for every block up to RES_MAX, for three kinds of network. */
function residualVariances() {
  const r = rng(5);
  const W = Array.from({ length: RES_MAX }, () => randn(r, RES_WIDTH * RES_WIDTH, Math.sqrt(2 / RES_WIDTH)));
  const inputs = Array.from({ length: RES_BATCH }, () => randn(r, RES_WIDTH));
  const run = (kind: 'plain' | 'residual' | 'scaled') => {
    const out = new Array<number>(RES_MAX + 1).fill(0);
    for (const x of inputs) {
      let h = x;
      out[0] += meanSquare(h) / RES_BATCH;
      for (let l = 0; l < RES_MAX; l++) {
        const f = mv(W[l], h.map(relu), RES_WIDTH, RES_WIDTH);
        h = kind === 'plain' ? f : h.map((v, j) => (kind === 'residual' ? v + f[j] : (v + f[j]) / Math.SQRT2));
        out[l + 1] += meanSquare(h) / RES_BATCH;
      }
    }
    return out;
  };
  return { plain: run('plain'), residual: run('residual'), scaled: run('scaled') };
}

function ResidualNetworks() {
  const [depth, setDepth] = useState(20);
  const v = useMemo(residualVariances, []);
  const blocks = Array.from({ length: depth + 1 }, (_, i) => i);
  const log2 = (a: number[]) => a.slice(0, depth + 1).map((x) => Math.log2(x));
  const lines = { plain: log2(v.plain), residual: log2(v.residual), scaled: log2(v.scaled) };
  const [y0, y1] = logRange(Object.values(lines), -10, 60);
  return (
    <Notebook
      id="11.2"
      title="Residual networks"
      intro={
        <>
          A residual block adds its result to its input: h ← h + f(h), where f is a ReLU and a weight layer. The skip connection
          lets the signal and its gradient pass straight through. But each addition adds variance: if f(h) is as large as h,
          the variance doubles every block. Here each network starts from the same input, with He-initialised weights.
        </>
      }
      tryThis={[
        'Go to 50 blocks: the plain residual network’s variance is about 2⁵⁰, a million billion times the input.',
        'Compare the residual network scaled by 1/√2 after each addition: the doubling is undone and the variance stays near 1.',
      ]}
      takeaway="Residual connections solve shattered gradients but need their scale controlled: by scaling each branch, by initialising the last layer of each branch near zero, or with normalisation, as in 11.3 and in every transformer block."
    >
      <div className="dl-controls">
        <Slider label="Blocks" value={depth} min={1} max={RES_MAX} step={1} onChange={setDepth} show={(x) => String(x)} />
      </div>
      <Plot
        x={[0, depth]}
        y={[y0, y1]}
        height={240}
        xLabel="block"
        yLabel="log₂ variance"
        ariaLabel="Variance of activations after each block"
        draw={(f) => {
          f.line(blocks, lines.plain, f.c.s1);
          f.line(blocks, lines.residual, f.c.s2);
          f.line(blocks, lines.scaled, f.c.s3, 2, [6, 4]);
        }}
      />
      <Legend items={[['s1', 'Plain: h ← f(h)'], ['s2', 'Residual: h ← h + f(h)'], ['s3', 'Residual, scaled: h ← (h + f(h)) / √2']]} />
      <Readout
        items={[
          ['plain', fmt(v.plain[depth], 3)],
          ['residual', fmt(v.residual[depth], 3)],
          ['residual, scaled', fmt(v.scaled[depth], 3)],
          ['2^blocks', fmt(2 ** depth, 3)],
        ]}
      />
    </Notebook>
  );
}

// ---------- 11.3 Batch normalisation ----------

const BN_WIDTH = 50, BN_BATCH = 128, BN_DEPTH = 20, BN_BINS = 40;

function bnBase() {
  const r = rng(9);
  return {
    W: Array.from({ length: BN_DEPTH }, () => randn(r, BN_WIDTH * BN_WIDTH)),
    inputs: Array.from({ length: BN_BATCH }, () => randn(r, BN_WIDTH)),
  };
}

/** The values going into each layer's ReLU, for a plain network without and with batch norm. */
function bnLayers(base: ReturnType<typeof bnBase>, scale: number) {
  const sigma = scale * Math.sqrt(2 / BN_WIDTH);
  const plain: Float64Array[] = [], normed: Float64Array[] = [];
  let a = base.inputs, b = base.inputs;
  for (let l = 0; l < BN_DEPTH; l++) {
    const za = a.map((h) => mv(base.W[l], h, BN_WIDTH, BN_WIDTH, sigma));
    const zb = batchNorm(b.map((h) => mv(base.W[l], h, BN_WIDTH, BN_WIDTH, sigma)), BN_WIDTH);
    plain.push(Float64Array.from(za.flatMap((v) => [...v])));
    normed.push(Float64Array.from(zb.flatMap((v) => [...v])));
    a = za.map((z) => z.map(relu));
    b = zb.map((z) => z.map(relu));
  }
  return { plain, normed };
}

/** Variance after each residual block, without and with batch norm at the start of the branch. */
function bnResidual() {
  const r = rng(13);
  const W = Array.from({ length: RES_MAX }, () => randn(r, BN_WIDTH * BN_WIDTH, Math.sqrt(2 / BN_WIDTH)));
  const inputs = Array.from({ length: 64 }, () => randn(r, BN_WIDTH));
  const run = (norm: boolean) => {
    const out: number[] = [];
    let h = inputs;
    const record = () => out.push(h.reduce((s, v) => s + meanSquare(v), 0) / h.length);
    record();
    for (let l = 0; l < RES_MAX; l++) {
      const into = norm ? batchNorm(h, BN_WIDTH) : h;
      h = h.map((v, k) => {
        const f = mv(W[l], into[k].map(relu), BN_WIDTH, BN_WIDTH);
        return v.map((x, j) => x + f[j]);
      });
      record();
    }
    return out;
  };
  return { plain: run(false), normed: run(true) };
}

function sd(a: Float64Array) {
  let m = 0;
  for (const v of a) m += v;
  m /= a.length;
  let s = 0;
  for (const v of a) s += (v - m) ** 2;
  return { mean: m, sd: Math.sqrt(s / a.length) };
}

function BatchNormalization() {
  const [scale, setScale] = useState(0.8);
  const [layer, setLayer] = useState(BN_DEPTH);
  const [blocks, setBlocks] = useState(30);
  const base = useMemo(bnBase, []);
  const layers = useMemo(() => bnLayers(base, scale), [base, scale]);
  const growth = useMemo(bnResidual, []);
  const plain = layers.plain[layer - 1], normed = layers.normed[layer - 1];
  const hp = histogram(plain, -4, 4, BN_BINS), hn = histogram(normed, -4, 4, BN_BINS);
  const sp = sd(plain), sn = sd(normed);
  const hist = (h: ReturnType<typeof histogram>, colour: 's1' | 's3', title: string, stats: { mean: number; sd: number }) => (
    <div>
      <b className="small">{title}</b>
      <Plot
        x={[-4, 4]}
        y={[0, Math.max(0.05, ...h.fractions) * 1.1]}
        height={170}
        xLabel="value going into the ReLU"
        ariaLabel={`${title}: histogram`}
        draw={(f) => bars(f, -4, 4, h.fractions, f.c[colour])}
      />
      <Readout
        items={[
          ['mean', fmt(stats.mean, 3)],
          ['standard deviation', fmt(stats.sd, 3)],
          ['outside ±4', `${Math.round(h.outside * 100)}%`],
        ]}
      />
    </div>
  );
  const ks = Array.from({ length: blocks + 1 }, (_, i) => i);
  return (
    <Notebook
      id="11.3"
      title="Batch normalization"
      intro={
        <>
          Batch norm rescales each unit over a batch of examples to mean 0 and variance 1 (then lets the network learn its own
          scale and shift). Below, the same 20-layer network and batch of {BN_BATCH} inputs, without and with batch norm before
          each ReLU. Then a residual network with batch norm at the start of each branch.
        </>
      }
      tryThis={[
        'With the weights at 0.8× He, look at layer 20 without batch norm: the values have shrunk to a spike at zero. With batch norm they are the same healthy spread at every layer.',
        'Set the scale above 1: without batch norm the values spread off the chart; with it, nothing changes.',
        'In the residual plot, the variance with batch norm in each branch grows by about 1 per block, a straight line, while without it it doubles.',
      ]}
      takeaway="Batch norm makes each layer’s input scale independent of the weights’ scale, so initialisation matters less and higher learning rates work. In a residual network it makes the variance grow linearly, not exponentially. Transformers use layer norm, the same idea across a single example’s features instead of across the batch."
    >
      <div className="dl-controls">
        <Slider label="Weight scale" value={scale} min={0.5} max={1.5} onChange={setScale} show={(v) => `${v.toFixed(2)}× He`} />
        <Slider label="Layer" value={layer} min={1} max={BN_DEPTH} step={1} onChange={setLayer} show={(v) => String(v)} />
      </div>
      <div className="dl-cols">
        {hist(hp, 's1', `Without batch norm, layer ${layer}`, sp)}
        {hist(hn, 's3', `With batch norm, layer ${layer}`, sn)}
      </div>
      <div className="dl-controls">
        <Slider label="Residual blocks" value={blocks} min={1} max={RES_MAX} step={1} onChange={setBlocks} show={(v) => String(v)} />
      </div>
      <Plot
        x={[0, blocks]}
        y={[0, blocks + 3]}
        height={220}
        xLabel="block"
        yLabel="variance"
        ariaLabel="Variance after each residual block, with and without batch norm"
        draw={(f) => {
          f.line(ks, growth.plain.slice(0, blocks + 1), f.c.s2);
          f.line(ks, growth.normed.slice(0, blocks + 1), f.c.s3);
          f.line([0, blocks], [1, blocks + 1], f.c.muted, 1, [4, 4]);
        }}
      />
      <Legend items={[['s2', 'Residual, no normalisation (leaves the chart)'], ['s3', 'Residual, batch norm in each branch'], ['muted', '1 + blocks']]} />
      <Readout
        items={[
          ['without batch norm', fmt(growth.plain[blocks], 3)],
          ['with batch norm', fmt(growth.normed[blocks], 3)],
        ]}
      />
    </Notebook>
  );
}

export const CHAPTERS: ChapterDef[] = [
  {
    n: 7,
    title: 'Gradients and initialization',
    blurb: 'How a network finds out which way to move every weight, and why the starting weights decide whether it can learn at all.',
    notebooks: [
      { id: '7.1', title: 'Backpropagation in toy model', Component: ToyBackprop },
      { id: '7.2', title: 'Backpropagation', Component: SmallNetBackprop },
      { id: '7.3', title: 'Initialization', Component: Initialization },
    ],
  },
  {
    n: 11,
    title: 'Residual networks',
    blurb: 'Why very deep plain networks are hard to train, and how skip connections and normalisation fix it.',
    notebooks: [
      { id: '11.1', title: 'Shattered gradients', Component: ShatteredGradients },
      { id: '11.2', title: 'Residual networks', Component: ResidualNetworks },
      { id: '11.3', title: 'Batch normalization', Component: BatchNormalization },
    ],
  },
];
