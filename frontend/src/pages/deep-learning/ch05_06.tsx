import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ChapterDef } from './chapters';
import { clamp, fmt, gauss, linspace, mean, rng, sigmoid, softmax, sum, useAnimation } from './kit';
import { Notebook, Readout, Slider } from './Notebook';
import { mix, Plot, type Colours, type Frame } from './Plot';

/* ---------- helpers shared by this chapter ---------- */

type Pt = [number, number];

/** A loss surface sampled on a grid once, stored as log-scaled values from 0 (lowest) to 1 (highest). */
interface Grid {
  n: number;
  xr: [number, number];
  yr: [number, number];
  t: Float32Array;
}

function makeGrid(loss: (a: number, b: number) => number, xr: [number, number], yr: [number, number], n = 64): Grid {
  const raw = new Float32Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const a = xr[0] + ((i + 0.5) / n) * (xr[1] - xr[0]);
      const b = yr[0] + ((j + 0.5) / n) * (yr[1] - yr[0]);
      raw[j * n + i] = Math.log(loss(a, b) + 1e-3);
    }
  }
  let lo = Infinity, hi = -Infinity;
  for (const v of raw) {
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  return { n, xr, yr, t: raw.map((v) => (v - lo) / (hi - lo || 1)) };
}

const LEVELS = 16;

/** Draws the grid as a heat map in bands, so the bands read as contours: low loss in blue, high loss pale. */
function drawGrid(f: Frame, g: Grid) {
  const palette = Array.from({ length: LEVELS }, (_, k) => mix(f.c.s1, f.c.surface, 0.08 + (0.9 * k) / (LEVELS - 1)));
  f.heat((a, b) => {
    const i = clamp(Math.floor(((a - g.xr[0]) / (g.xr[1] - g.xr[0])) * g.n), 0, g.n - 1);
    const j = clamp(Math.floor(((b - g.yr[0]) / (g.yr[1] - g.yr[0])) * g.n), 0, g.n - 1);
    return palette[Math.min(LEVELS - 1, Math.floor(g.t[j * g.n + i] * LEVELS))];
  }, 64);
}

/** A path of parameter values: the line, its start, and where it is now. */
function drawPath(f: Frame, path: Pt[], colour: string, inside: (p: Pt) => boolean) {
  if (!path.length) return;
  f.line(path.map((p) => p[0]), path.map((p) => p[1]), colour, 2);
  f.dots([path[0]], f.c.ink, 3);
  const last = path[path.length - 1];
  if (inside(last)) {
    f.dots([last], f.c.surface, 6);
    f.dots([last], colour, 4.5);
  }
}

function Legend({ items }: { items: [string, string][] }) {
  return (
    <div className="dl-legend">
      {items.map(([colour, label]) => (
        <span key={label}>
          <i style={{ background: colour }} />
          {label}
        </span>
      ))}
    </div>
  );
}

/** The current theme's series colours, for legends outside a canvas. */
const SERIES = { s1: 'var(--s1)', s2: 'var(--s2)', s3: 'var(--s3)', s4: 'var(--s4)', s5: 'var(--s5)', brand: 'var(--brand)' };

/**
 * Runs an optimiser: `make` builds a fresh state, `step` advances it in place, `finished` says when to
 * stop. The state starts again whenever one of `deps` changes, such as the learning rate or the start.
 */
function useRunner<S>(make: () => S, step: (s: S) => void, finished: (s: S) => boolean, deps: unknown[], perFrame = 1) {
  const state = useRef<S | null>(null);
  if (state.current === null) state.current = make();
  const makeRef = useRef(make);
  makeRef.current = make;
  const [, render] = useState(0);
  const [running, setRunning] = useState(false);
  const redraw = () => render((n) => n + 1);

  useAnimation(running, () => {
    const s = state.current as S;
    for (let i = 0; i < perFrame; i++) {
      if (finished(s)) {
        setRunning(false);
        redraw();
        return false;
      }
      step(s);
    }
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
    toggle: () => setRunning((r) => !r && !finished(state.current as S)),
    stepOnce: () => {
      if (!finished(state.current as S)) {
        step(state.current as S);
        redraw();
      }
    },
    reset,
  };
}

function RunButtons({ r, extra }: { r: { running: boolean; toggle: () => void; stepOnce: () => void; reset: () => void }; extra?: ReactNode }) {
  return (
    <div className="row">
      <button className="btn primary small" onClick={r.toggle}>
        {r.running ? 'Pause' : 'Run'}
      </button>
      <button className="btn small" onClick={r.stepOnce} disabled={r.running}>
        Step
      </button>
      <button className="btn small" onClick={r.reset}>
        Reset
      </button>
      {extra}
    </div>
  );
}

/** A loss curve per optimiser, on a log scale. */
function LossCurves({ series, steps, y, ariaLabel }: { series: { losses: number[]; colour: keyof Colours }[]; steps: number; y: [number, number]; ariaLabel: string }) {
  return (
    <Plot
      x={[0, steps]}
      y={y}
      height={170}
      xLabel="step"
      yLabel="log₁₀ loss"
      ariaLabel={ariaLabel}
      draw={(f) => {
        for (const s of series) {
          const ys = s.losses.map((l) => (Number.isFinite(l) ? clamp(Math.log10(Math.max(l, 1e-12)), y[0] - 1, y[1] + 1) : NaN));
          f.line(ys.map((_, i) => i), ys, f.c[s.colour], 2);
        }
      }}
    />
  );
}

/** Fills the area between two curves, e.g. a ±σ band, with a translucent colour. */
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

const argmin = (ys: number[]) => ys.reduce((best, v, i) => (v < ys[best] ? i : best), 0);
const normalise = (ys: number[]) => {
  const lo = Math.min(...ys), hi = Math.max(...ys);
  return ys.map((v) => (v - lo) / (hi - lo || 1));
};

/* ---------- 5.1 Least squares loss ---------- */

const LS = (() => {
  const r = rng(51);
  const xs: number[] = [], ys: number[] = [];
  for (let i = 0; i < 14; i++) {
    const x = 2 * r();
    xs.push(x);
    ys.push(0.4 + 0.9 * x + 0.25 * gauss(r));
  }
  const mx = mean(xs), my = mean(ys);
  const slope = sum(xs.map((x, i) => (x - mx) * (ys[i] - my))) / sum(xs.map((x) => (x - mx) ** 2));
  return { xs, ys, fit: [my - slope * mx, slope] as Pt };
})();

function LeastSquares() {
  const [p0, setP0] = useState(0.2);
  const [p1, setP1] = useState(1.6);
  const [sigma, setSigma] = useState(0.4);
  const n = LS.xs.length;
  const sse = (a: number, b: number) => sum(LS.xs.map((x, i) => (LS.ys[i] - a - b * x) ** 2));
  const nll = (a: number, b: number, s: number) => n * 0.5 * Math.log(2 * Math.PI * s * s) + sse(a, b) / (2 * s * s);
  const phis = linspace(-1, 3, 161);
  const sseCurve = phis.map((b) => sse(p0, b));
  const nllCurve = phis.map((b) => nll(p0, b, sigma));
  const sigmas = linspace(0.05, 1.5, 146);
  const nllSigma = sigmas.map((s) => nll(p0, p1, s));
  const bestSigma = Math.sqrt(sse(p0, p1) / n);
  const nllLo = Math.min(...nllSigma);
  return (
    <Notebook
      id="5.1"
      title="Least squares loss"
      intro={
        <>
          Treat the model's output as the mean of a normal distribution with spread σ. Then minimising the negative
          log-likelihood of the data is exactly the same as minimising the sum of squared errors: least squares falls out
          of probability.
        </>
      }
      tryThis={[
        'Move φ₁: the sum of squares and the negative log-likelihood (middle plot, both rescaled) are the same curve, with the same minimum.',
        'Move σ: the NLL value changes, but the best φ₁ does not move.',
        'On the right, the NLL is lowest when σ equals the root mean squared error of the current line.',
      ]}
      takeaway="Least squares is maximum likelihood under Gaussian noise. σ sets the scale of the loss, not where its minimum is."
    >
      <div className="dl-controls">
        <Slider label="φ₀ (intercept)" value={p0} min={-1} max={2} onChange={setP0} />
        <Slider label="φ₁ (slope)" value={p1} min={-1} max={3} onChange={setP1} />
        <Slider label="σ" value={sigma} min={0.05} max={1.5} onChange={setSigma} />
        <button className="btn small" onClick={() => (setP0(LS.fit[0]), setP1(LS.fit[1]))}>
          Least squares fit
        </button>
      </div>
      <div className="dl-cols">
        <div>
          <Plot
            x={[0, 2]}
            y={[-0.5, 3.5]}
            xLabel="x"
            yLabel="y"
            ariaLabel="Data with the model's line and a band of plus or minus sigma"
            draw={(f) => {
              const xs = linspace(0, 2, 30);
              const mu = xs.map((x) => p0 + p1 * x);
              band(f, xs, mu.map((m) => m - sigma), mu.map((m) => m + sigma), f.c.s1);
              f.line(xs, mu, f.c.s1, 2);
              LS.xs.forEach((x, i) => f.line([x, x], [LS.ys[i], p0 + p1 * x], f.c.s2, 1, [3, 3]));
              f.dots(LS.xs.map((x, i) => [x, LS.ys[i]] as Pt), f.c.ink);
            }}
          />
          <div className="dl-caption">The line is the mean; the shaded band is ±σ. Dashed lines are the residuals.</div>
        </div>
        <div>
          <Plot
            x={[-1, 3]}
            y={[0, 1.05]}
            xLabel="φ₁"
            yLabel="loss, rescaled to 0–1"
            ariaLabel="Sum of squares and negative log-likelihood against the slope"
            draw={(f) => {
              f.line(phis, normalise(sseCurve), f.c.s2, 4);
              f.line(phis, normalise(nllCurve), f.c.ink, 1.5, [5, 4]);
              f.vline(phis[argmin(sseCurve)], f.c.s2);
              f.vline(p1, f.c.muted, [2, 3]);
            }}
          />
          <Legend items={[[SERIES.s2, 'sum of squares'], ['var(--ink)', 'negative log-likelihood']]} />
        </div>
        <div>
          <Plot
            x={[0.05, 1.5]}
            y={[nllLo - 2, nllLo + 40]}
            xLabel="σ"
            yLabel="NLL"
            ariaLabel="Negative log-likelihood against sigma for the current line"
            draw={(f) => {
              f.line(sigmas, nllSigma, f.c.s3, 2);
              f.vline(bestSigma, f.c.s3);
              f.dots([[sigma, nll(p0, p1, sigma)]], f.c.ink, 4);
            }}
          />
          <div className="dl-caption">NLL for the current line as σ varies. The dashed line is the RMS residual.</div>
        </div>
      </div>
      <Readout
        items={[
          ['sum of squares', fmt(sse(p0, p1))],
          ['negative log-likelihood', fmt(nll(p0, p1, sigma))],
          ['best φ₁ (either loss)', fmt(phis[argmin(sseCurve)])],
          ['best σ for this line', fmt(bestSigma)],
        ]}
      />
    </Notebook>
  );
}

/* ---------- 5.2 Binary cross-entropy ---------- */

const BIN = (() => {
  const r = rng(52);
  const xs: number[] = [], ys: number[] = [];
  for (let i = 0; i < 24; i++) {
    const x = -3 + 6 * r();
    xs.push(x);
    ys.push(r() < sigmoid(0.5 + 1.8 * x) ? 1 : 0);
  }
  return { xs, ys };
})();

const bce = (a: number, b: number) =>
  -mean(BIN.xs.map((x, i) => {
    const p = clamp(sigmoid(a + b * x), 1e-12, 1 - 1e-12);
    return BIN.ys[i] ? Math.log(p) : Math.log(1 - p);
  }));

function fitBinary(): Pt {
  let a = 0, b = 0;
  for (let t = 0; t < 4000; t++) {
    let ga = 0, gb = 0;
    BIN.xs.forEach((x, i) => {
      const e = sigmoid(a + b * x) - BIN.ys[i];
      ga += e;
      gb += e * x;
    });
    a -= (0.5 * ga) / BIN.xs.length;
    b -= (0.5 * gb) / BIN.xs.length;
  }
  return [a, b];
}

function BinaryCrossEntropy() {
  const [p0, setP0] = useState(-1);
  const [p1, setP1] = useState(0.6);
  const phis = linspace(-3, 5, 161);
  const curve = phis.map((b) => bce(p0, b));
  const likelihoods = BIN.xs.map((x, i) => {
    const p = sigmoid(p0 + p1 * x);
    return BIN.ys[i] ? p : 1 - p;
  });
  return (
    <Notebook
      id="5.2"
      title="Binary cross-entropy loss"
      intro={
        <>
          For a yes/no label, the network outputs a number that a sigmoid squashes into a probability λ = sig(φ₀ + φ₁x)
          of “yes”. Each point's likelihood is λ if its label is 1 and 1 − λ if it is 0. The loss is the mean negative
          log of those likelihoods: binary cross-entropy.
        </>
      }
      tryThis={[
        'Make φ₁ negative: the curve slopes the wrong way and the loss climbs.',
        'Watch the dashed gaps: each is 1 minus that point’s likelihood. A point the model is confidently wrong about costs a lot, because −log of a small number is large.',
        'Press Fit: gradient descent finds the bottom of the curve on the right.',
      ]}
      takeaway="Cross-entropy is the negative log-likelihood of a Bernoulli distribution. Confident mistakes are punished hardest."
    >
      <div className="dl-controls">
        <Slider label="φ₀" value={p0} min={-3} max={3} onChange={setP0} />
        <Slider label="φ₁" value={p1} min={-3} max={5} onChange={setP1} />
        <button className="btn small" onClick={() => { const [a, b] = fitBinary(); setP0(a); setP1(b); }}>
          Fit
        </button>
      </div>
      <div className="dl-cols">
        <div>
          <Plot
            x={[-3.2, 3.2]}
            y={[-0.1, 1.1]}
            xLabel="x"
            yLabel="label / λ"
            ariaLabel="Labelled points with the model's probability curve"
            draw={(f) => {
              const xs = linspace(-3.2, 3.2, 120);
              BIN.xs.forEach((x, i) => f.line([x, x], [BIN.ys[i], sigmoid(p0 + p1 * x)], likelihoods[i] < 0.5 ? f.c.bad : f.c.muted, 1, [3, 3]));
              f.line(xs, xs.map((x) => sigmoid(p0 + p1 * x)), f.c.s1, 2.5);
              f.dots(BIN.xs.map((x, i) => [x, BIN.ys[i]] as Pt), f.c.ink);
            }}
          />
          <div className="dl-caption">Red gaps: points with likelihood under 0.5, which the model gets wrong.</div>
        </div>
        <Plot
          x={[-3, 5]}
          y={[0, 3]}
          xLabel="φ₁"
          yLabel="BCE"
          ariaLabel="Binary cross-entropy against the slope"
          draw={(f) => {
            f.line(phis, curve, f.c.s2, 2);
            f.dots([[p1, bce(p0, p1)]], f.c.ink, 4.5);
          }}
        />
      </div>
      <Readout
        items={[
          ['binary cross-entropy', fmt(bce(p0, p1))],
          ['lowest likelihood', fmt(Math.min(...likelihoods))],
          ['correct (λ on the right side of 0.5)', `${likelihoods.filter((l) => l > 0.5).length} / ${BIN.xs.length}`],
        ]}
      />
    </Notebook>
  );
}

/* ---------- 5.3 Multiclass cross-entropy ---------- */

const MC = (() => {
  const r = rng(53);
  const xs: number[] = [], ys: number[] = [];
  for (let i = 0; i < 36; i++) {
    const x = -3 + 6 * r();
    const p = softmax([0 - 2.5 * x, 1.5, 0 + 2.5 * x]);
    const u = r();
    xs.push(x);
    ys.push(u < p[0] ? 0 : u < p[0] + p[1] ? 1 : 2);
  }
  return { xs, ys };
})();

const CLASS_COLOURS = ['s1', 's2', 's3'] as const;

function mcLoss(w: number[]) {
  return -mean(MC.xs.map((x, i) => Math.log(softmax([w[0] + w[1] * x, w[2] + w[3] * x, w[4] + w[5] * x])[MC.ys[i]])));
}

function fitMulticlass(): number[] {
  const w = [0, 0, 0, 0, 0, 0];
  for (let t = 0; t < 3000; t++) {
    const g = [0, 0, 0, 0, 0, 0];
    MC.xs.forEach((x, i) => {
      const p = softmax([w[0] + w[1] * x, w[2] + w[3] * x, w[4] + w[5] * x]);
      for (let k = 0; k < 3; k++) {
        const e = p[k] - (MC.ys[i] === k ? 1 : 0);
        g[2 * k] += e;
        g[2 * k + 1] += e * x;
      }
    });
    for (let j = 0; j < 6; j++) w[j] -= (0.5 * g[j]) / MC.xs.length;
  }
  return w;
}

function MulticlassCrossEntropy() {
  const [w, setW] = useState([0, 0, 0, 0, 0, 0]);
  const set = (j: number) => (v: number) => setW((cur) => cur.map((c, i) => (i === j ? v : c)));
  const probs = (x: number) => softmax([w[0] + w[1] * x, w[2] + w[3] * x, w[4] + w[5] * x]);
  const correct = MC.xs.filter((x, i) => {
    const p = probs(x);
    return p.indexOf(Math.max(...p)) === MC.ys[i];
  }).length;
  return (
    <Notebook
      id="5.3"
      title="Multiclass cross-entropy loss"
      intro={
        <>
          With K classes the network outputs K numbers, one per class. Softmax turns them into probabilities that are
          positive and add up to 1. The loss is the mean of −log of the probability given to each point's true class.
        </>
      }
      tryThis={[
        'With every parameter at 0, each class gets 1/3 and the loss is log 3 ≈ 1.099: the “know nothing” baseline.',
        'Give class 1 (blue) a negative slope and class 3 (green) a positive slope, then raise class 2’s intercept.',
        'Add the same amount to all three intercepts: nothing changes, because softmax only cares about differences.',
        'Press Fit to let gradient descent find the parameters.',
      ]}
      takeaway="Softmax plus multiclass cross-entropy is the categorical negative log-likelihood. It is the loss behind every LLM's next-token prediction."
    >
      <div className="dl-controls">
        {[0, 1, 2].map((k) => (
          <div key={k} className="dl-controls" style={{ gap: '4px 12px' }}>
            <b className="small" style={{ color: SERIES[CLASS_COLOURS[k]] }}>Class {k + 1}</b>
            <Slider label="intercept" value={w[2 * k]} min={-4} max={4} onChange={set(2 * k)} />
            <Slider label="slope" value={w[2 * k + 1]} min={-4} max={4} onChange={set(2 * k + 1)} />
          </div>
        ))}
        <button className="btn small" onClick={() => setW(fitMulticlass())}>
          Fit
        </button>
        <button className="btn small" onClick={() => setW([0, 0, 0, 0, 0, 0])}>
          Reset
        </button>
      </div>
      <Plot
        x={[-3.2, 3.2]}
        y={[-0.15, 1.05]}
        xLabel="x"
        yLabel="P(class | x)"
        ariaLabel="Softmax probability of each class along x, with the labelled points underneath"
        draw={(f) => {
          const xs = linspace(-3.2, 3.2, 140);
          const ps = xs.map(probs);
          [0, 1, 2].forEach((k) => f.line(xs, ps.map((p) => p[k]), f.c[CLASS_COLOURS[k]], 2.5));
          MC.xs.forEach((x, i) => f.dots([[x, -0.05 - 0.035 * MC.ys[i]]], f.c[CLASS_COLOURS[MC.ys[i]]], 3.5));
        }}
      />
      <Readout
        items={[
          ['cross-entropy', fmt(mcLoss(w))],
          ['baseline (log 3)', fmt(Math.log(3))],
          ['classified correctly', `${correct} / ${MC.xs.length}`],
        ]}
      />
    </Notebook>
  );
}

/* ---------- 6.1 Line search ---------- */

// One minimum, a little lopsided: a dip on top of a gentle bowl.
const lsF = (x: number) => 1 - 0.8 * Math.exp(-((x - 1.6) ** 2) / 0.6) + 0.06 * (x - 1.2) ** 2;

interface SearchStep {
  phase: 'Bracket' | 'Golden section';
  lo: number;
  hi: number;
  points: number[];
  best: number;
  evals: number;
  note: string;
}

function lineSearch(start: number, h0: number): SearchStep[] {
  const steps: SearchStep[] = [];
  let evals = 0;
  const f = (x: number) => (evals++, lsF(x));
  let a = start, fa = f(a);
  let h = h0;
  let b = a + h, fb = f(b);
  steps.push({ phase: 'Bracket', lo: Math.min(a, b), hi: Math.max(a, b), points: [a, b], best: fb < fa ? b : a, evals, note: `Start at ${fmt(a)}, try ${fmt(b)}` });
  let lo: number, hi: number;
  if (fb > fa) {
    h = -h;
    const c = a + h, fc = f(c);
    if (fc >= fa) {
      lo = Math.min(c, b);
      hi = Math.max(c, b);
      steps.push({ phase: 'Bracket', lo, hi, points: [c, a, b], best: a, evals, note: 'Uphill both ways: the minimum is between them' });
    } else {
      b = c;
      fb = fc;
      steps.push({ phase: 'Bracket', lo: Math.min(a, b), hi: Math.max(a, b), points: [a, b], best: b, evals, note: 'Uphill, so turn round' });
    }
  }
  // Keep doubling the step while the function falls; when it rises, the minimum is bracketed.
  for (let k = 0; steps[steps.length - 1].note.indexOf('between') < 0 && k < 30; k++) {
    const c = b + 2 * (b - a), fc = f(c);
    if (fc < fb) {
      steps.push({ phase: 'Bracket', lo: Math.min(b, c), hi: Math.max(b, c), points: [b, c], best: c, evals, note: `Still falling: double the step to ${fmt(c)}` });
      a = b;
      b = c;
      fb = fc;
    } else {
      steps.push({ phase: 'Bracket', lo: Math.min(a, c), hi: Math.max(a, c), points: [a, b, c], best: b, evals, note: `Rose at ${fmt(c)}: the minimum is bracketed` });
      break;
    }
  }
  const last = steps[steps.length - 1];
  lo = last.lo;
  hi = last.hi;
  const r = (Math.sqrt(5) - 1) / 2;
  let x1 = hi - r * (hi - lo), x2 = lo + r * (hi - lo);
  let f1 = f(x1), f2 = f(x2);
  for (let k = 0; k < 24 && hi - lo > 2e-3; k++) {
    if (f1 < f2) {
      hi = x2;
      x2 = x1;
      f2 = f1;
      x1 = hi - r * (hi - lo);
      f1 = f(x1);
      steps.push({ phase: 'Golden section', lo, hi, points: [x1, x2], best: f1 < f2 ? x1 : x2, evals, note: 'Left point lower: drop the right end' });
    } else {
      lo = x1;
      x1 = x2;
      f1 = f2;
      x2 = lo + r * (hi - lo);
      f2 = f(x2);
      steps.push({ phase: 'Golden section', lo, hi, points: [x1, x2], best: f1 < f2 ? x1 : x2, evals, note: 'Right point lower: drop the left end' });
    }
  }
  return steps;
}

function LineSearch() {
  const [start, setStart] = useState(-0.5);
  const [h, setH] = useState(0.1);
  const [at, setAt] = useState(0);
  const steps = useMemo(() => lineSearch(start, h), [start, h]);
  useEffect(() => setAt(0), [steps]);
  const cur = steps[Math.min(at, steps.length - 1)];
  const xs = linspace(-1, 4.5, 200);
  return (
    <Notebook
      id="6.1"
      title="Line search"
      intro={
        <>
          Before we fit models with many parameters, find the minimum of a function of one variable. First bracket it:
          step downhill, doubling the step, until the function rises. Then shrink the bracket with golden-section search,
          which keeps two points inside and throws away the part that cannot hold the minimum, reusing one point each time.
        </>
      }
      tryThis={[
        'Press Step repeatedly and watch the shaded bracket shrink by 0.618 each golden-section step.',
        'Start on the far side (x = 3.5): the first step goes uphill, so the search turns round.',
        'Try a large first step: bracketing finishes sooner but starts the golden section with a wider interval.',
      ]}
      takeaway="Each golden-section step needs only one new function evaluation and shrinks the interval by a fixed factor. Optimisers that pick a step size along a direction use the same idea."
    >
      <div className="dl-controls">
        <Slider label="start x" value={start} min={-0.8} max={3.8} onChange={setStart} />
        <Slider label="first step" value={h} min={0.05} max={1} onChange={setH} />
        <button className="btn primary small" disabled={at >= steps.length - 1} onClick={() => setAt((i) => i + 1)}>
          Step
        </button>
        <button className="btn small" onClick={() => setAt(steps.length - 1)}>
          To the end
        </button>
        <button className="btn small" onClick={() => setAt(0)}>
          Reset
        </button>
      </div>
      <div className="dl-cols">
        <Plot
          x={[-1, 4.5]}
          y={[0, 1.8]}
          xLabel="x"
          yLabel="f(x)"
          ariaLabel="The function, the current bracket shaded and the points evaluated"
          draw={(f) => {
            const { ctx } = f;
            ctx.save();
            ctx.globalAlpha = 0.14;
            ctx.fillStyle = f.c.brand;
            ctx.fillRect(f.x(cur.lo), f.y(1.8), f.x(cur.hi) - f.x(cur.lo), f.y(0) - f.y(1.8));
            ctx.restore();
            f.line(xs, xs.map(lsF), f.c.ink, 2);
            const seen = steps.slice(0, at).flatMap((s) => s.points);
            f.dots(seen.map((x) => [x, lsF(x)] as Pt), f.c.muted, 2.5);
            f.dots(cur.points.map((x) => [x, lsF(x)] as Pt), f.c.s2, 5);
            f.dots([[cur.best, lsF(cur.best)]], f.c.good, 4);
          }}
        />
        <div className="dl-scroll" style={{ maxHeight: 260, overflowY: 'auto' }}>
          <table className="dl-table">
            <thead>
              <tr>
                <th>Step</th>
                <th style={{ textAlign: 'left' }}>What happened</th>
                <th>Interval width</th>
                <th>Best x</th>
                <th>Evaluations</th>
              </tr>
            </thead>
            <tbody>
              {steps.slice(0, at + 1).map((s, i) => (
                <tr key={i} style={i === at ? { background: 'var(--brand-soft)' } : undefined}>
                  <td>{i + 1}</td>
                  <td style={{ textAlign: 'left' }}>
                    <span className="muted">{s.phase}:</span> {s.note}
                  </td>
                  <td>{fmt(s.hi - s.lo)}</td>
                  <td>{fmt(s.best, 4)}</td>
                  <td>{s.evals}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <Readout
        items={[
          ['step', `${at + 1} of ${steps.length}`],
          ['bracket', `[${fmt(cur.lo)}, ${fmt(cur.hi)}]`],
          ['best x so far', fmt(cur.best, 4)],
          ['f(best)', fmt(lsF(cur.best), 4)],
        ]}
      />
    </Notebook>
  );
}

/* ---------- 6.2 Gradient descent ---------- */

const LIN = (() => {
  const r = rng(62);
  const xs: number[] = [], ys: number[] = [];
  for (let i = 0; i < 16; i++) {
    const x = 2 * r();
    xs.push(x);
    ys.push(0.3 + 0.8 * x + 0.2 * gauss(r));
  }
  const loss = (a: number, b: number) => mean(xs.map((x, i) => (a + b * x - ys[i]) ** 2));
  const grad = (a: number, b: number): Pt => {
    let ga = 0, gb = 0;
    xs.forEach((x, i) => {
      const e = a + b * x - ys[i];
      ga += 2 * e;
      gb += 2 * e * x;
    });
    return [ga / xs.length, gb / xs.length];
  };
  // The Hessian is constant for a linear model: 2·[[1, mean x], [mean x, mean x²]]. Its largest eigenvalue sets the
  // largest learning rate that does not diverge: 2 / λmax.
  const m1 = mean(xs), m2 = mean(xs.map((x) => x * x));
  const tr = 2 * (1 + m2), det = 4 * (m2 - m1 * m1);
  const lmax = tr / 2 + Math.sqrt((tr * tr) / 4 - det);
  return { xs, ys, loss, grad, limit: 2 / lmax };
})();

const GD_X: [number, number] = [-2, 2.5];
const GD_Y: [number, number] = [-1.5, 3];

interface Descent {
  path: Pt[];
  losses: number[];
}

function GradientDescent() {
  const [lr, setLr] = useState(0.1);
  const [start, setStart] = useState<Pt>([-1.6, 2.6]);
  const grid = useMemo(() => makeGrid(LIN.loss, GD_X, GD_Y), []);
  const r = useRunner<Descent>(
    () => ({ path: [start], losses: [LIN.loss(...start)] }),
    (s) => {
      const [a, b] = s.path[s.path.length - 1];
      const [ga, gb] = LIN.grad(a, b);
      const next: Pt = [a - lr * ga, b - lr * gb];
      s.path.push(next);
      s.losses.push(LIN.loss(...next));
    },
    (s) => s.path.length > 200 || s.losses[s.losses.length - 1] > 1e4 || Math.hypot(...LIN.grad(...s.path[s.path.length - 1])) < 1e-5,
    [lr, start],
  );
  const now = r.s.path[r.s.path.length - 1];
  const loss = r.s.losses[r.s.losses.length - 1];
  const inside = (p: Pt) => p[0] >= GD_X[0] && p[0] <= GD_X[1] && p[1] >= GD_Y[0] && p[1] <= GD_Y[1];
  return (
    <Notebook
      id="6.2"
      title="Gradient descent"
      intro={
        <>
          Fit a line y = φ₀ + φ₁x by gradient descent. The heat map is the loss for every pair of parameters, darker
          where it is lower. Each step moves the parameters a little way downhill: φ ← φ − α ∂L/∂φ, where α is the
          learning rate.
        </>
      }
      tryThis={[
        'Drag on the loss surface to choose where to start, then press Run.',
        `Raise the learning rate past ${fmt(LIN.limit)}: the steps overshoot more each time and the loss explodes.`,
        'Just under that limit, the path zig-zags across the valley: steep directions limit the step size for every direction.',
      ]}
      takeaway={`The largest stable learning rate is 2 divided by the largest curvature of the loss. For this data that is ${fmt(LIN.limit)}.`}
    >
      <div className="dl-controls">
        <Slider label="learning rate α" value={lr} min={0.01} max={0.6} onChange={setLr} />
        <RunButtons r={r} />
      </div>
      <div className="dl-cols">
        <div>
          <Plot
            x={GD_X}
            y={GD_Y}
            xLabel="φ₀"
            yLabel="φ₁"
            ariaLabel="Loss surface over the two parameters with the gradient descent path"
            onDrag={(a, b, phase) => phase === 'start' && setStart([a, b])}
            draw={(f) => {
              drawGrid(f, grid);
              drawPath(f, r.s.path, f.c.s2, inside);
            }}
          />
          <div className="dl-caption">Drag to pick a start point.</div>
        </div>
        <Plot
          x={[0, 2]}
          y={[-1, 3.5]}
          xLabel="x"
          yLabel="y"
          ariaLabel="The data and the current line"
          draw={(f) => {
            f.line([0, 2], [now[0], now[0] + 2 * now[1]], f.c.s2, 2.5);
            f.dots(LIN.xs.map((x, i) => [x, LIN.ys[i]] as Pt), f.c.ink);
          }}
        />
        <LossCurves series={[{ losses: r.s.losses, colour: 's2' }]} steps={200} y={[-2, 3]} ariaLabel="Loss against step" />
      </div>
      <Readout
        items={[
          ['step', r.s.path.length - 1],
          ['loss', loss > 1e4 ? 'diverged' : fmt(loss)],
          ['φ₀, φ₁', `${fmt(now[0])}, ${fmt(now[1])}`],
          ['largest stable α', fmt(LIN.limit)],
        ]}
      />
    </Notebook>
  );
}

/* ---------- 6.3 Stochastic gradient descent ---------- */

const GAB = (() => {
  const r = rng(63);
  const g = (p0: number, p1: number, x: number) => {
    const u = p0 + 0.06 * p1 * x;
    return Math.sin(u) * Math.exp((-u * u) / 32);
  };
  const xs: number[] = [], ys: number[] = [];
  for (let i = 0; i < 28; i++) {
    const x = -15 + 30 * r();
    xs.push(x);
    ys.push(g(0, 16.6, x) + 0.1 * gauss(r));
  }
  const all = xs.map((_, i) => i);
  const loss = (a: number, b: number, idx = all) => mean(idx.map((i) => (g(a, b, xs[i]) - ys[i]) ** 2));
  const grad = (a: number, b: number, idx = all): Pt => {
    let ga = 0, gb = 0;
    for (const i of idx) {
      const u = a + 0.06 * b * xs[i];
      const e = Math.exp((-u * u) / 32);
      const d = Math.cos(u) * e - Math.sin(u) * (u / 16) * e;
      const res = Math.sin(u) * e - ys[i];
      ga += 2 * res * d;
      gb += 2 * res * d * 0.06 * xs[i];
    }
    return [ga / idx.length, gb / idx.length];
  };
  return { g, xs, ys, loss, grad, n: xs.length };
})();

const SGD_X: [number, number] = [-10, 10];
const SGD_Y: [number, number] = [2.5, 22.5];

interface Race {
  gd: Pt[];
  sgd: Pt[];
  gdLoss: number[];
  sgdLoss: number[];
  rand: () => number;
}

function StochasticGradientDescent() {
  const [lr, setLr] = useState(2);
  const [batch, setBatch] = useState(5);
  const [seed, setSeed] = useState(1);
  const [start, setStart] = useState<Pt>([3, 6]);
  const grid = useMemo(() => makeGrid((a, b) => GAB.loss(a, b), SGD_X, SGD_Y, 56), []);
  const steps = 300;
  const r = useRunner<Race>(
    () => ({ gd: [start], sgd: [start], gdLoss: [GAB.loss(...start)], sgdLoss: [GAB.loss(...start)], rand: rng(seed) }),
    (s) => {
      const [a, b] = s.gd[s.gd.length - 1];
      const [ga, gb] = GAB.grad(a, b);
      s.gd.push([a - lr * ga, b - lr * gb]);
      s.gdLoss.push(GAB.loss(...s.gd[s.gd.length - 1]));
      const idx = Array.from({ length: batch }, () => Math.floor(s.rand() * GAB.n));
      const [c, d] = s.sgd[s.sgd.length - 1];
      const [gc, gd] = GAB.grad(c, d, idx);
      s.sgd.push([c - lr * gc, d - lr * gd]);
      s.sgdLoss.push(GAB.loss(...s.sgd[s.sgd.length - 1]));
    },
    (s) => s.gd.length > steps,
    [lr, batch, seed, start],
    2,
  );
  const inside = (p: Pt) => p[0] >= SGD_X[0] && p[0] <= SGD_X[1] && p[1] >= SGD_Y[0] && p[1] <= SGD_Y[1];
  const gdNow = r.s.gd[r.s.gd.length - 1], sgdNow = r.s.sgd[r.s.sgd.length - 1];
  const xs = linspace(-15, 15, 160);
  return (
    <Notebook
      id="6.3"
      title="Stochastic gradient descent"
      intro={
        <>
          A Gabor model, f(x) = sin(φ₀ + 0.06φ₁x)·exp(−(φ₀ + 0.06φ₁x)²/32), has a loss surface with several valleys.
          Full-batch gradient descent rolls into whichever valley is nearest. Stochastic gradient descent estimates the
          gradient from a random mini-batch each step; the noise can shake it out of a poor valley into a better one.
        </>
      }
      tryThis={[
        'Press Run from the default start: gradient descent settles in a local minimum, while SGD usually reaches the global one near (0, 17).',
        'Press New SGD seed a few times: SGD does not always escape. It is a matter of luck, which is why runs are repeated with different seeds.',
        'Set the batch size to 28 (all the data): SGD becomes identical to gradient descent.',
      ]}
      takeaway="Mini-batches make each step cheaper and add noise. The noise helps escape poor minima, and it is also why the loss curve of real training is jagged."
    >
      <div className="dl-controls">
        <Slider label="learning rate α" value={lr} min={0.2} max={4} onChange={setLr} />
        <Slider label="batch size" value={batch} min={1} max={GAB.n} step={1} onChange={setBatch} show={(v) => String(v)} />
        <RunButtons r={r} extra={<button className="btn small" onClick={() => setSeed((s) => s + 1)}>New SGD seed</button>} />
      </div>
      <Legend items={[[SERIES.s2, 'gradient descent (all 28 points)'], [SERIES.s5, `SGD (batches of ${batch})`]]} />
      <div className="dl-cols">
        <div>
          <Plot
            x={SGD_X}
            y={SGD_Y}
            xLabel="φ₀"
            yLabel="φ₁"
            ariaLabel="Gabor loss surface with gradient descent and SGD paths"
            onDrag={(a, b, phase) => phase === 'start' && setStart([a, b])}
            draw={(f) => {
              drawGrid(f, grid);
              drawPath(f, r.s.gd, f.c.s2, inside);
              drawPath(f, r.s.sgd, f.c.s5, inside);
            }}
          />
          <div className="dl-caption">Drag to pick a start point. Darker is lower loss.</div>
        </div>
        <Plot
          x={[-15, 15]}
          y={[-1.2, 1.2]}
          xLabel="x"
          yLabel="y"
          ariaLabel="The data with both fitted Gabor curves"
          draw={(f) => {
            f.line(xs, xs.map((x) => GAB.g(gdNow[0], gdNow[1], x)), f.c.s2, 2);
            f.line(xs, xs.map((x) => GAB.g(sgdNow[0], sgdNow[1], x)), f.c.s5, 2);
            f.dots(GAB.xs.map((x, i) => [x, GAB.ys[i]] as Pt), f.c.ink, 3);
          }}
        />
        <LossCurves
          series={[{ losses: r.s.gdLoss, colour: 's2' }, { losses: r.s.sgdLoss, colour: 's5' }]}
          steps={steps}
          y={[-2.2, 0]}
          ariaLabel="Full-data loss of both methods against step"
        />
      </div>
      <Readout
        items={[
          ['step', r.s.gd.length - 1],
          ['gradient descent loss', fmt(r.s.gdLoss[r.s.gdLoss.length - 1])],
          ['SGD loss', fmt(r.s.sgdLoss[r.s.sgdLoss.length - 1])],
          ['SGD seed', seed],
        ]}
      />
    </Notebook>
  );
}

/* ---------- 6.4 Momentum ---------- */

const MOM_X: [number, number] = [-5, 5];
const MOM_Y: [number, number] = [-1.5, 1.5];
const momLoss = (a: number, b: number) => 0.5 * (a * a + 50 * b * b);
const momGrad = (a: number, b: number): Pt => [a, 50 * b];

interface MomentumRace {
  gd: Pt[];
  mo: Pt[];
  v: Pt;
  gdLoss: number[];
  moLoss: number[];
}

const CONVERGED = 1e-4;
const firstBelow = (losses: number[]) => {
  const i = losses.findIndex((l) => l < CONVERGED);
  return i < 0 ? 'not yet' : String(i);
};

function Momentum() {
  const [lr, setLr] = useState(0.035);
  const [beta, setBeta] = useState(0.7);
  const [start, setStart] = useState<Pt>([-4.5, 1]);
  const grid = useMemo(() => makeGrid(momLoss, MOM_X, MOM_Y), []);
  const steps = 300;
  const r = useRunner<MomentumRace>(
    () => ({ gd: [start], mo: [start], v: [0, 0], gdLoss: [momLoss(...start)], moLoss: [momLoss(...start)] }),
    (s) => {
      const [a, b] = s.gd[s.gd.length - 1];
      const [ga, gb] = momGrad(a, b);
      s.gd.push([a - lr * ga, b - lr * gb]);
      s.gdLoss.push(momLoss(...s.gd[s.gd.length - 1]));
      const [c, d] = s.mo[s.mo.length - 1];
      const [gc, gd] = momGrad(c, d);
      s.v = [beta * s.v[0] + gc, beta * s.v[1] + gd];
      s.mo.push([c - lr * s.v[0], d - lr * s.v[1]]);
      s.moLoss.push(momLoss(...s.mo[s.mo.length - 1]));
    },
    (s) => s.gd.length > steps || (s.gdLoss[s.gdLoss.length - 1] < CONVERGED && s.moLoss[s.moLoss.length - 1] < CONVERGED),
    [lr, beta, start],
    2,
  );
  const inside = (p: Pt) => p[0] >= MOM_X[0] && p[0] <= MOM_X[1] && p[1] >= MOM_Y[0] && p[1] <= MOM_Y[1];
  return (
    <Notebook
      id="6.4"
      title="Momentum"
      intro={
        <>
          In a long, narrow valley gradient descent bounces between the steep walls and crawls along the gentle floor.
          Momentum keeps a running sum of past gradients, v ← βv + ∇L, and steps along that: φ ← φ − αv. The
          side-to-side pushes cancel out, while the steady push along the valley builds up.
        </>
      }
      tryThis={[
        'Press Run: momentum reaches the minimum in far fewer steps than plain gradient descent.',
        'Set β to 0: momentum becomes gradient descent and the two paths are the same.',
        'Push β to 0.95: too much momentum overshoots and spirals in, which is slower again.',
        'Raise α above 0.04: gradient descent diverges along the steep axis, but momentum still copes.',
      ]}
      takeaway="Momentum damps oscillation across steep directions and speeds up progress along shallow ones. Most optimisers in use today include it."
    >
      <div className="dl-controls">
        <Slider label="learning rate α" value={lr} min={0.005} max={0.05} step={0.001} onChange={setLr} />
        <Slider label="momentum β" value={beta} min={0} max={0.98} onChange={setBeta} />
        <RunButtons r={r} />
      </div>
      <Legend items={[[SERIES.s2, 'gradient descent'], [SERIES.s3, 'momentum']]} />
      <div className="dl-cols">
        <div>
          <Plot
            x={MOM_X}
            y={MOM_Y}
            xLabel="φ₀"
            yLabel="φ₁"
            height={220}
            ariaLabel="A narrow valley with the gradient descent and momentum paths"
            onDrag={(a, b, phase) => phase === 'start' && setStart([a, b])}
            draw={(f) => {
              drawGrid(f, grid);
              drawPath(f, r.s.gd, f.c.s2, inside);
              drawPath(f, r.s.mo, f.c.s3, inside);
            }}
          />
          <div className="dl-caption">L = ½(φ₀² + 50φ₁²): 50 times steeper across the valley than along it. Drag to pick a start.</div>
        </div>
        <LossCurves
          series={[{ losses: r.s.gdLoss, colour: 's2' }, { losses: r.s.moLoss, colour: 's3' }]}
          steps={steps}
          y={[-5, 2]}
          ariaLabel="Loss of both methods against step"
        />
      </div>
      <Readout
        items={[
          ['step', r.s.gd.length - 1],
          ['gradient descent: steps to loss < 10⁻⁴', firstBelow(r.s.gdLoss)],
          ['momentum: steps to loss < 10⁻⁴', firstBelow(r.s.moLoss)],
        ]}
      />
    </Notebook>
  );
}

/* ---------- 6.5 Adam ---------- */

const ADAM_X: [number, number] = [-10, 10];
const ADAM_Y: [number, number] = [-2.5, 2.5];
const adamLoss = (a: number, b: number) => 0.5 * (0.1 * a * a + 10 * b * b);
const adamGrad = (a: number, b: number): Pt => [0.1 * a, 10 * b];

interface AdamRace {
  gd: Pt[];
  mo: Pt[];
  ad: Pt[];
  v: Pt; // momentum's running gradient
  m: Pt; // Adam's first moment
  s2: Pt; // Adam's second moment
  losses: [number[], number[], number[]];
}

function Adam() {
  const [lr, setLr] = useState(0.15);
  const [adamLr, setAdamLr] = useState(0.1);
  const [b1, setB1] = useState(0.9);
  const [b2, setB2] = useState(0.999);
  const [start, setStart] = useState<Pt>([-8, 1.8]);
  const grid = useMemo(() => makeGrid(adamLoss, ADAM_X, ADAM_Y), []);
  const steps = 300;
  const r = useRunner<AdamRace>(
    () => ({ gd: [start], mo: [start], ad: [start], v: [0, 0], m: [0, 0], s2: [0, 0], losses: [[adamLoss(...start)], [adamLoss(...start)], [adamLoss(...start)]] }),
    (s) => {
      const t = s.ad.length; // this is step t (1-based)
      const [a, b] = s.gd[s.gd.length - 1];
      const g1 = adamGrad(a, b);
      s.gd.push([a - lr * g1[0], b - lr * g1[1]]);
      const [c, d] = s.mo[s.mo.length - 1];
      const g2 = adamGrad(c, d);
      s.v = [b1 * s.v[0] + g2[0], b1 * s.v[1] + g2[1]];
      s.mo.push([c - lr * s.v[0], d - lr * s.v[1]]);
      const [e, h] = s.ad[s.ad.length - 1];
      const g3 = adamGrad(e, h);
      s.m = [b1 * s.m[0] + (1 - b1) * g3[0], b1 * s.m[1] + (1 - b1) * g3[1]];
      s.s2 = [b2 * s.s2[0] + (1 - b2) * g3[0] ** 2, b2 * s.s2[1] + (1 - b2) * g3[1] ** 2];
      const step = (k: 0 | 1) => {
        const mHat = s.m[k] / (1 - b1 ** t);
        const vHat = s.s2[k] / (1 - b2 ** t);
        return (adamLr * mHat) / (Math.sqrt(vHat) + 1e-8);
      };
      s.ad.push([e - step(0), h - step(1)]);
      s.losses[0].push(adamLoss(...s.gd[s.gd.length - 1]));
      s.losses[1].push(adamLoss(...s.mo[s.mo.length - 1]));
      s.losses[2].push(adamLoss(...s.ad[s.ad.length - 1]));
    },
    (s) => s.gd.length > steps,
    [lr, adamLr, b1, b2, start],
    2,
  );
  const inside = (p: Pt) => p[0] >= ADAM_X[0] && p[0] <= ADAM_X[1] && p[1] >= ADAM_Y[0] && p[1] <= ADAM_Y[1];
  const last = (k: 0 | 1 | 2) => r.s.losses[k][r.s.losses[k].length - 1];
  return (
    <Notebook
      id="6.5"
      title="Adam"
      intro={
        <>
          Here one parameter is 100 times more sensitive than the other. Gradient descent must use a learning rate small
          enough for the steep direction, so it barely moves along the shallow one. Adam keeps running averages of each
          parameter's gradient (m) and squared gradient (v), and steps by α·m̂/√v̂: roughly the same size for every
          parameter, whatever the scale of its gradient.
        </>
      }
      tryThis={[
        'Press Run: Adam heads diagonally at first, because it moves every parameter by about α per step.',
        'Watch gradient descent: it fixes φ₁ quickly and then creeps along φ₀.',
        'Set β₁ to 0: Adam loses its momentum and jitters near the minimum.',
        'Lower β₂ to 0.9: the scale estimate follows recent gradients closely, so the steps become more erratic.',
      ]}
      takeaway="Adam is momentum plus a separate step size per parameter. It is the default optimiser for training transformers because it copes with very different gradient scales across layers."
    >
      <div className="dl-controls">
        <Slider label="α (gradient descent, momentum)" value={lr} min={0.01} max={0.25} onChange={setLr} />
        <Slider label="α (Adam)" value={adamLr} min={0.01} max={0.5} onChange={setAdamLr} />
        <Slider label="β₁ (also momentum's β)" value={b1} min={0} max={0.99} onChange={setB1} />
        <Slider label="β₂" value={b2} min={0.5} max={0.999} step={0.001} onChange={setB2} />
        <RunButtons r={r} />
      </div>
      <Legend items={[[SERIES.s2, 'gradient descent'], [SERIES.s3, 'momentum'], [SERIES.brand, 'Adam']]} />
      <div className="dl-cols">
        <div>
          <Plot
            x={ADAM_X}
            y={ADAM_Y}
            xLabel="φ₀"
            yLabel="φ₁"
            ariaLabel="A surface much steeper in one direction, with three optimiser paths"
            onDrag={(a, b, phase) => phase === 'start' && setStart([a, b])}
            draw={(f) => {
              drawGrid(f, grid);
              drawPath(f, r.s.gd, f.c.s2, inside);
              drawPath(f, r.s.mo, f.c.s3, inside);
              drawPath(f, r.s.ad, f.c.brand, inside);
            }}
          />
          <div className="dl-caption">L = ½(0.1φ₀² + 10φ₁²). Drag to pick a start.</div>
        </div>
        <LossCurves
          series={[{ losses: r.s.losses[0], colour: 's2' }, { losses: r.s.losses[1], colour: 's3' }, { losses: r.s.losses[2], colour: 'brand' }]}
          steps={steps}
          y={[-5, 2]}
          ariaLabel="Loss of the three optimisers against step"
        />
      </div>
      <Readout
        items={[
          ['step', r.s.gd.length - 1],
          ['gradient descent loss', fmt(last(0))],
          ['momentum loss', fmt(last(1))],
          ['Adam loss', fmt(last(2))],
        ]}
      />
    </Notebook>
  );
}

export const CHAPTERS: ChapterDef[] = [
  {
    n: 5,
    title: 'Loss functions',
    blurb:
      'A loss function measures how badly a model fits. Choose a probability distribution for the output, then minimise the negative log-likelihood of the data: that one recipe gives least squares, binary cross-entropy and multiclass cross-entropy.',
    notebooks: [
      { id: '5.1', title: 'Least squares loss', Component: LeastSquares },
      { id: '5.2', title: 'Binary cross-entropy loss', Component: BinaryCrossEntropy },
      { id: '5.3', title: 'Multiclass cross-entropy loss', Component: MulticlassCrossEntropy },
    ],
  },
  {
    n: 6,
    title: 'Fitting models',
    blurb:
      'Training means finding the parameters with the lowest loss. Start with a search along one line, then gradient descent, its stochastic version, momentum, and Adam.',
    notebooks: [
      { id: '6.1', title: 'Line search', Component: LineSearch },
      { id: '6.2', title: 'Gradient descent', Component: GradientDescent },
      { id: '6.3', title: 'Stochastic gradient descent', Component: StochasticGradientDescent },
      { id: '6.4', title: 'Momentum', Component: Momentum },
      { id: '6.5', title: 'Adam', Component: Adam },
    ],
  },
];
