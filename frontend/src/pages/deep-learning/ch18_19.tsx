import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChapterDef } from './chapters';
import { clamp, fmt, gauss, linspace, mean, rng, softmax, sum, useAnimation } from './kit';
import { Chips, Notebook, Readout, Slider } from './Notebook';
import { mix, Plot, type Frame } from './Plot';

/* ---------- helpers shared by both chapters ---------- */

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

/** Densities of `xs` in `bins` equal bins over [lo, hi], so the bars integrate to 1 like a density curve. */
function histogram(xs: ArrayLike<number>, lo: number, hi: number, bins: number): number[] {
  const out = Array(bins).fill(0) as number[];
  const w = (hi - lo) / bins;
  for (let i = 0; i < xs.length; i++) {
    const k = Math.floor((xs[i] - lo) / w);
    if (k >= 0 && k < bins) out[k]++;
  }
  return out.map((c) => c / (xs.length * w));
}

/** Draws a histogram as translucent bars, cut off at `top` so tall bars stay inside the plot. */
function drawHist(f: Frame, dens: number[], lo: number, hi: number, top: number, colour: string, alpha = 0.4) {
  const { ctx } = f;
  const w = (hi - lo) / dens.length;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = colour;
  dens.forEach((d, i) => {
    if (d <= 0) return;
    const x0 = f.x(lo + i * w),
      x1 = f.x(lo + (i + 1) * w);
    const y0 = f.y(0),
      y1 = f.y(Math.min(d, top));
    ctx.fillRect(x0, y1, Math.max(1, x1 - x0 - 1), y0 - y1);
  });
  ctx.restore();
}

/** Like ch05's runner: a mutable state advanced by `step`, `perFrame` times every `every` animation frames. */
function useRunner<S>(
  make: () => S,
  step: (s: S) => void,
  finished: (s: S) => boolean,
  deps: unknown[],
  perFrame = 1,
  every = 1,
) {
  const state = useRef<S | null>(null);
  if (state.current === null) state.current = make();
  const makeRef = useRef(make);
  makeRef.current = make;
  const [, render] = useState(0);
  const [running, setRunning] = useState(false);
  const frame = useRef(0);
  const redraw = () => render((n) => n + 1);

  useAnimation(running, () => {
    if (++frame.current % every) return;
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

  const s = state.current as S;
  return {
    s,
    running,
    toggle: () => setRunning((r) => !r && !finished(state.current as S)),
    stepOnce: (n = 1) => {
      for (let i = 0; i < n && !finished(state.current as S); i++) step(state.current as S);
      redraw();
    },
    reset,
  };
}

function RunButtons({ r }: { r: { running: boolean; toggle: () => void; stepOnce: () => void; reset: () => void } }) {
  return (
    <>
      <button className="btn primary small" onClick={r.toggle}>
        {r.running ? 'Pause' : 'Run'}
      </button>
      <button className="btn small" onClick={() => r.stepOnce()} disabled={r.running}>
        Step
      </button>
      <button className="btn small" onClick={r.reset}>
        Reset
      </button>
    </>
  );
}

/* ---------- diffusion: the data, the schedules and the exact denoiser ---------- */

/** The 1D data distribution Pr(x): a mixture of three normals. */
const DATA = { w: [0.3, 0.45, 0.25], mu: [-2.1, 0.3, 2.4], s: [0.35, 0.45, 0.3] };
const K = DATA.w.length;
const S2 = DATA.s.map((s) => s * s);
const DATA_MEAN = sum(DATA.w.map((w, k) => w * DATA.mu[k]));
const DATA_SD = Math.sqrt(sum(DATA.w.map((w, k) => w * (S2[k] + DATA.mu[k] ** 2))) - DATA_MEAN ** 2);

const normPdf = (x: number, m: number, v: number) => Math.exp(-((x - m) ** 2) / (2 * v)) / Math.sqrt(2 * Math.PI * v);

/** Error function (Abramowitz and Stegun 7.1.26), accurate to about 1e-7: enough for a CDF. */
function erf(x: number): number {
  const s = Math.sign(x);
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
  return s * y;
}

/**
 * The diffused data q(z_t), where `a` is α_t (the book's product of 1 − β). Each component N(μ, s²) of Pr(x)
 * becomes N(√α μ, α s² + 1 − α), so the marginal stays a mixture and has a closed form.
 */
function marginal(z: number, a: number): number {
  let p = 0;
  for (let k = 0; k < K; k++) p += DATA.w[k] * normPdf(z, Math.sqrt(a) * DATA.mu[k], a * S2[k] + 1 - a);
  return p;
}

function marginalCdf(z: number, a: number): number {
  let p = 0;
  for (let k = 0; k < K; k++) {
    const v = a * S2[k] + 1 - a;
    p += DATA.w[k] * 0.5 * (1 + erf((z - Math.sqrt(a) * DATA.mu[k]) / Math.sqrt(2 * v)));
  }
  return p;
}

const LP = new Float64Array(K);

/**
 * E[x | z_t = z]: the best possible guess of the clean data from a noisy value. A network trained with a
 * least-squares loss converges to this; for a mixture of normals it is exact (Bayes' rule per component).
 */
function denoise(z: number, a: number): number {
  const sa = Math.sqrt(a);
  let top = -Infinity;
  for (let k = 0; k < K; k++) {
    const v = a * S2[k] + 1 - a;
    LP[k] = Math.log(DATA.w[k]) - 0.5 * Math.log(v) - (z - sa * DATA.mu[k]) ** 2 / (2 * v);
    top = Math.max(top, LP[k]);
  }
  let tot = 0,
    acc = 0;
  for (let k = 0; k < K; k++) {
    const v = a * S2[k] + 1 - a;
    const p = Math.exp(LP[k] - top);
    tot += p;
    acc += p * (DATA.mu[k] + ((sa * S2[k]) / v) * (z - sa * DATA.mu[k]));
  }
  return acc / tot;
}

function sampleData(rand: () => number): number {
  const u = rand();
  let k = 0;
  for (let c = DATA.w[0]; u > c && k < K - 1;) c += DATA.w[++k];
  return DATA.mu[k] + DATA.s[k] * gauss(rand);
}

/** The Wasserstein-1 distance between samples and q(z_t): the area between their two CDFs. */
function w1(samples: ArrayLike<number>, a: number): number {
  const xs = Float64Array.from(samples).sort();
  const lo = -6,
    hi = 6,
    n = 600,
    dz = (hi - lo) / n;
  let j = 0,
    acc = 0;
  for (let i = 0; i < n; i++) {
    const z = lo + (i + 0.5) * dz;
    while (j < xs.length && xs[j] <= z) j++;
    acc += Math.abs(j / xs.length - marginalCdf(z, a)) * dz;
  }
  return acc;
}

type ScheduleKind = 'constant' | 'linear' | 'cosine';

/** β_t and α_t = ∏(1 − β_s) for t = 0…T, with β_0 = 0 and α_0 = 1 so index t is step t. */
interface Schedule {
  T: number;
  beta: number[];
  alpha: number[];
}

function makeSchedule(kind: ScheduleKind, T: number, lo = 1e-3, hi = 0.1): Schedule {
  const beta = [0];
  for (let t = 1; t <= T; t++) {
    if (kind === 'constant') beta.push(0.03);
    else if (kind === 'linear') beta.push(lo + ((hi - lo) * (t - 1)) / (T - 1));
    else {
      const g = (u: number) => Math.cos(((u / T + 0.008) / 1.008) * (Math.PI / 2)) ** 2;
      beta.push(Math.min(0.999, 1 - g(t) / g(t - 1)));
    }
  }
  const alpha = [1];
  for (let t = 1; t <= T; t++) alpha.push(alpha[t - 1] * (1 - beta[t]));
  return { T, beta, alpha };
}

/** The true marginals q(z_t) as a heat map: z across, t up, so the data is at the bottom and noise at the top. */
function drawMarginalHeat(f: Frame, sch: Schedule) {
  f.heat((z, tt) => {
    const a = sch.alpha[clamp(Math.round(tt), 0, sch.T)];
    return mix(f.c.surface, f.c.s1, 0.8 * Math.min(1, Math.sqrt(marginal(z, a) / 0.45)));
  }, 90);
}

const ZS = linspace(-4, 4, 241);

/* ---------- 18.1 Diffusion encoder ---------- */

const T1 = 100;

function DiffusionEncoder() {
  const [kind, setKind] = useState<ScheduleKind>('linear');
  const [t, setT] = useState(20);
  const [x0, setX0] = useState(2);
  const [seed, setSeed] = useState(1);
  const [playing, setPlaying] = useState(false);
  const sch = useMemo(() => makeSchedule(kind, T1), [kind]);
  const paths = useMemo(() => {
    const rand = rng(seed);
    return Array.from({ length: 5 }, () => {
      const z = [x0];
      for (let s = 1; s <= T1; s++)
        z.push(Math.sqrt(1 - sch.beta[s]) * z[s - 1] + Math.sqrt(sch.beta[s]) * gauss(rand));
      return z;
    });
  }, [sch, x0, seed]);
  useAnimation(playing, () => {
    if (t >= T1) {
      setPlaying(false);
      return false;
    }
    setT(t + 1);
  });

  const a = sch.alpha[t];
  const ts = Array.from({ length: T1 + 1 }, (_, i) => i);
  const kMean = ts.map((s) => Math.sqrt(sch.alpha[s]) * x0);
  const kSd = ts.map((s) => Math.sqrt(1 - sch.alpha[s]));
  // KL(q(z_t) || N(0, 1)) by summing over a grid.
  let kl = 0;
  for (const z of linspace(-7, 7, 561)) {
    const q = marginal(z, a);
    if (q > 1e-300) kl += q * Math.log(q / normPdf(z, 0, 1)) * (14 / 560);
  }

  return (
    <Notebook
      id="18.1"
      title="Diffusion encoder"
      intro={
        <>
          The encoder of a diffusion model has no parameters. Each step shrinks the current value by √(1 − β<sub>t</sub>
          ) and adds normal noise with variance β<sub>t</sub>. After t steps a data point x has become z<sub>t</sub> =
          √α<sub>t</sub> x + √(1 − α<sub>t</sub>) ε, with α<sub>t</sub> the product of the (1 − β) terms so far.
          Averaging that over the data gives the marginal q(z<sub>t</sub>), which drifts towards a standard normal.
        </>
      }
      tryThis={[
        'Press Play: the three bumps of Pr(x) blur into one and end as the dashed standard normal.',
        'Drag t: the diffusion kernel q(zₜ | x*) (orange) has mean √αₜ x* and spread √(1 − αₜ), so every start ends in the same place.',
        'Switch to the constant schedule: after 100 steps α is still about 0.05 and the KL to N(0, 1) has not reached zero.',
        'The cosine schedule keeps more signal early and destroys it quickly at the end.',
      ]}
      takeaway={
        <>
          Because the steps are normal and linear, q(z<sub>t</sub> | x) has a closed form, so training can jump to any t
          in one go. The schedule decides how quickly the data is forgotten; by step T nothing of x should remain.
        </>
      }
    >
      <div className="dl-controls">
        <Chips<ScheduleKind>
          options={[
            { id: 'linear', label: 'Linear β' },
            { id: 'constant', label: 'Constant β = 0.03' },
            { id: 'cosine', label: 'Cosine' },
          ]}
          value={kind}
          onChange={setKind}
        />
        <Slider label="t" value={t} min={0} max={T1} step={1} onChange={setT} show={(v) => String(v)} />
        <Slider label="start x*" value={x0} min={-3.5} max={3.5} onChange={setX0} />
        <button
          className="btn primary small"
          onClick={() => {
            if (t >= T1) setT(0);
            setPlaying((p) => !p);
          }}
        >
          {playing ? 'Pause' : 'Play'}
        </button>
        <button className="btn small" onClick={() => setSeed((s) => s + 1)}>
          New paths
        </button>
      </div>
      <div className="dl-cols">
        <div>
          <Plot
            x={[-4, 4]}
            y={[0, T1]}
            height={260}
            xLabel="z"
            yLabel="t"
            ariaLabel="Heat map of the marginal q(z_t) for every t, with noising paths from x star"
            draw={(f) => {
              drawMarginalHeat(f, sch);
              for (const p of paths) f.line(p, ts, f.c.ink2, 1);
              f.line(
                kMean.map((m, i) => m + 2 * kSd[i]),
                ts,
                f.c.s2,
                1.5,
                [4, 3],
              );
              f.line(
                kMean.map((m, i) => m - 2 * kSd[i]),
                ts,
                f.c.s2,
                1.5,
                [4, 3],
              );
              f.hline(t, f.c.ink, [2, 3]);
            }}
          />
          <p className="dl-caption">
            Shading is q(z<sub>t</sub>), data at the bottom. Grey lines are five noising paths from x*; the orange
            dashes are ±2 standard deviations of q(z<sub>t</sub> | x*).
          </p>
        </div>
        <div>
          <Plot
            x={[-4, 4]}
            y={[0, 1.2]}
            height={260}
            xLabel="z"
            ariaLabel="Densities at the chosen time step"
            draw={(f) => {
              f.line(
                ZS,
                ZS.map((z) => marginal(z, 1)),
                f.c.muted,
                1.5,
                [2, 3],
              );
              f.line(
                ZS,
                ZS.map((z) => normPdf(z, 0, 1)),
                f.c.ink2,
                1.5,
                [6, 4],
              );
              f.line(
                ZS,
                ZS.map((z) => marginal(z, a)),
                f.c.s1,
                2.5,
              );
              if (t > 0)
                f.line(
                  ZS,
                  ZS.map((z) => normPdf(z, Math.sqrt(a) * x0, 1 - a)),
                  f.c.s2,
                  2,
                );
              else f.vline(x0, f.c.s2, []);
            }}
          />
          <Legend
            items={[
              ['var(--s1)', `q(zₜ) at t = ${t}`],
              ['var(--s2)', 'q(zₜ | x*)'],
              ['var(--muted)', 'Pr(x)'],
              ['var(--ink2)', 'N(0, 1)'],
            ]}
          />
        </div>
      </div>
      <div className="dl-cols">
        <Plot
          x={[0, T1]}
          y={[0, 0.15]}
          height={150}
          xLabel="t"
          yLabel="βₜ"
          ariaLabel="The noise schedule beta over time"
          draw={(f) => {
            f.line(ts.slice(1), sch.beta.slice(1), f.c.s4, 2);
            f.vline(t, f.c.ink);
          }}
        />
        <Plot
          x={[0, T1]}
          y={[0, 1]}
          height={150}
          xLabel="t"
          yLabel="αₜ (signal kept)"
          ariaLabel="The cumulative product alpha over time"
          draw={(f) => {
            f.line(ts, sch.alpha, f.c.s3, 2);
            f.line(
              ts,
              sch.alpha.map((v) => 1 - v),
              f.c.s2,
              1.5,
              [4, 3],
            );
            f.vline(t, f.c.ink);
          }}
        />
      </div>
      <Readout
        items={[
          ['βₜ', t ? fmt(sch.beta[t]) : '–'],
          ['αₜ', fmt(a)],
          ['mean √αₜ x*', fmt(Math.sqrt(a) * x0)],
          ['spread √(1 − αₜ)', fmt(Math.sqrt(1 - a))],
          ['KL(q(zₜ) ‖ N(0, 1))', fmt(kl)],
        ]}
      />
    </Notebook>
  );
}

/* ---------- 18.2 1D diffusion model ---------- */

const MODEL = makeSchedule('linear', 100);
const MT = MODEL.T;

/** The ideal decoder mean f_t[z_t]: the mean of q(z_{t−1} | z_t, x), averaged over x given z_t. */
function reverseMean(z: number, t: number, sch: Schedule = MODEL): number {
  const a = sch.alpha[t],
    ap = sch.alpha[t - 1],
    b = sch.beta[t];
  return ((1 - ap) / (1 - a)) * Math.sqrt(1 - b) * z + ((Math.sqrt(ap) * b) / (1 - a)) * denoise(z, a);
}

/** The variance of q(z_{t−1} | z_t, x), used as the fixed σ²_t of each reverse step. */
const postVar = (t: number, sch: Schedule = MODEL) => (sch.beta[t] * (1 - sch.alpha[t - 1])) / (1 - sch.alpha[t]);

/** Ancestral sampling: z_T from N(0, 1), then z_{t−1} = f_t[z_t] + σ_t ε, with the last step noise-free. */
function sampleReverse(noise: number, seed: number, n: number): Float64Array[] {
  const rand = rng(seed);
  const zs: Float64Array[] = Array.from({ length: MT + 1 }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) zs[MT][i] = gauss(rand);
  for (let t = MT; t >= 1; t--) {
    const sd = noise * Math.sqrt(postVar(t));
    for (let i = 0; i < n; i++) zs[t - 1][i] = reverseMean(zs[t][i], t) + (t > 1 ? sd * gauss(rand) : 0);
  }
  return zs;
}

const N_REV = 1500;

function DiffusionModel() {
  const [seed, setSeed] = useState(4);
  const [noise, setNoise] = useState(1);
  const [k, setK] = useState(MT);
  const [running, setRunning] = useState(false);
  const zs = useMemo(() => sampleReverse(noise, seed, N_REV), [noise, seed]);
  useAnimation(running, () => {
    if (k >= MT) {
      setRunning(false);
      return false;
    }
    setK(Math.min(MT, k + 1));
  });
  const t = MT - k;
  const cur = zs[t];
  const a = MODEL.alpha[t];
  const dens = histogram(cur, -4, 4, 48);
  const paths = Array.from({ length: 8 }, (_, i) => Array.from({ length: k + 1 }, (_, j) => zs[MT - j][i]));
  const pathT = Array.from({ length: k + 1 }, (_, j) => MT - j);
  const sampleMean = mean(Array.from(cur));
  const sampleSd = Math.sqrt(mean(Array.from(cur, (v) => (v - sampleMean) ** 2)));

  return (
    <Notebook
      id="18.2"
      title="1D diffusion model"
      intro={
        <>
          The decoder runs the encoder backwards. It starts from z<sub>T</sub> drawn from N(0, 1) and at each step draws
          z<sub>t−1</sub> from a normal with mean f<sub>t</sub>[z<sub>t</sub>] and a fixed spread σ<sub>t</sub>.
          Training f<sub>t</sub> by least squares makes it the average of the mean of q(z<sub>t−1</sub> | z<sub>t</sub>,
          x) over every x that could have produced z<sub>t</sub>. No network is trained here: for a mixture of normals
          that ideal f<sub>t</sub> has a closed form, so this is what a perfectly trained model would do.
        </>
      }
      tryThis={[
        'Press Run and watch the histogram of 1,500 samples follow the true marginal q(zₜ) down to the three bumps of Pr(x).',
        'Set the reverse noise to 0: every path follows the mean, the samples bunch together and the spread is far too small.',
        'Turn the noise above 1: the samples come out too wide. The noise term is part of the model, not a nuisance.',
        'Look at the denoiser plot: at large t it guesses the data mean whatever z is; near t = 0 it snaps to the nearest bump.',
      ]}
      takeaway={
        <>
          Sampling is many small denoising steps, each a normal distribution. Each step only has to move the
          distribution a little, which is why a simple normal is a good enough model for it.
        </>
      }
    >
      <div className="dl-controls">
        <button
          className="btn primary small"
          onClick={() => {
            if (k >= MT) setK(0);
            setRunning((r) => !r);
          }}
        >
          {running ? 'Pause' : 'Run'}
        </button>
        <Slider
          label="reverse steps done"
          value={k}
          min={0}
          max={MT}
          step={1}
          onChange={setK}
          show={(v) => `${v} (t = ${MT - v})`}
        />
        <Slider label="reverse noise ×σₜ" value={noise} min={0} max={1.6} step={0.05} onChange={setNoise} />
        <button className="btn small" onClick={() => setSeed((s) => s + 1)}>
          New samples
        </button>
      </div>
      <div className="dl-cols">
        <div>
          <Plot
            x={[-4, 4]}
            y={[0, MT]}
            height={260}
            xLabel="z"
            yLabel="t"
            ariaLabel="Reverse sampling paths over the true marginals"
            draw={(f) => {
              drawMarginalHeat(f, MODEL);
              const cols = [f.c.s2, f.c.s3, f.c.s4, f.c.s5, f.c.brand, f.c.ink2, f.c.s2, f.c.s3];
              paths.forEach((p, i) => f.line(p, pathT, cols[i], 1.3));
              f.hline(t, f.c.ink, [2, 3]);
            }}
          />
          <p className="dl-caption">Eight of the sample paths, from noise at the top to data at the bottom.</p>
        </div>
        <div>
          <Plot
            x={[-4, 4]}
            y={[0, 0.9]}
            height={260}
            xLabel="z"
            ariaLabel="Histogram of samples at the current step against the true marginal"
            draw={(f) => {
              drawHist(f, dens, -4, 4, 0.9, f.c.s2);
              f.line(
                ZS,
                ZS.map((z) => marginal(z, a)),
                f.c.s1,
                2.5,
              );
              if (t > 0)
                f.line(
                  ZS,
                  ZS.map((z) => marginal(z, 1)),
                  f.c.muted,
                  1.5,
                  [2, 3],
                );
            }}
          />
          <Legend
            items={[
              ['var(--s2)', `samples at t = ${t}`],
              ['var(--s1)', 'true q(zₜ)'],
              ['var(--muted)', 'Pr(x)'],
            ]}
          />
        </div>
        <div>
          <Plot
            x={[-4, 4]}
            y={[-4, 4]}
            height={260}
            xLabel="zₜ"
            yLabel="E[x | zₜ]"
            ariaLabel="The ideal denoiser at the current step"
            draw={(f) => {
              f.line(ZS, ZS, f.c.muted, 1, [4, 4]);
              if (t > 0)
                f.line(
                  ZS,
                  ZS.map((z) => denoise(z, a)),
                  f.c.s3,
                  2.5,
                );
              for (const m of DATA.mu) f.hline(m, f.c.line, [2, 4]);
            }}
          />
          <p className="dl-caption">
            The best guess of the clean x from z<sub>t</sub> at t = {t}. Dashed grey: the diagonal; faint lines: the
            three means of Pr(x).
          </p>
        </div>
      </div>
      <Readout
        items={[
          ['t', t],
          ['sample mean (data ' + fmt(DATA_MEAN) + ')', fmt(sampleMean)],
          ['sample spread (data ' + fmt(DATA_SD) + ')', fmt(sampleSd)],
          ['distance W₁ to true q(zₜ)', fmt(w1(cur, a))],
        ]}
      />
    </Notebook>
  );
}

/* ---------- 18.3 Reparameterised model ---------- */

/** One reverse run with a deliberately imperfect network: its output is off by `err` × N(0, 1) at each step. */
function sampleWithError(form: 'mean' | 'noise', err: number, seed: number, n: number): Float64Array {
  const noise = rng(seed),
    wrong = rng(seed + 1000);
  const z = new Float64Array(n);
  for (let i = 0; i < n; i++) z[i] = gauss(noise);
  for (let t = MT; t >= 1; t--) {
    const a = MODEL.alpha[t],
      b = MODEL.beta[t];
    const sd = Math.sqrt(postVar(t));
    const kappa = b / (Math.sqrt(1 - a) * Math.sqrt(1 - b));
    for (let i = 0; i < n; i++) {
      const e = err * gauss(wrong);
      let m: number;
      if (form === 'mean') m = reverseMean(z[i], t) + e;
      else {
        const g = (z[i] - Math.sqrt(a) * denoise(z[i], a)) / Math.sqrt(1 - a);
        m = z[i] / Math.sqrt(1 - b) - kappa * (g + e);
      }
      z[i] = m + (t > 1 ? sd * gauss(noise) : 0);
    }
  }
  return z;
}

function Reparameterised() {
  const [t, setT] = useState(30);
  const [err, setErr] = useState(0);
  const [seed, setSeed] = useState(2);
  const a = MODEL.alpha[t],
    ap = MODEL.alpha[t - 1],
    b = MODEL.beta[t];
  const c1 = ((1 - ap) / (1 - a)) * Math.sqrt(1 - b),
    c2 = (Math.sqrt(ap) * b) / (1 - a);
  const kappa = b / (Math.sqrt(1 - a) * Math.sqrt(1 - b));
  const pairs = useMemo(() => {
    const rand = rng(seed * 31 + t);
    return Array.from({ length: 250 }, () => {
      const x = sampleData(rand),
        eps = gauss(rand);
      const z = Math.sqrt(a) * x + Math.sqrt(1 - a) * eps;
      return { z, eps, corr: c1 * z + c2 * x - z };
    });
  }, [seed, t, a, c1, c2]);
  const fIdeal = (z: number) => reverseMean(z, t);
  const gIdeal = (z: number) => (z - Math.sqrt(a) * denoise(z, a)) / Math.sqrt(1 - a);
  const gFromF = (z: number) => ((z / Math.sqrt(1 - b) - fIdeal(z)) * Math.sqrt(1 - a) * Math.sqrt(1 - b)) / b;
  const spreadF = Math.sqrt(mean(pairs.map((p) => (p.corr - (fIdeal(p.z) - p.z)) ** 2)));
  const spreadG = Math.sqrt(mean(pairs.map((p) => (p.eps - gIdeal(p.z)) ** 2)));
  const range = 1.15 * Math.max(1e-3, ...pairs.map((p) => Math.abs(p.corr)));
  const agree = Math.max(...ZS.map((z) => Math.abs(gIdeal(z) - gFromF(z))));

  const samples = useMemo(
    () => ({ mean: sampleWithError('mean', err, 9, 1200), noise: sampleWithError('noise', err, 9, 1200) }),
    [err],
  );
  const hMean = histogram(samples.mean, -4, 4, 48),
    hNoise = histogram(samples.noise, -4, 4, 48);
  const ts = Array.from({ length: MT - 1 }, (_, i) => i + 2);
  // Weight on |g − ε|² in the ELBO with σ²ₜ = the posterior variance: βₜ / (2 (1 − βₜ)(1 − α_{t−1})).
  const weights = ts.map((s) => Math.log10(MODEL.beta[s] / (2 * (1 - MODEL.beta[s]) * (1 - MODEL.alpha[s - 1]))));

  return (
    <Notebook
      id="18.3"
      title="Reparameterised model"
      intro={
        <>
          Since z<sub>t</sub> = √α<sub>t</sub> x + √(1 − α<sub>t</sub>) ε, knowing the noise ε is the same as knowing x.
          So the network g<sub>t</sub>[z<sub>t</sub>] can predict ε instead of the mean of z<sub>t−1</sub>, and the mean
          is recovered as z<sub>t</sub>/√(1 − β<sub>t</sub>) − κ<sub>t</sub> g<sub>t</sub>, with κ<sub>t</sub> = β
          <sub>t</sub>/(√(1 − α<sub>t</sub>)√(1 − β<sub>t</sub>)). Both forms have the same ideal answer; they differ in
          what the network is asked to output.
        </>
      }
      tryThis={[
        'Move t: in the mean form the target is z itself plus a tiny correction (left, note the y scale); in the noise form the target is ε, with unit spread at every t.',
        'The dashed line on the right converts the ideal mean back into a noise prediction: it lies exactly on the ideal g.',
        'Raise the network error: the same size of mistake ruins the mean-form samples but barely changes the noise-form ones, because κₜ shrinks each error before it moves z.',
      ]}
      takeaway={
        <>
          Predicting the noise gives every time step a target of the same, unit scale, so one network can serve all t
          and the per-step weights can be dropped. The loss becomes plain least squares between g<sub>t</sub>[z
          <sub>t</sub>] and the ε that made z<sub>t</sub>.
        </>
      }
    >
      <div className="dl-controls">
        <Slider label="t" value={t} min={2} max={MT} step={1} onChange={setT} show={(v) => String(v)} />
        <button className="btn small" onClick={() => setSeed((s) => s + 1)}>
          New training pairs
        </button>
      </div>
      <div className="dl-cols">
        <div>
          <Plot
            x={[-4, 4]}
            y={[-range, range]}
            height={220}
            xLabel="zₜ"
            yLabel="target − zₜ"
            ariaLabel="Mean-form training targets minus z, with the ideal network"
            draw={(f) => {
              f.dots(
                pairs.map((p) => [p.z, p.corr] as [number, number]),
                f.c.s2,
                2,
              );
              f.line(
                ZS,
                ZS.map((z) => fIdeal(z) - z),
                f.c.ink,
                2.5,
              );
            }}
          />
          <p className="dl-caption">
            Mean form: the target is the mean of q(z<sub>t−1</sub> | z<sub>t</sub>, x), shown minus z<sub>t</sub>. The
            black line is the ideal f<sub>t</sub> − z<sub>t</sub>.
          </p>
        </div>
        <div>
          <Plot
            x={[-4, 4]}
            y={[-3.5, 3.5]}
            height={220}
            xLabel="zₜ"
            yLabel="ε"
            ariaLabel="Noise-form training targets with the ideal noise predictor"
            draw={(f) => {
              f.dots(
                pairs.map((p) => [p.z, p.eps] as [number, number]),
                f.c.s1,
                2,
              );
              f.line(ZS, ZS.map(gIdeal), f.c.ink, 2.5);
              f.line(ZS, ZS.map(gFromF), f.c.s4, 2, [5, 4]);
            }}
          />
          <p className="dl-caption">
            Noise form: the target is the ε that was mixed in. Black: ideal g<sub>t</sub>; orange dashes: the ideal mean
            converted to a noise prediction.
          </p>
        </div>
      </div>
      <Readout
        items={[
          ['target spread, mean form', fmt(spreadF)],
          ['target spread, noise form', fmt(spreadG)],
          ['κₜ (error in g → error in mean)', fmt(kappa)],
          ['largest gap between the two ideal answers', fmt(agree)],
        ]}
      />
      <div className="dl-controls">
        <Slider label="network error (sd per step)" value={err} min={0} max={0.3} step={0.01} onChange={setErr} />
      </div>
      <div className="dl-cols">
        <div>
          <Plot
            x={[-4, 4]}
            y={[0, 1]}
            height={200}
            xLabel="x"
            ariaLabel="Samples from the two forms with the same network error"
            draw={(f) => {
              drawHist(f, hMean, -4, 4, 1, f.c.s2, 0.35);
              drawHist(f, hNoise, -4, 4, 1, f.c.s1, 0.35);
              f.line(
                ZS,
                ZS.map((z) => marginal(z, 1)),
                f.c.ink,
                2,
              );
            }}
          />
          <Legend
            items={[
              ['var(--s2)', `mean form (W₁ ${fmt(w1(samples.mean, 1))})`],
              ['var(--s1)', `noise form (W₁ ${fmt(w1(samples.noise, 1))})`],
              ['var(--ink)', 'Pr(x)'],
            ]}
          />
        </div>
        <div>
          <Plot
            x={[2, MT]}
            y={[Math.floor(Math.min(...weights)), Math.ceil(Math.max(...weights))]}
            height={200}
            xLabel="t"
            yLabel="log₁₀ weight"
            ariaLabel="The per-step weight on the noise loss that the simple loss drops"
            draw={(f) => {
              f.line(ts, weights, f.c.s4, 2);
              f.vline(t, f.c.ink);
            }}
          />
          <p className="dl-caption">
            The bound weights step t's noise error by β<sub>t</sub>/(2(1 − β<sub>t</sub>)(1 − α<sub>t−1</sub>)). The
            simple loss sets every weight to 1, which puts relatively more effort into the noisy steps.
          </p>
        </div>
      </div>
    </Notebook>
  );
}

/* ---------- 18.4 Families of diffusion models ---------- */

const FAM = makeSchedule('linear', 1000, 1e-4, 0.02);
const FT = FAM.T;

/**
 * A sampler from the DDIM family on S evenly spaced steps. η = 1 adds the posterior noise (DDPM with skipped
 * steps); η = 0 adds none, so the map from z_T to x is deterministic. Both use the same ideal noise predictor.
 */
function sampleFamily(steps: number, eta: number, n: number, seed: number, keep = 0) {
  const start = rng(seed),
    noise = rng(seed + 77);
  const z = new Float64Array(n);
  for (let i = 0; i < n; i++) z[i] = gauss(start);
  const times = Array.from({ length: steps + 1 }, (_, i) => Math.round(((steps - i) * FT) / steps));
  const paths = Array.from({ length: keep }, (_, i) => [z[i]]);
  for (let j = 0; j < steps; j++) {
    const a = FAM.alpha[times[j]],
      as = FAM.alpha[times[j + 1]];
    const sig = eta * Math.sqrt(((1 - as) / (1 - a)) * (1 - a / as));
    const keepEps = Math.sqrt(Math.max(0, 1 - as - sig * sig));
    for (let i = 0; i < n; i++) {
      const xh = denoise(z[i], a);
      const eps = (z[i] - Math.sqrt(a) * xh) / Math.sqrt(1 - a);
      z[i] = Math.sqrt(as) * xh + keepEps * eps + (sig > 0 ? sig * gauss(noise) : 0);
      if (i < keep) paths[i].push(z[i]);
    }
  }
  return { z, times, paths };
}

const STEP_LIST = [1, 2, 3, 4, 5, 7, 10, 15, 20, 30, 50, 70, 100, 200, 500, 1000];

function Families() {
  const [steps, setSteps] = useState(10);
  const [seed, setSeed] = useState(3);
  const ddpm = useMemo(() => sampleFamily(steps, 1, 2000, seed, 8), [steps, seed]);
  const ddim = useMemo(() => sampleFamily(steps, 0, 2000, seed, 8), [steps, seed]);
  const curve = useMemo(
    () =>
      STEP_LIST.map((s) => ({
        s,
        ddpm: w1(sampleFamily(s, 1, 1000, seed + 5).z, 1),
        ddim: w1(sampleFamily(s, 0, 1000, seed + 5).z, 1),
      })),
    [seed],
  );
  const again = useMemo(() => sampleFamily(steps, 0, 8, seed).z, [steps, seed]);
  const same = Math.max(...Array.from(again, (v, i) => Math.abs(v - ddim.z[i])));
  const hP = histogram(ddpm.z, -4, 4, 48),
    hI = histogram(ddim.z, -4, 4, 48);
  const lx = curve.map((c) => Math.log10(c.s));
  const yTop = Math.max(1.2, ...curve.map((c) => Math.max(c.ddpm, c.ddim))) * 1.05;
  const trajectories = (f: Frame, paths: number[][], times: number[], colour: string) => {
    drawMarginalHeat(f, FAM);
    for (const p of paths) {
      f.line(p, times, colour, 1.4);
      f.dots([[p[p.length - 1], 0]], colour, 3);
    }
  };

  return (
    <Notebook
      id="18.4"
      title="Families of diffusion models"
      intro={
        <>
          The simple loss only uses q(z<sub>t</sub> | x), so one trained noise predictor fits a whole family of forward
          processes with that kernel. Each family member gives a different reverse rule. DDPM adds fresh noise at every
          step. DDIM adds none, so each starting z<sub>T</sub> maps to one x, and it can skip from step to step on a
          short sub-sequence of the 1,000 times. Both samplers below use the same exact noise predictor.
        </>
      }
      tryThis={[
        'At 5 to 20 steps DDIM lands much closer to Pr(x) than DDPM with the same steps.',
        'Set 1 step: both return E[x | z_T], which is nearly the data mean for every start, so all samples land in one spot.',
        'Read the curve on the right: DDIM is ahead up to about 50 steps; from about 100 steps the two are equally good.',
        'DDIM paths are smooth and straight between steps; DDPM paths jitter because of the added noise.',
      ]}
      takeaway={
        <>
          The network is the expensive part, and the number of steps is the number of network calls. Deterministic
          samplers such as DDIM trade the added noise for speed, which is why they made diffusion practical.
        </>
      }
    >
      <div className="dl-controls">
        <Slider
          label="sampling steps"
          value={steps}
          min={1}
          max={100}
          step={1}
          onChange={setSteps}
          show={(v) => String(v)}
        />
        <button className="btn small" onClick={() => setSeed((s) => s + 1)}>
          New samples
        </button>
      </div>
      <div className="dl-cols">
        <div>
          <Plot
            x={[-4, 4]}
            y={[0, FT]}
            height={230}
            xLabel="z"
            yLabel="t"
            ariaLabel="DDPM sample paths"
            draw={(f) => trajectories(f, ddpm.paths, ddpm.times, f.c.s2)}
          />
          <p className="dl-caption">DDPM (η = 1): eight paths with {steps} steps.</p>
        </div>
        <div>
          <Plot
            x={[-4, 4]}
            y={[0, FT]}
            height={230}
            xLabel="z"
            yLabel="t"
            ariaLabel="DDIM sample paths"
            draw={(f) => trajectories(f, ddim.paths, ddim.times, f.c.s3)}
          />
          <p className="dl-caption">DDIM (η = 0): the same eight starts, deterministic.</p>
        </div>
      </div>
      <div className="dl-cols">
        <div>
          <Plot
            x={[-4, 4]}
            y={[0, 1]}
            height={200}
            xLabel="x"
            ariaLabel="Histograms of the final samples from both samplers"
            draw={(f) => {
              drawHist(f, hP, -4, 4, 1, f.c.s2, 0.35);
              drawHist(f, hI, -4, 4, 1, f.c.s3, 0.35);
              f.line(
                ZS,
                ZS.map((z) => marginal(z, 1)),
                f.c.ink,
                2,
              );
            }}
          />
          <Legend
            items={[
              ['var(--s2)', 'DDPM samples'],
              ['var(--s3)', 'DDIM samples'],
              ['var(--ink)', 'Pr(x)'],
            ]}
          />
        </div>
        <div>
          <Plot
            x={[0, 3]}
            y={[0, yTop]}
            height={200}
            xLabel="log₁₀ steps"
            yLabel="W₁ to Pr(x)"
            ariaLabel="Sample quality against the number of steps for both samplers"
            draw={(f) => {
              f.line(
                lx,
                curve.map((c) => c.ddpm),
                f.c.s2,
                2,
              );
              f.line(
                lx,
                curve.map((c) => c.ddim),
                f.c.s3,
                2,
              );
              f.dots(
                curve.map((c, i) => [lx[i], c.ddpm] as [number, number]),
                f.c.s2,
                2.5,
              );
              f.dots(
                curve.map((c, i) => [lx[i], c.ddim] as [number, number]),
                f.c.s3,
                2.5,
              );
              f.vline(Math.log10(steps), f.c.ink);
            }}
          />
          <p className="dl-caption">
            Lower is better. With 1,000 samples per point the distance cannot fall much below about 0.03: that floor is
            sampling noise.
          </p>
        </div>
      </div>
      <Readout
        items={[
          ['network calls', steps],
          ['W₁ DDPM', fmt(w1(ddpm.z, 1))],
          ['W₁ DDIM', fmt(w1(ddim.z, 1))],
          ['DDIM rerun from the same starts, largest change', fmt(same)],
        ]}
      />
    </Notebook>
  );
}

/* ---------- gridworlds ---------- */

type Kind = '.' | 'S' | 'G' | 'H' | '#' | 'C';

interface World {
  rows: number;
  cols: number;
  kinds: Kind[];
  start: number;
}

function parseWorld(lines: string[]): World {
  const kinds = lines.join('').split('') as Kind[];
  return { rows: lines.length, cols: lines[0].length, kinds, start: kinds.indexOf('S') };
}

const DIRS: [number, number][] = [
  [-1, 0],
  [0, 1],
  [1, 0],
  [0, -1],
];
const ARROWS = ['↑', '→', '↓', '←'];

function moveTo(w: World, s: number, a: number): number {
  const r = Math.floor(s / w.cols) + DIRS[a][0],
    c = (s % w.cols) + DIRS[a][1];
  if (r < 0 || r >= w.rows || c < 0 || c >= w.cols) return s;
  const n = r * w.cols + c;
  return w.kinds[n] === '#' ? s : n;
}

const active = (w: World, s: number) => w.kinds[s] === '.' || w.kinds[s] === 'S';
const cellName = (w: World, s: number) => `(${Math.floor(s / w.cols) + 1},${(s % w.cols) + 1})`;

/** A frozen lake: start top left, fish (+10) bottom right, two holes (−10). Both end the episode. */
const LAKE = parseWorld(['S....', '.#.H.', '.....', '.H..G']);
const LN = LAKE.kinds.length;

interface Mdp {
  w: World;
  slip: number;
  /** P[s][a]: the possible next states and their probabilities. */
  P: [number, number][][][];
  /** The reward for landing on each state. */
  R: number[];
  terminal: boolean[];
}

/** The lake as an MDP: the move goes where intended with probability 1 − slip, else one of the other three ways. */
function lakeMdp(slip: number): Mdp {
  const w = LAKE;
  const R = w.kinds.map((k) => (k === 'G' ? 10 : k === 'H' ? -10 : 0));
  const terminal = w.kinds.map((k) => k === 'G' || k === 'H');
  const P = w.kinds.map((_, s) =>
    DIRS.map((_d, a) => {
      if (!active(w, s)) return [];
      const out = new Map<number, number>();
      for (let d = 0; d < 4; d++) {
        const n = moveTo(w, s, d);
        out.set(n, (out.get(n) ?? 0) + (d === a ? 1 - slip : slip / 3));
      }
      return [...out];
    }),
  );
  return { w, slip, P, R, terminal };
}

/** q[s, a] = Σ Pr(s' | s, a) (r[s'] + γ v[s']), with v = 0 once the episode has ended. */
function qValue(m: Mdp, V: number[], s: number, a: number, gamma: number): number {
  let q = 0;
  for (const [n, p] of m.P[s][a]) q += p * (m.R[n] + (m.terminal[n] ? 0 : gamma * V[n]));
  return q;
}

function greedyPolicy(m: Mdp, V: number[], gamma: number): number[] {
  return V.map((_, s) => {
    if (!active(m.w, s)) return 0;
    let best = 0;
    for (let a = 1; a < 4; a++) if (qValue(m, V, s, a, gamma) > qValue(m, V, s, best, gamma) + 1e-9) best = a;
    return best;
  });
}

/** Policy evaluation: sweep the Bellman equation for v until it stops changing. */
function evaluate(m: Mdp, policy: number[][], gamma: number): number[] {
  let V = Array(LN).fill(0) as number[];
  for (let it = 0; it < 2000; it++) {
    let delta = 0;
    const next = V.map((_, s) => {
      if (!active(m.w, s)) return 0;
      const v = sum(policy[s].map((p, a) => (p ? p * qValue(m, V, s, a, gamma) : 0)));
      delta = Math.max(delta, Math.abs(v - V[s]));
      return v;
    });
    V = next;
    if (delta < 1e-9) break;
  }
  return V;
}

const oneHot = (pi: number[]): number[][] => pi.map((a) => [0, 1, 2, 3].map((b) => (b === a ? 1 : 0)));
const UNIFORM: number[][] = Array.from({ length: LN }, () => [0.25, 0.25, 0.25, 0.25]);

/** A good policy for the lake: the optimal one at slip 0.1 and γ = 0.9, found once by value iteration. */
const GOOD: number[] = (() => {
  const m = lakeMdp(0.1);
  let V = Array(LN).fill(0) as number[];
  for (let it = 0; it < 500; it++)
    V = V.map((_, s) => (active(m.w, s) ? Math.max(...[0, 1, 2, 3].map((a) => qValue(m, V, s, a, 0.9))) : 0));
  return greedyPolicy(m, V, 0.9);
})();

function pick(probs: number[], rand: () => number): number {
  let u = rand();
  for (let a = 0; a < probs.length; a++) if ((u -= probs[a]) < 0) return a;
  return probs.length - 1;
}

interface Episode {
  states: number[];
  actions: number[];
  dirs: number[];
  rewards: number[];
}

function runEpisode(m: Mdp, policy: number[][], rand: () => number, start: number, maxSteps: number): Episode {
  const ep: Episode = { states: [start], actions: [], dirs: [], rewards: [] };
  let s = start;
  for (let k = 0; k < maxSteps && !m.terminal[s]; k++) {
    const a = pick(policy[s], rand);
    const d = rand() < m.slip ? (a + 1 + Math.floor(rand() * 3)) % 4 : a;
    const n = moveTo(m.w, s, d);
    ep.actions.push(a);
    ep.dirs.push(d);
    ep.rewards.push(m.R[n]);
    ep.states.push(n);
    s = n;
  }
  return ep;
}

/** G_t = r_{t+1} + γ G_{t+1} for every step of an episode, worked backwards. */
function returns(rewards: number[], gamma: number): number[] {
  const G = Array(rewards.length).fill(0) as number[];
  let g = 0;
  for (let i = rewards.length - 1; i >= 0; i--) G[i] = g = rewards[i] + gamma * g;
  return G;
}

function shade(v: number, max: number): string {
  if (!Number.isFinite(v) || max <= 0 || Math.abs(v) < 1e-9) return 'var(--surface)';
  const t = Math.min(1, Math.abs(v) / max);
  return `color-mix(in srgb, ${v < 0 ? 'var(--s2)' : 'var(--s1)'} ${Math.round(t * 55)}%, var(--surface))`;
}

const CELL = 50;

interface GridProps {
  w: World;
  values?: number[];
  scale?: number;
  policy?: number[][];
  path?: number[];
  notes?: (string | null)[];
  onCell?: (s: number) => void;
  maxWidth?: number;
  ariaLabel: string;
}

/** A gridworld as SVG: special squares, values as shading and numbers, policy arrows and a path. */
function GridSvg({ w, values, scale = 10, policy, path, notes, onCell, maxWidth = 360, ariaLabel }: GridProps) {
  const W = w.cols * CELL,
    H = w.rows * CELL;
  const centre = (s: number): [number, number] => [
    (s % w.cols) * CELL + CELL / 2,
    Math.floor(s / w.cols) * CELL + CELL / 2,
  ];
  const special: Partial<Record<Kind, [string, string]>> = {
    G: ['color-mix(in srgb, var(--good) 35%, var(--surface))', w === LAKE ? 'fish +10' : 'goal'],
    H: ['color-mix(in srgb, var(--bad) 30%, var(--surface))', 'hole −10'],
    C: ['color-mix(in srgb, var(--bad) 30%, var(--surface))', 'cliff'],
    '#': ['var(--line2)', 'rock'],
  };
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      style={{ width: '100%', maxWidth, display: 'block' }}
      role="img"
      aria-label={ariaLabel}
    >
      {w.kinds.map((k, s) => {
        const [cx, cy] = centre(s);
        const sp = special[k];
        const fill = sp ? sp[0] : values ? shade(values[s], scale) : 'var(--surface)';
        return (
          <g
            key={s}
            onClick={onCell && (() => onCell(s))}
            style={{ cursor: onCell && active(w, s) ? 'pointer' : undefined }}
          >
            <rect
              x={cx - CELL / 2}
              y={cy - CELL / 2}
              width={CELL}
              height={CELL}
              style={{ fill, stroke: 'var(--line)' }}
            />
            {sp && (
              <text x={cx} y={cy + 4} textAnchor="middle" style={{ fill: 'var(--ink2)', fontSize: 10 }}>
                {sp[1]}
              </text>
            )}
            {!sp && values && (
              <text
                x={cx - CELL / 2 + 3}
                y={cy - CELL / 2 + 11}
                style={{ fill: 'var(--ink)', fontSize: 10, fontWeight: 600 }}
              >
                {values[s].toFixed(1)}
              </text>
            )}
            {k === 'S' && (
              <text
                x={cx + CELL / 2 - 3}
                y={cy - CELL / 2 + 11}
                textAnchor="end"
                style={{ fill: 'var(--muted)', fontSize: 9 }}
              >
                start
              </text>
            )}
            {notes?.[s] && (
              <text
                x={cx + CELL / 2 - 3}
                y={cy + CELL / 2 - 4}
                textAnchor="end"
                style={{ fill: 'var(--muted)', fontSize: 9 }}
              >
                {notes[s]}
              </text>
            )}
          </g>
        );
      })}
      {policy &&
        w.kinds.map((_, s) => {
          if (!active(w, s)) return null;
          const [cx, cy0] = centre(s);
          const cy = cy0 + 4;
          return policy[s].map((p, a) => {
            if (p < 0.02) return null;
            const [dy, dx] = DIRS[a];
            const len = 6 + 13 * p;
            const tx = cx + dx * len,
              ty = cy + dy * len;
            const head = `${tx},${ty} ${tx - dx * 5 - dy * 4},${ty - dy * 5 - dx * 4} ${tx - dx * 5 + dy * 4},${ty - dy * 5 + dx * 4}`;
            return (
              <g key={`${s}-${a}`} style={{ pointerEvents: 'none' }}>
                <line
                  x1={cx}
                  y1={cy}
                  x2={tx - dx * 3}
                  y2={ty - dy * 3}
                  style={{ stroke: 'var(--ink)', strokeWidth: 1.6 }}
                />
                <polygon points={head} style={{ fill: 'var(--ink)' }} />
              </g>
            );
          });
        })}
      {path && path.length > 1 && (
        <polyline
          points={path.map((s) => centre(s).join(',')).join(' ')}
          style={{
            fill: 'none',
            stroke: 'var(--brand)',
            strokeWidth: 3,
            strokeOpacity: 0.6,
            strokeLinejoin: 'round',
            pointerEvents: 'none',
          }}
        />
      )}
      {path && path.length > 0 && (
        <circle cx={centre(path[0])[0]} cy={centre(path[0])[1]} r={5} style={{ fill: 'var(--brand)' }} />
      )}
    </svg>
  );
}

/* ---------- 19.1 Markov decision processes ---------- */

type PolicyKind = 'good' | 'random' | 'custom';

function MarkovDecision() {
  const [slip, setSlip] = useState(0.2);
  const [gamma, setGamma] = useState(0.9);
  const [kind, setKind] = useState<PolicyKind>('good');
  const [custom, setCustom] = useState<number[]>(GOOD);
  const [seed, setSeed] = useState(1);
  const [showV, setShowV] = useState(false);
  const m = useMemo(() => lakeMdp(slip), [slip]);
  const policy = useMemo(() => (kind === 'random' ? UNIFORM : oneHot(kind === 'good' ? GOOD : custom)), [kind, custom]);
  const ep = useMemo(() => runEpisode(m, policy, rng(seed), LAKE.start, 60), [m, policy, seed]);
  const G = returns(ep.rewards, gamma);
  const batch = useMemo(() => {
    const rand = rng(seed + 500);
    const eps = Array.from({ length: 500 }, () => runEpisode(m, policy, rand, LAKE.start, 60));
    return {
      ret: mean(eps.map((e) => returns(e.rewards, gamma)[0] ?? 0)),
      fish: mean(eps.map((e) => (LAKE.kinds[e.states[e.states.length - 1]] === 'G' ? 1 : 0))),
    };
  }, [m, policy, gamma, seed]);
  const V = useMemo(() => evaluate(m, policy, gamma), [m, policy, gamma]);

  const rotate = (s: number) => {
    if (!active(LAKE, s)) return;
    const base = kind === 'custom' ? custom : GOOD;
    setCustom(base.map((a, i) => (i === s ? (a + 1) % 4 : a)));
    setKind('custom');
  };

  return (
    <Notebook
      id="19.1"
      title="Markov decision processes"
      intro={
        <>
          An MDP has states, actions, transition probabilities Pr(s<sub>t+1</sub> | s<sub>t</sub>, a<sub>t</sub>) and
          rewards. Here the agent crosses a frozen lake: it chooses a direction, but the ice is slippery, so with the
          slip probability it goes one of the other three ways. Landing on the fish gives +10 and a hole −10, and both
          end the episode. The policy says which action to take in each square. The return G<sub>t</sub> adds up the
          future rewards, each discounted by γ for every step it lies ahead.
        </>
      }
      tryThis={[
        'Press Sample an episode a few times: the same policy gives different paths, because the ice decides where the move goes.',
        'Click squares to turn their arrows and make your own policy. Point one into a hole and watch the average return fall.',
        'Set slip to 0: the good policy always reaches the fish and the return is exactly 10 γ^(steps − 1).',
        'Lower γ: the same episode is worth less, because the reward lies several steps ahead.',
      ]}
      takeaway={
        <>
          The return of one episode is noisy. The quantity we care about is its expected value from each state under the
          policy: the state value, which the next notebooks compute and estimate.
        </>
      }
    >
      <div className="dl-controls">
        <Chips<PolicyKind>
          options={[
            { id: 'good', label: 'Good policy' },
            { id: 'random', label: 'Random policy' },
            { id: 'custom', label: 'Your policy' },
          ]}
          value={kind}
          onChange={setKind}
        />
        <Slider label="slip" value={slip} min={0} max={0.6} step={0.05} onChange={setSlip} />
        <Slider label="γ" value={gamma} min={0.5} max={1} step={0.01} onChange={setGamma} />
        <button className="btn primary small" onClick={() => setSeed((s) => s + 1)}>
          Sample an episode
        </button>
        <label className="small">
          <input type="checkbox" checked={showV} onChange={(e) => setShowV(e.target.checked)} /> Show state values
        </label>
      </div>
      <div className="dl-cols">
        <div>
          <GridSvg
            w={LAKE}
            values={showV ? V : undefined}
            policy={policy}
            path={ep.states}
            onCell={rotate}
            ariaLabel="The frozen lake with the policy and the latest episode"
          />
          <p className="dl-caption">
            Arrows are the policy (four small arrows: random). The purple line is the latest episode. Click a square to
            turn its arrow.
          </p>
        </div>
        <div className="dl-scroll" style={{ maxHeight: 300, overflowY: 'auto' }}>
          <table className="dl-table">
            <thead>
              <tr>
                <th>t</th>
                <th>state</th>
                <th>action</th>
                <th>moved</th>
                <th>reward</th>
                <th>Gₜ</th>
              </tr>
            </thead>
            <tbody>
              {ep.actions.map((a, i) => (
                <tr key={i}>
                  <td>{i + 1}</td>
                  <td className="mono">{cellName(LAKE, ep.states[i])}</td>
                  <td>{ARROWS[a]}</td>
                  <td style={{ color: ep.dirs[i] !== a ? 'var(--bad)' : undefined }}>
                    {ARROWS[ep.dirs[i]]}
                    {ep.dirs[i] !== a ? ' slip' : ''}
                  </td>
                  <td>{ep.rewards[i]}</td>
                  <td>{G[i].toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <Readout
        items={[
          ['steps in this episode', ep.actions.length],
          ['return G₁ of this episode', fmt(G[0] ?? 0)],
          ['average return over 500 episodes', fmt(batch.ret)],
          ['exact expected return from the start', fmt(V[LAKE.start])],
          ['share of episodes reaching the fish', `${Math.round(batch.fish * 100)}%`],
        ]}
      />
    </Notebook>
  );
}

/* ---------- 19.2 Dynamic programming ---------- */

type DpMode = 'value' | 'policy';

interface DpState {
  V: number[];
  pi: number[];
  sweeps: number;
  deltas: number[];
  changed: number;
  improvements: number;
  done: boolean;
}

function DynamicProgramming() {
  const [mode, setMode] = useState<DpMode>('value');
  const [gamma, setGamma] = useState(0.9);
  const [slip, setSlip] = useState(0.2);
  const m = useMemo(() => lakeMdp(slip), [slip]);
  const make = (): DpState => {
    const rand = rng(5);
    return {
      V: Array(LN).fill(0),
      pi: LAKE.kinds.map(() => Math.floor(rand() * 4)),
      sweeps: 0,
      deltas: [],
      changed: 0,
      improvements: 0,
      done: false,
    };
  };
  const improve = (s: DpState) => {
    const next = greedyPolicy(m, s.V, gamma);
    s.changed = next.filter((a, i) => active(LAKE, i) && a !== s.pi[i]).length;
    s.pi = next;
    s.improvements++;
  };
  const step = (s: DpState) => {
    let delta = 0;
    s.V = s.V.map((v, i) => {
      if (!active(LAKE, i)) return 0;
      const nv = qValue(m, s.V, i, s.pi[i], gamma);
      delta = Math.max(delta, Math.abs(nv - v));
      return nv;
    });
    s.sweeps++;
    s.deltas.push(delta);
    if (mode === 'value') {
      improve(s);
      s.done = s.changed === 0 && delta < 1e-4;
    } else if (delta < 1e-3) {
      improve(s);
      s.done = s.changed === 0;
    }
  };
  const r = useRunner(make, step, (s) => s.done || s.sweeps >= 400, [mode, gamma, slip, m], 1, 6);
  const s = r.s;
  const last = s.deltas[s.deltas.length - 1];
  const xs = s.deltas.map((_, i) => i + 1);

  return (
    <Notebook
      id="19.2"
      title="Dynamic programming"
      intro={
        <>
          When the transitions and rewards are known, the values can be computed rather than sampled. Policy evaluation
          sweeps every square, replacing v[s] by the reward plus γ times the value of where the action leads, averaged
          over the slips: the Bellman equation used as an update. Policy improvement then points each arrow at the
          action with the best one-step look-ahead. Value iteration does one sweep between improvements; policy
          iteration evaluates until the values settle first.
        </>
      }
      tryThis={[
        'Press Run in value iteration: values spread out from the fish one square per sweep, and the arrows follow.',
        'Switch to policy iteration: many sweeps per improvement, but only a handful of improvements before the policy stops changing.',
        'Raise the slip to 0.5: the best policy changes. Squares beside a hole point away from it, even if that is the long way round.',
        'Lower γ: values far from the fish shrink, because the reward is many discounted steps away.',
      ]}
      takeaway={
        <>
          Each update bootstraps: it makes a value consistent with its neighbours' current values. Repeating this is a
          contraction, so the values converge, and greedy improvement never makes the policy worse.
        </>
      }
    >
      <div className="dl-controls">
        <Chips<DpMode>
          options={[
            { id: 'value', label: 'Value iteration' },
            { id: 'policy', label: 'Policy iteration' },
          ]}
          value={mode}
          onChange={setMode}
        />
        <Slider label="γ" value={gamma} min={0.5} max={0.99} step={0.01} onChange={setGamma} />
        <Slider label="slip" value={slip} min={0} max={0.6} step={0.05} onChange={setSlip} />
        <RunButtons r={r} />
      </div>
      <div className="dl-cols">
        <div>
          <GridSvg w={LAKE} values={s.V} policy={oneHot(s.pi)} ariaLabel="State values and the current greedy policy" />
          <p className="dl-caption">
            Blue squares have positive value, orange negative. Arrows are the current policy.
          </p>
        </div>
        <div>
          <Plot
            x={[0, Math.max(20, s.sweeps)]}
            y={[-5, 1.5]}
            height={200}
            xLabel="sweep"
            yLabel="log₁₀ largest change"
            ariaLabel="The largest value change in each sweep"
            draw={(f) => {
              f.line(
                xs,
                s.deltas.map((d) => Math.log10(Math.max(d, 1e-6))),
                f.c.s1,
                2,
              );
              f.hline(-4, f.c.muted);
            }}
          />
          <p className="dl-caption">
            How much the values moved in each sweep. The fall is geometric, at about γ per sweep.
          </p>
        </div>
      </div>
      <Readout
        items={[
          ['sweeps', s.sweeps],
          ['policy improvements', s.improvements],
          ['arrows changed at the last improvement', s.changed],
          ['largest change in the last sweep', last === undefined ? '–' : fmt(last)],
          ['value of the start', fmt(s.V[LAKE.start])],
          ['status', s.done ? 'converged' : r.running ? 'running' : 'paused'],
        ]}
      />
    </Notebook>
  );
}

/* ---------- 19.3 Monte Carlo methods ---------- */

type Visit = 'first' | 'every';

interface McState {
  total: number[];
  n: number[];
  episodes: number;
  rms: number[];
  vStart: number[];
  last: number[];
  rand: () => number;
}

const MC_MAX = 3000;
const MC_STARTS = LAKE.kinds.map((_, s) => s).filter((s) => active(LAKE, s));

function MonteCarlo() {
  const [visit, setVisit] = useState<Visit>('first');
  const [kind, setKind] = useState<'good' | 'random'>('good');
  const [slip, setSlip] = useState(0.2);
  const gamma = 0.9;
  const m = useMemo(() => lakeMdp(slip), [slip]);
  const policy = kind === 'good' ? oneHot(GOOD) : UNIFORM;
  const truth = useMemo(() => evaluate(m, kind === 'good' ? oneHot(GOOD) : UNIFORM, gamma), [m, kind]);
  const runs = useRef(0);
  const make = (): McState => ({
    total: Array(LN).fill(0),
    n: Array(LN).fill(0),
    episodes: 0,
    rms: [],
    vStart: [],
    last: [],
    rand: rng(++runs.current * 13),
  });
  const estimate = (s: McState) => s.total.map((t, i) => (s.n[i] ? t / s.n[i] : 0));
  const step = (s: McState) => {
    // Exploring starts: each episode begins in a random square, so every square gets visited.
    const start = MC_STARTS[Math.floor(s.rand() * MC_STARTS.length)];
    const ep = runEpisode(m, policy, s.rand, start, 200);
    const G = returns(ep.rewards, gamma);
    const seen = new Set<number>();
    ep.rewards.forEach((_, i) => {
      const st = ep.states[i];
      if (visit === 'first' && seen.has(st)) return;
      seen.add(st);
      s.total[st] += G[i];
      s.n[st]++;
    });
    s.episodes++;
    s.last = ep.states;
    const est = estimate(s);
    s.rms.push(Math.sqrt(mean(MC_STARTS.map((i) => (est[i] - truth[i]) ** 2))));
    s.vStart.push(est[LAKE.start]);
  };
  const r = useRunner(make, step, (s) => s.episodes >= MC_MAX, [visit, kind, slip, m], 6);
  const s = r.s;
  const est = estimate(s);
  const lx = s.rms.map((_, i) => Math.log10(i + 1));
  const ref = s.rms.length > 10 ? s.rms[9] : null;

  return (
    <Notebook
      id="19.3"
      title="Monte Carlo methods"
      intro={
        <>
          Without the transition probabilities we can still estimate values by playing. Run an episode, work out the
          return that followed each square, and average those returns per square. Every-visit counts a square each time
          it appears; first-visit counts only its first appearance in an episode. The exact values from dynamic
          programming are shown for comparison, but the method never uses them.
        </>
      }
      tryThis={[
        'Press Run: the error falls along the dashed line of slope −½ on the log–log plot, the 1/√N rate of any average.',
        'Watch the start square estimate (right plot) settle onto the exact value, wobbling less as episodes pile up.',
        'Switch to the random policy: the returns vary much more, so the estimates converge more slowly for the same number of episodes.',
        'Compare first-visit and every-visit: both converge; every-visit uses more of each episode.',
      ]}
      takeaway={
        <>
          Monte Carlo needs no model, only episodes, and its estimates are unbiased averages of real returns. The price
          is variance and waiting: nothing can be learned until an episode ends.
        </>
      }
    >
      <div className="dl-controls">
        <Chips<'good' | 'random'>
          options={[
            { id: 'good', label: 'Good policy' },
            { id: 'random', label: 'Random policy' },
          ]}
          value={kind}
          onChange={setKind}
        />
        <Chips<Visit>
          options={[
            { id: 'first', label: 'First visit' },
            { id: 'every', label: 'Every visit' },
          ]}
          value={visit}
          onChange={setVisit}
        />
        <Slider label="slip" value={slip} min={0} max={0.6} step={0.05} onChange={setSlip} />
        <RunButtons r={r} />
        <button className="btn small" onClick={() => r.stepOnce(100)} disabled={r.running}>
          +100 episodes
        </button>
      </div>
      <div className="dl-cols">
        <div>
          <GridSvg
            w={LAKE}
            values={est}
            path={s.last}
            notes={s.n.map((c, i) => (active(LAKE, i) ? `n=${c}` : null))}
            ariaLabel="Monte Carlo value estimates with visit counts"
          />
          <p className="dl-caption">
            Estimates after {s.episodes} episodes, with the number of returns averaged in each square.
          </p>
        </div>
        <div>
          <Plot
            x={[0, Math.log10(MC_MAX)]}
            y={[-2, 1]}
            height={200}
            xLabel="log₁₀ episodes"
            yLabel="log₁₀ RMS error"
            ariaLabel="Root mean square error of the estimates against the number of episodes"
            draw={(f) => {
              f.line(
                lx,
                s.rms.map((v) => Math.log10(Math.max(v, 1e-3))),
                f.c.s1,
                2,
              );
              if (ref)
                f.line(
                  [1, Math.log10(MC_MAX)],
                  [Math.log10(ref), Math.log10(ref) - 0.5 * (Math.log10(MC_MAX) - 1)],
                  f.c.muted,
                  1.5,
                  [5, 4],
                );
            }}
          />
        </div>
        <div>
          <Plot
            x={[0, Math.max(100, s.episodes)]}
            y={[-10, 10]}
            height={200}
            xLabel="episodes"
            yLabel="v[start]"
            ariaLabel="Estimate of the value of the start square against episodes"
            draw={(f) => {
              f.hline(truth[LAKE.start], f.c.ink, [5, 4]);
              f.line(
                s.vStart.map((_, i) => i + 1),
                s.vStart,
                f.c.s2,
                2,
              );
            }}
          />
        </div>
      </div>
      <Readout
        items={[
          ['episodes', s.episodes],
          ['RMS error over squares', s.rms.length ? fmt(s.rms[s.rms.length - 1]) : '–'],
          ['estimate at the start', fmt(est[LAKE.start])],
          ['exact value at the start', fmt(truth[LAKE.start])],
        ]}
      />
    </Notebook>
  );
}

/* ---------- 19.4 Temporal difference methods ---------- */

/** The cliff walk: −1 per step, and stepping onto the cliff costs −100 and sends you back to the start. */
const CLIFF = parseWorld(['............', '............', '............', 'SCCCCCCCCCCG']);
const CN = CLIFF.kinds.length;

function cliffStep(s: number, a: number): { next: number; r: number; done: boolean } {
  const n = moveTo(CLIFF, s, a);
  if (CLIFF.kinds[n] === 'C') return { next: CLIFF.start, r: -100, done: false };
  return { next: n, r: -1, done: CLIFF.kinds[n] === 'G' };
}

/** The action with the largest value; ties are broken at random when a generator is given. */
function argmaxQ(Q: Float64Array, s: number, rand?: () => number): number {
  let best = -Infinity,
    choice = 0,
    ties = 0;
  for (let a = 0; a < 4; a++) {
    const v = Q[s * 4 + a];
    if (v > best + 1e-12) [best, choice, ties] = [v, a, 1];
    else if (Math.abs(v - best) <= 1e-12 && rand && rand() < 1 / ++ties) choice = a;
  }
  return choice;
}

interface Agent {
  Q: Float64Array;
  rewards: number[];
  rand: () => number;
}

interface TdState {
  sarsa: Agent;
  qlearn: Agent;
  episodes: number;
}

const TD_MAX = 500;

function greedyPath(Q: Float64Array): number[] {
  const path = [CLIFF.start];
  let s = CLIFF.start;
  for (let k = 0; k < 40; k++) {
    const n = moveTo(CLIFF, s, argmaxQ(Q, s));
    path.push(n);
    if (CLIFF.kinds[n] !== '.' || path.indexOf(n) < path.length - 1) break;
    s = n;
  }
  return path;
}

const movingAverage = (xs: number[], k: number) => xs.map((_, i) => mean(xs.slice(Math.max(0, i - k + 1), i + 1)));

function TemporalDifference() {
  const [eps, setEps] = useState(0.1);
  const [lr, setLr] = useState(0.5);
  const runs = useRef(0);
  const agent = (seed: number): Agent => ({ Q: new Float64Array(CN * 4), rewards: [], rand: rng(seed) });
  const make = (): TdState => {
    const k = ++runs.current;
    return { sarsa: agent(k * 7 + 1), qlearn: agent(k * 7 + 2), episodes: 0 };
  };
  const choose = (ag: Agent, s: number) => (ag.rand() < eps ? Math.floor(ag.rand() * 4) : argmaxQ(ag.Q, s, ag.rand));
  const runSarsa = (ag: Agent) => {
    let s = CLIFF.start,
      a = choose(ag, s),
      total = 0;
    for (let k = 0; k < 2000; k++) {
      const { next, r, done } = cliffStep(s, a);
      total += r;
      if (done) {
        ag.Q[s * 4 + a] += lr * (r - ag.Q[s * 4 + a]);
        break;
      }
      const a2 = choose(ag, next);
      // SARSA: the target uses the action the agent will actually take next.
      ag.Q[s * 4 + a] += lr * (r + ag.Q[next * 4 + a2] - ag.Q[s * 4 + a]);
      [s, a] = [next, a2];
    }
    ag.rewards.push(total);
  };
  const runQ = (ag: Agent) => {
    let s = CLIFF.start,
      total = 0;
    for (let k = 0; k < 2000; k++) {
      const a = choose(ag, s);
      const { next, r, done } = cliffStep(s, a);
      total += r;
      // Q-learning: the target uses the best next action, whatever the agent then does.
      const target = done ? r : r + ag.Q[next * 4 + argmaxQ(ag.Q, next)];
      ag.Q[s * 4 + a] += lr * (target - ag.Q[s * 4 + a]);
      s = next;
      if (done) break;
    }
    ag.rewards.push(total);
  };
  const step = (s: TdState) => {
    runSarsa(s.sarsa);
    runQ(s.qlearn);
    s.episodes++;
  };
  const r = useRunner(make, step, (s) => s.episodes >= TD_MAX, [eps, lr], 3);
  const s = r.s;
  const policyOf = (Q: Float64Array) =>
    CLIFF.kinds.map((_, i) => [0, 1, 2, 3].map((a) => (a === argmaxQ(Q, i) ? 1 : 0)));
  const pS = greedyPath(s.sarsa.Q),
    pQ = greedyPath(s.qlearn.Q);
  const avgS = movingAverage(s.sarsa.rewards, 20),
    avgQ = movingAverage(s.qlearn.rewards, 20);
  const xs = avgS.map((_, i) => i + 1);
  const recent = (xs: number[]) => (xs.length ? fmt(mean(xs.slice(-50))) : '–');
  const edge = (p: number[]) => p.filter((c) => Math.floor(c / CLIFF.cols) === 2).length;

  return (
    <Notebook
      id="19.4"
      title="Temporal difference methods"
      intro={
        <>
          TD methods update after every step instead of waiting for the episode to end. They move q[s<sub>t</sub>, a
          <sub>t</sub>] towards the reward plus the value of the next step: sampling like Monte Carlo, bootstrapping
          like dynamic programming. SARSA uses the next action it actually takes (on-policy). Q-learning uses the best
          next action (off-policy). Both explore with an ε-greedy policy on a cliff walk, where every step costs −1 and
          the cliff costs −100.
        </>
      }
      tryThis={[
        "Press Run. Q-learning's greedy path hugs the cliff edge, the shortest route; SARSA learns a path one or two rows up.",
        "Look at the reward per episode: SARSA earns more while learning, because Q-learning's random ε moves sometimes push it off the edge.",
        "Set ε to 0.01 and reset: exploration is rarely costly, and SARSA's path moves towards the edge as well.",
        'Raise the learning rate: learning is faster at first but noisier.',
      ]}
      takeaway={
        <>
          The two differ in one term, yet learn different things. Q-learning learns the values of the best policy
          regardless of how it behaves; SARSA learns the values of what it actually does, exploration included, and so
          plays safe.
        </>
      }
    >
      <div className="dl-controls">
        <Slider label="ε (exploration)" value={eps} min={0.01} max={0.3} step={0.01} onChange={setEps} />
        <Slider label="learning rate α" value={lr} min={0.05} max={1} step={0.05} onChange={setLr} />
        <RunButtons r={r} />
      </div>
      <div className="dl-cols">
        <div>
          <div className="small" style={{ fontWeight: 600, marginBottom: 4 }}>
            SARSA
          </div>
          <GridSvg
            w={CLIFF}
            policy={policyOf(s.sarsa.Q)}
            path={pS}
            maxWidth={560}
            ariaLabel="SARSA greedy policy and path"
          />
        </div>
        <div>
          <div className="small" style={{ fontWeight: 600, marginBottom: 4 }}>
            Q-learning
          </div>
          <GridSvg
            w={CLIFF}
            policy={policyOf(s.qlearn.Q)}
            path={pQ}
            maxWidth={560}
            ariaLabel="Q-learning greedy policy and path"
          />
        </div>
      </div>
      <p className="dl-caption">
        Arrows are the greedy action in each square; the purple line follows them from the start. γ = 1.
      </p>
      <Plot
        x={[0, TD_MAX]}
        y={[-100, 0]}
        height={200}
        xLabel="episode"
        yLabel="reward per episode (20-episode average)"
        ariaLabel="Reward per episode for SARSA and Q-learning"
        draw={(f) => {
          f.line(xs, avgS, f.c.s1, 2);
          f.line(xs, avgQ, f.c.s2, 2);
        }}
      />
      <Legend
        items={[
          ['var(--s1)', 'SARSA'],
          ['var(--s2)', 'Q-learning'],
        ]}
      />
      <Readout
        items={[
          ['episodes', s.episodes],
          ['SARSA reward, last 50 episodes', recent(s.sarsa.rewards)],
          ['Q-learning reward, last 50 episodes', recent(s.qlearn.rewards)],
          ['greedy path length, SARSA / Q-learning', `${pS.length - 1} / ${pQ.length - 1}`],
          ['path squares next to the cliff, SARSA / Q-learning', `${edge(pS)} / ${edge(pQ)}`],
        ]}
      />
    </Notebook>
  );
}

/* ---------- 19.5 Control variates ---------- */

type Baseline = 'group' | 'loo' | 'value';

const THETA = [0.6, 0, -0.4, 0.2];
const PI = softmax(THETA);
const MEANS = [1, 2, 0.5, 1.5];
const V_PI = sum(PI.map((p, a) => p * MEANS[a]));
const TRUE_G = PI[0] * (MEANS[0] - V_PI);
const REPS = 2000;

function variance(xs: Float64Array): number {
  const m = mean(Array.from(xs));
  return mean(Array.from(xs, (v) => (v - m) ** 2));
}

function ControlVariates() {
  const [rho, setRho] = useState(0.8);
  const [c, setC] = useState(1);
  const [offset, setOffset] = useState(5);
  const [group, setGroup] = useState(8);
  const [noise, setNoise] = useState(0.5);
  const [base, setBase] = useState<Baseline>('loo');
  const [seed, setSeed] = useState(1);

  const cv = useMemo(() => {
    const rand = rng(seed);
    const plain = new Float64Array(REPS),
      adjusted = new Float64Array(REPS);
    for (let rep = 0; rep < REPS; rep++) {
      let sa = 0,
        sd = 0;
      for (let i = 0; i < 10; i++) {
        const z1 = gauss(rand),
          z2 = gauss(rand);
        const a = 1 + z1,
          b = rho * z1 + Math.sqrt(1 - rho * rho) * z2;
        sa += a;
        sd += a - c * b;
      }
      plain[rep] = sa / 10;
      adjusted[rep] = sd / 10;
    }
    return { plain, adjusted };
  }, [rho, c, seed]);

  const pg = useMemo(() => {
    const rand = rng(seed + 99);
    const out: Record<'none' | Baseline, Float64Array> = {
      none: new Float64Array(REPS),
      group: new Float64Array(REPS),
      loo: new Float64Array(REPS),
      value: new Float64Array(REPS),
    };
    const sc = new Float64Array(group),
      rw = new Float64Array(group);
    for (let rep = 0; rep < REPS; rep++) {
      let total = 0;
      for (let i = 0; i < group; i++) {
        const a = pick(PI, rand);
        // d log π(a) / d θ₀ for a softmax policy is 1[a = 0] − π₀.
        sc[i] = (a === 0 ? 1 : 0) - PI[0];
        rw[i] = MEANS[a] + offset + noise * gauss(rand);
        total += rw[i];
      }
      const gm = total / group;
      let n0 = 0,
        g0 = 0,
        l0 = 0,
        v0 = 0;
      for (let i = 0; i < group; i++) {
        n0 += sc[i] * rw[i];
        g0 += sc[i] * (rw[i] - gm);
        l0 += sc[i] * (rw[i] - (total - rw[i]) / (group - 1));
        v0 += sc[i] * (rw[i] - V_PI - offset);
      }
      out.none[rep] = n0 / group;
      out.group[rep] = g0 / group;
      out.loo[rep] = l0 / group;
      out.value[rep] = v0 / group;
    }
    return out;
  }, [offset, group, noise, seed]);

  const sdNone = Math.sqrt(variance(pg.none)),
    sdBase = Math.sqrt(variance(pg[base]));
  const half = 4 * Math.max(sdNone, sdBase, 1e-3);
  const [lo, hi] = [TRUE_G - half, TRUE_G + half];
  const hNone = histogram(pg.none, lo, hi, 50),
    hBase = histogram(pg[base], lo, hi, 50);
  const top = 1.1 * Math.max(...hNone, ...hBase);
  const cA = histogram(cv.plain, -0.4, 2.4, 50),
    cB = histogram(cv.adjusted, -0.4, 2.4, 50);
  const cTop = 1.1 * Math.max(...cA, ...cB);
  const rows: [string, 'none' | Baseline][] = [
    ['no baseline', 'none'],
    ['group mean (GRPO style)', 'group'],
    ['mean of the others (leave one out)', 'loo'],
    ['true value v (oracle)', 'value'],
  ];

  return (
    <Notebook
      id="19.5"
      title="Control variates"
      intro={
        <>
          To estimate E[a] from a few samples, subtract a variable b that moves with a and has E[b] = 0. The average of
          a − c b has the same expectation but a smaller variance, 1 + c² − 2cρ times that of a here, smallest at c = ρ.
          Policy gradients use the same trick. REINFORCE estimates the gradient as the average of ∂log π[a]/∂θ times the
          reward. Subtracting a baseline that does not depend on the action leaves the expectation alone, because the
          score ∂log π[a]/∂θ has mean zero, but can remove most of the variance.
        </>
      }
      tryThis={[
        'Top: set ρ to 0 and the subtraction only adds noise; set ρ near 1 and the adjusted histogram becomes very narrow. Press Best c.',
        'Bottom: raise the reward offset. Without a baseline the spread grows with it, although the true gradient does not change.',
        'With a baseline the offset cancels. The group mean, as in GRPO, shrinks the mean by (G − 1)/G because it includes the sample itself; the leave-one-out mean does not.',
        'Reduce the group size to 2: every estimate gets noisier, but the baselines still help.',
      ]}
      takeaway={
        <>
          A baseline is a control variate: same expected gradient, less noise, so fewer episodes are needed. GRPO, used
          to train reasoning models, samples a group of answers to each prompt and subtracts the group's mean reward (it
          also divides by the group's spread), which removes the need for a learned value network.
        </>
      }
    >
      <div className="dl-controls">
        <Slider label="correlation ρ of a and b" value={rho} min={0} max={0.99} step={0.01} onChange={setRho} />
        <Slider label="coefficient c" value={c} min={0} max={2} step={0.01} onChange={setC} />
        <button className="btn small" onClick={() => setC(rho)}>
          Best c
        </button>
      </div>
      <div className="dl-cols">
        <div>
          <Plot
            x={[-0.4, 2.4]}
            y={[0, cTop]}
            height={180}
            xLabel="estimate of E[a] (true value 1) from 10 samples"
            ariaLabel="Histograms of the plain and the adjusted estimate of E[a]"
            draw={(f) => {
              drawHist(f, cA, -0.4, 2.4, cTop, f.c.s2, 0.4);
              drawHist(f, cB, -0.4, 2.4, cTop, f.c.s1, 0.4);
              f.vline(1, f.c.ink);
            }}
          />
          <Legend
            items={[
              ['var(--s2)', 'mean of a'],
              ['var(--s1)', 'mean of a − c b'],
            ]}
          />
        </div>
        <Readout
          items={[
            ['variance of mean of a', fmt(variance(cv.plain))],
            ['variance with control variate', fmt(variance(cv.adjusted))],
            ['predicted ratio 1 + c² − 2cρ', fmt(1 + c * c - 2 * c * rho)],
            ['measured ratio', fmt(variance(cv.adjusted) / variance(cv.plain))],
          ]}
        />
      </div>
      <div className="dl-controls">
        <Slider label="reward offset" value={offset} min={0} max={20} step={0.5} onChange={setOffset} />
        <Slider
          label="group size G"
          value={group}
          min={2}
          max={32}
          step={1}
          onChange={setGroup}
          show={(v) => String(v)}
        />
        <Slider label="reward noise" value={noise} min={0} max={2} step={0.05} onChange={setNoise} />
        <Chips<Baseline>
          options={[
            { id: 'group', label: 'Group mean' },
            { id: 'loo', label: 'Leave one out' },
            { id: 'value', label: 'True value' },
          ]}
          value={base}
          onChange={setBase}
        />
        <button className="btn small" onClick={() => setSeed((s) => s + 1)}>
          Resample
        </button>
      </div>
      <div className="dl-cols">
        <div>
          <Plot
            x={[lo, hi]}
            y={[0, top]}
            height={200}
            xLabel="estimate of ∂J/∂θ₀"
            ariaLabel="Histograms of the policy gradient estimate with and without a baseline"
            draw={(f) => {
              drawHist(f, hNone, lo, hi, top, f.c.s2, 0.4);
              drawHist(f, hBase, lo, hi, top, f.c.s1, 0.4);
              f.vline(TRUE_G, f.c.ink, []);
            }}
          />
          <Legend
            items={[
              ['var(--s2)', 'no baseline'],
              ['var(--s1)', rows.find((row) => row[1] === base)?.[0] ?? ''],
              ['var(--ink)', 'true gradient'],
            ]}
          />
          <p className="dl-caption">
            A one-step task with four actions and a softmax policy. Each estimate averages G sampled actions; the
            histograms show {REPS.toLocaleString()} estimates.
          </p>
        </div>
        <div className="dl-scroll">
          <table className="dl-table">
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>baseline</th>
                <th>mean</th>
                <th>spread</th>
                <th>variance vs none</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(([label, id]) => (
                <tr
                  key={id}
                  style={{ background: id === base ? 'color-mix(in srgb, var(--brand) 14%, transparent)' : undefined }}
                >
                  <th style={{ textAlign: 'left' }}>{label}</th>
                  <td>{mean(Array.from(pg[id])).toFixed(4)}</td>
                  <td>{Math.sqrt(variance(pg[id])).toFixed(4)}</td>
                  <td>{(variance(pg[id]) / variance(pg.none)).toFixed(3)}</td>
                </tr>
              ))}
              <tr>
                <th style={{ textAlign: 'left' }}>true gradient</th>
                <td>{TRUE_G.toFixed(4)}</td>
                <td colSpan={2} className="muted">
                  group mean expects {(((group - 1) / group) * TRUE_G).toFixed(4)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </Notebook>
  );
}

export const CHAPTERS: ChapterDef[] = [
  {
    n: 18,
    title: 'Diffusion models',
    blurb:
      'A fixed encoder turns data into noise step by step; a learned decoder runs the steps backwards to make new data.',
    notebooks: [
      { id: '18.1', title: 'Diffusion encoder', Component: DiffusionEncoder },
      { id: '18.2', title: '1D diffusion model', Component: DiffusionModel },
      { id: '18.3', title: 'Reparameterised model', Component: Reparameterised },
      { id: '18.4', title: 'Families of diffusion models', Component: Families },
    ],
  },
  {
    n: 19,
    title: 'Reinforcement learning',
    blurb: 'An agent acts, the world responds with rewards, and the agent learns which actions lead to large returns.',
    notebooks: [
      { id: '19.1', title: 'Markov decision processes', Component: MarkovDecision },
      { id: '19.2', title: 'Dynamic programming', Component: DynamicProgramming },
      { id: '19.3', title: 'Monte Carlo methods', Component: MonteCarlo },
      { id: '19.4', title: 'Temporal difference methods', Component: TemporalDifference },
      { id: '19.5', title: 'Control variates', Component: ControlVariates },
    ],
  },
];
