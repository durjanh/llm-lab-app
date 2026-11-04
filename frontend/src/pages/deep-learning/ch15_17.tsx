/* Chapters 15 to 17: generative adversarial networks, normalising flows and variational autoencoders. */
import { useMemo, useRef, useState } from 'react';
import type { ChapterDef } from './chapters';
import { clamp, fmt, gauss, linspace, mean, rng, sigmoid, sum, useAnimation } from './kit';
import { Chips, Notebook, Readout, Slider } from './Notebook';
import { mix, Plot, type Colours, type Frame } from './Plot';

// ---------- shared helpers ----------

const SQRT_2PI = Math.sqrt(2 * Math.PI);

/** The normal density Norm_x[μ, σ²], written with the standard deviation σ. */
const normPdf = (x: number, mu = 0, sd = 1) => Math.exp(-0.5 * ((x - mu) / sd) ** 2) / (sd * SQRT_2PI);

/** log sig[l], worked out without overflow when |l| is large. */
const logSig = (l: number) => (l >= 0 ? -Math.log1p(Math.exp(-l)) : l - Math.log1p(Math.exp(l)));

/** A number for a readout, with ∞ for infinite values. */
const show = (v: number, digits = 3) => (v === Infinity ? '∞' : fmt(v, digits));

function std(xs: number[]): number {
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((v) => (v - m) ** 2)));
}

function Legend({ items }: { items: [keyof Colours, string][] }) {
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

/** Draws see-through bars over equal bins from x0 to x1, so lines drawn behind them stay visible. */
function bars(f: Frame, x0: number, x1: number, heights: number[], colour: string, alpha = 0.45) {
  const w = (x1 - x0) / heights.length;
  f.ctx.save();
  f.ctx.globalAlpha = alpha;
  f.ctx.fillStyle = colour;
  heights.forEach((v, i) => {
    if (!(v > 0)) return;
    const left = f.x(x0 + i * w);
    const right = f.x(x0 + (i + 1) * w);
    const top = Math.max(10, f.y(v)); // 10px is the plot's top edge
    const base = f.y(0);
    f.ctx.fillRect(left + 0.5, top, Math.max(1, right - left - 1), base - top);
  });
  f.ctx.restore();
}

/** Histogram heights scaled as a density, so the bars' area matches a probability density drawn on the same axes. */
function densityHistogram(values: ArrayLike<number>, x0: number, x1: number, bins: number): number[] {
  const counts = new Array<number>(bins).fill(0);
  for (let i = 0; i < values.length; i++) {
    const k = Math.floor(((values[i] - x0) / (x1 - x0)) * bins);
    if (k >= 0 && k < bins) counts[k]++;
  }
  const width = (x1 - x0) / bins;
  return counts.map((c) => c / (values.length * width));
}

/** Histogram heights as the fraction of values in each bin. */
function fractionHistogram(values: number[], x0: number, x1: number, bins: number): number[] {
  const counts = new Array<number>(bins).fill(0);
  for (const v of values) {
    const k = Math.floor(((v - x0) / (x1 - x0)) * bins);
    if (k >= 0 && k < bins) counts[k]++;
  }
  return counts.map((c) => c / values.length);
}

/** Colours a heat-map cell: the surface colour for 0, the series colour for 1. */
const shade = (f: Frame, colour: string, t: number) => mix(f.c.surface, colour, clamp(t, 0, 1));

// ---------- 15.1 GAN toy example ----------

const GAN_H = 12;
const GAN_BATCH = 64;
const GAN_MAX_STEPS = 6000;
const GAN_X: [number, number] = [-5, 5];

/**
 * A network with one input, one hidden layer of tanh units and one output. Its parameters sit in one flat array:
 * input weights, hidden biases, output weights, then the output bias. h receives the hidden activations.
 */
function mlp(p: Float64Array, x: number, h: Float64Array): number {
  let out = p[3 * GAN_H];
  for (let k = 0; k < GAN_H; k++) {
    h[k] = Math.tanh(p[k] * x + p[GAN_H + k]);
    out += p[2 * GAN_H + k] * h[k];
  }
  return out;
}

/** Backpropagates dOut through the network: adds the parameter gradients to grad (if given) and returns ∂out/∂x. */
function mlpBackward(p: Float64Array, x: number, h: Float64Array, dOut: number, grad: Float64Array | null): number {
  let dx = 0;
  if (grad) grad[3 * GAN_H] += dOut;
  for (let k = 0; k < GAN_H; k++) {
    const dPre = dOut * p[2 * GAN_H + k] * (1 - h[k] * h[k]);
    if (grad) {
      grad[2 * GAN_H + k] += dOut * h[k];
      grad[k] += dPre * x;
      grad[GAN_H + k] += dPre;
    }
    dx += dPre * p[k];
  }
  return dx;
}

interface AdamState {
  m: Float64Array;
  v: Float64Array;
  t: number;
}
const adamState = (n: number): AdamState => ({ m: new Float64Array(n), v: new Float64Array(n), t: 0 });

/** One Adam step, with the low momentum (β₁ = 0.5) that GANs are usually trained with. */
function adamStep(p: Float64Array, g: Float64Array, s: AdamState, lr: number) {
  const b1 = 0.5,
    b2 = 0.999;
  s.t++;
  const c1 = 1 - b1 ** s.t,
    c2 = 1 - b2 ** s.t;
  for (let i = 0; i < p.length; i++) {
    s.m[i] = b1 * s.m[i] + (1 - b1) * g[i];
    s.v[i] = b2 * s.v[i] + (1 - b2) * g[i] * g[i];
    p[i] -= (lr * s.m[i]) / c1 / (Math.sqrt(s.v[i] / c2) + 1e-8);
  }
}

type GanTarget = 'one' | 'two' | 'three';
const GAN_TARGETS: Record<GanTarget, { label: string; modes: number[]; sd: number }> = {
  one: { label: 'One bump', modes: [1.5], sd: 0.6 },
  two: { label: 'Two modes', modes: [-2, 2], sd: 0.45 },
  three: { label: 'Three modes', modes: [-2.5, 0, 2.5], sd: 0.35 },
};

function realSample(t: GanTarget, r: () => number): number {
  const { modes, sd } = GAN_TARGETS[t];
  return modes[Math.floor(r() * modes.length)] + sd * gauss(r);
}

const realDensity = (t: GanTarget, x: number) =>
  mean(GAN_TARGETS[t].modes.map((m) => normPdf(x, m, GAN_TARGETS[t].sd)));

/** Fixed latent values, so the histogram of generated samples changes only because the generator does. */
const GAN_Z = (() => {
  const r = rng(5);
  return Array.from({ length: 2000 }, () => gauss(r));
})();

/** A fixed, sorted sample of real data for each target, to measure how far the generator still is. */
const GAN_REAL: Record<GanTarget, number[]> = (() => {
  const out = {} as Record<GanTarget, number[]>;
  for (const t of Object.keys(GAN_TARGETS) as GanTarget[]) {
    const r = rng(6);
    out[t] = Array.from({ length: GAN_Z.length }, () => realSample(t, r)).sort((a, b) => a - b);
  }
  return out;
})();

interface Gan {
  gen: Float64Array;
  disc: Float64Array;
  ga: AdamState;
  da: AdamState;
  r: () => number;
  step: number;
  dLoss: number;
  gLoss: number;
  dist: [number, number][];
}

function generated(s: Gan): number[] {
  const h = new Float64Array(GAN_H);
  return GAN_Z.map((z) => mlp(s.gen, z, h));
}

/** The Wasserstein distance between generated and real samples in 1D: the mean gap between matching sorted values. */
function ganDistance(xs: number[], t: GanTarget): number {
  const a = [...xs].sort((p, q) => p - q);
  const b = GAN_REAL[t];
  let total = 0;
  for (let i = 0; i < a.length; i++) total += Math.abs(a[i] - b[i]);
  return total / a.length;
}

function makeGan(seed: number, t: GanTarget): Gan {
  const r = rng(seed);
  const n = 3 * GAN_H + 1;
  const gen = new Float64Array(n),
    disc = new Float64Array(n);
  for (let k = 0; k < GAN_H; k++) {
    gen[k] = gauss(r);
    gen[GAN_H + k] = gauss(r);
    gen[2 * GAN_H + k] = 0.3 * gauss(r);
    disc[k] = 2 * gauss(r);
    disc[GAN_H + k] = 2 * gauss(r);
    disc[2 * GAN_H + k] = 0.3 * gauss(r);
  }
  gen[3 * GAN_H] = -2; // start the samples away from the real data
  const s: Gan = { gen, disc, ga: adamState(n), da: adamState(n), r, step: 0, dLoss: NaN, gLoss: NaN, dist: [] };
  s.dist.push([0, ganDistance(generated(s), t)]);
  return s;
}

/**
 * One round of training: dSteps updates of the discriminator on fresh batches of real and generated data, then one
 * update of the generator. The discriminator minimises the binary cross-entropy with real = 1 and generated = 0.
 * The generator either minimises log(1 − sig[f]) as in the book, or the non-saturating −log sig[f].
 */
function ganStep(s: Gan, t: GanTarget, lr: number, dSteps: number, nonSaturating: boolean) {
  const h = new Float64Array(GAN_H),
    hg = new Float64Array(GAN_H);
  const gD = new Float64Array(s.disc.length),
    gG = new Float64Array(s.gen.length);
  let dLoss = 0;
  for (let k = 0; k < dSteps; k++) {
    gD.fill(0);
    dLoss = 0;
    for (let i = 0; i < GAN_BATCH; i++) {
      const x = realSample(t, s.r);
      const l = mlp(s.disc, x, h);
      dLoss -= logSig(l);
      mlpBackward(s.disc, x, h, (sigmoid(l) - 1) / GAN_BATCH, gD);
      const xf = mlp(s.gen, gauss(s.r), hg);
      const lf = mlp(s.disc, xf, h);
      dLoss -= logSig(-lf); // log(1 − sig[l]) = log sig[−l]
      mlpBackward(s.disc, xf, h, sigmoid(lf) / GAN_BATCH, gD);
    }
    adamStep(s.disc, gD, s.da, lr);
  }
  gG.fill(0);
  let gLoss = 0;
  for (let i = 0; i < GAN_BATCH; i++) {
    const z = gauss(s.r);
    const x = mlp(s.gen, z, hg);
    const l = mlp(s.disc, x, h);
    const d = sigmoid(l);
    gLoss += nonSaturating ? -logSig(l) : logSig(-l);
    const dl = (nonSaturating ? d - 1 : -d) / GAN_BATCH;
    const dx = mlpBackward(s.disc, x, h, dl, null);
    mlpBackward(s.gen, z, hg, dx, gG);
  }
  adamStep(s.gen, gG, s.ga, lr);
  s.dLoss = dLoss / GAN_BATCH;
  s.gLoss = gLoss / GAN_BATCH;
  s.step++;
}

function GanToy() {
  const [target, setTarget] = useState<GanTarget>('two');
  const [lrLog, setLrLog] = useState(Math.log10(0.003));
  const [dSteps, setDSteps] = useState(3);
  const [loss, setLoss] = useState<'book' | 'nonsat'>('nonsat');
  const [seed, setSeed] = useState(1);
  const [running, setRunning] = useState(false);
  const [, render] = useState(0);
  const state = useRef<Gan | null>(null);
  if (state.current === null) state.current = makeGan(seed, target);
  const s = state.current;
  const lr = 10 ** lrLog;

  const train = (steps: number) => {
    const g = state.current as Gan;
    for (let i = 0; i < steps && g.step < GAN_MAX_STEPS; i++) ganStep(g, target, lr, dSteps, loss === 'nonsat');
    g.dist.push([g.step, ganDistance(generated(g), target)]);
    render((n) => n + 1);
  };
  useAnimation(running, () => {
    if ((state.current as Gan).step >= GAN_MAX_STEPS) {
      setRunning(false);
      return false;
    }
    train(5);
  });
  const restart = (nextSeed: number, nextTarget: GanTarget) => {
    setRunning(false);
    state.current = makeGan(nextSeed, nextTarget);
    render((n) => n + 1);
  };

  const h = new Float64Array(GAN_H);
  const xs = generated(s);
  const hist = densityHistogram(xs, GAN_X[0], GAN_X[1], 60);
  const grid = linspace(GAN_X[0], GAN_X[1], 201);
  const dCurve = grid.map((x) => sigmoid(mlp(s.disc, x, h)));
  const real = grid.map((x) => realDensity(target, x));
  const zs = linspace(-3, 3, 121);
  const gCurve = zs.map((z) => mlp(s.gen, z, h));
  const dFake = mean(xs.map((x) => sigmoid(mlp(s.disc, x, h))));
  const dReal = mean(GAN_REAL[target].map((x) => sigmoid(mlp(s.disc, x, h))));
  const dist = s.dist[s.dist.length - 1][1];
  const distMax = Math.max(0.5, ...s.dist.map((d) => d[1])) * 1.05;

  return (
    <Notebook
      id="15.1"
      title="GAN toy example"
      intro={
        <>
          A generator x* = g[z, θ] turns standard normal noise z into samples. A discriminator sig[f[x, ϕ]] gives the
          probability that x is real. Both are small networks with one hidden layer of twelve tanh units. Training
          alternates: the discriminator learns to tell real from generated, then the generator moves its samples to
          where the discriminator says &quot;real&quot;. Nothing tells the generator what the real density is; it only
          sees the discriminator&apos;s gradient.
        </>
      }
      tryThis={[
        'Press Run with the defaults. The orange histogram drifts onto the blue density and the green curve flattens towards 0.5: the discriminator can no longer tell the two apart.',
        'Choose One bump, one discriminator step and a learning rate near 0.03. The generator squeezes its samples into a narrow spike that chases the discriminator around: mode collapse. The flat stretches in g[z] show it.',
        'With Two or Three modes, try a few seeds. Sometimes the generator covers one mode and ignores another for a long time (mode dropping), because its loss only punishes samples where there is no real data.',
        'Switch to the book loss, log(1 − sig[f]). When the discriminator is confident early on, this loss is flat and the generator barely moves.',
      ]}
      takeaway="A GAN learns without ever writing down a density, but training is a balance between two networks rather than a descent down one loss. The learning rate and the number of discriminator steps decide whether it settles, oscillates or collapses."
    >
      <div className="dl-controls">
        <Chips
          options={(Object.keys(GAN_TARGETS) as GanTarget[]).map((id) => ({ id, label: GAN_TARGETS[id].label }))}
          value={target}
          onChange={(t) => (setTarget(t), restart(seed, t))}
        />
        <Chips
          options={[
            { id: 'nonsat', label: 'Generator loss −log sig[f]' },
            { id: 'book', label: 'Book loss log(1 − sig[f])' },
          ]}
          value={loss}
          onChange={setLoss}
        />
      </div>
      <div className="dl-controls">
        <Slider
          label="learning rate"
          value={lrLog}
          min={-3.3}
          max={-1.3}
          onChange={setLrLog}
          show={(v) => fmt(10 ** v, 2)}
        />
        <Slider
          label="discriminator steps per generator step"
          value={dSteps}
          min={1}
          max={5}
          step={1}
          onChange={setDSteps}
          show={(v) => String(v)}
        />
        <div className="row">
          <button className="btn primary small" onClick={() => setRunning((r) => !r && s.step < GAN_MAX_STEPS)}>
            {running ? 'Pause' : 'Run'}
          </button>
          <button className="btn small" onClick={() => train(10)} disabled={running}>
            10 steps
          </button>
          <button className="btn small" onClick={() => restart(seed, target)}>
            Reset
          </button>
          <button className="btn small" onClick={() => (setSeed(seed + 1), restart(seed + 1, target))}>
            New seed
          </button>
        </div>
      </div>
      <Plot
        x={GAN_X}
        y={[0, 1.05]}
        height={250}
        xLabel="x"
        ariaLabel="Real density, histogram of generated samples and the discriminator's probability of real"
        draw={(f) => {
          bars(f, GAN_X[0], GAN_X[1], hist, f.c.s2);
          f.line(grid, real, f.c.s1, 2.5);
          f.hline(0.5, f.c.muted);
          f.line(grid, dCurve, f.c.s3, 2);
        }}
      />
      <Legend
        items={[
          ['s1', 'Real density Pr(x)'],
          ['s2', 'Generated samples'],
          ['s3', 'Discriminator: Pr(real | x)'],
        ]}
      />
      <div className="dl-cols">
        <div>
          <Plot
            x={[-3, 3]}
            y={GAN_X}
            height={200}
            xLabel="z"
            yLabel="x* = g[z, θ]"
            ariaLabel="The generator's mapping from latent value to sample"
            draw={(f) => f.line(zs, gCurve, f.c.s2, 2.5)}
          />
          <p className="dl-caption">
            The generator as a function. Steep parts spread samples out; flat parts pile many z onto one x.
          </p>
        </div>
        <div>
          <Plot
            x={[0, Math.max(500, s.step)]}
            y={[0, distMax]}
            height={200}
            xLabel="step"
            yLabel="distance to real data"
            ariaLabel="Wasserstein distance between generated and real samples during training"
            draw={(f) =>
              f.line(
                s.dist.map((d) => d[0]),
                s.dist.map((d) => d[1]),
                f.c.s4,
                2,
              )
            }
          />
          <p className="dl-caption">
            Wasserstein distance between 2,000 generated and 2,000 real samples (notebook 15.2). Neither loss shows
            this.
          </p>
        </div>
      </div>
      <Readout
        items={[
          ['step', s.step],
          ['discriminator loss (1.39 at chance)', fmt(s.dLoss)],
          ['generator loss', fmt(s.gLoss)],
          ['mean Pr(real) on real data', fmt(dReal)],
          ['mean Pr(real) on generated', fmt(dFake)],
          ['distance to real data', fmt(dist)],
        ]}
      />
    </Notebook>
  );
}

// ---------- 15.2 Wasserstein distance ----------

const W_BINS = 60;
const W_DX = 0.2;
const W_RANGE: [number, number] = [0, W_BINS * W_DX];
const W_CENTRES = Array.from({ length: W_BINS }, (_, i) => (i + 0.5) * W_DX);
const W_P_CENTRE = 3;

/** A discrete triangular bump over the bins: its centre and its half-width. */
function bump(centre: number, width: number): number[] {
  const w = W_CENTRES.map((x) => Math.max(0, 1 - Math.abs(x - centre) / width));
  const total = sum(w);
  return w.map((v) => v / total);
}

/** The Wasserstein distance (from the cumulative distributions), both KL divergences and the JS divergence, in nats. */
function divergences(p: number[], q: number[]) {
  let fp = 0,
    fq = 0,
    w = 0,
    klPQ = 0,
    klQP = 0,
    js = 0;
  for (let i = 0; i < p.length; i++) {
    fp += p[i];
    fq += q[i];
    w += Math.abs(fp - fq) * W_DX;
    if (p[i] > 0) klPQ += q[i] > 0 ? p[i] * Math.log(p[i] / q[i]) : Infinity;
    if (q[i] > 0) klQP += p[i] > 0 ? q[i] * Math.log(q[i] / p[i]) : Infinity;
    const m = (p[i] + q[i]) / 2;
    if (p[i] > 0) js += 0.5 * p[i] * Math.log(p[i] / m);
    if (q[i] > 0) js += 0.5 * q[i] * Math.log(q[i] / m);
  }
  return { w, klPQ, klQP, js };
}

/**
 * The cost of the transport plan that moves mass in order, left to right (the north-west corner rule). In 1D with
 * cost |i − j| this plan is optimal, so its cost is the Wasserstein distance: a check on the CDF formula.
 */
function transportCost(p: number[], q: number[]): number {
  let i = 0,
    j = 0,
    a = p[0],
    b = q[0],
    cost = 0;
  while (i < p.length && j < q.length) {
    const m = Math.min(a, b);
    cost += m * Math.abs(i - j) * W_DX;
    a -= m;
    b -= m;
    if (a <= 1e-15) a = p[++i] ?? 0;
    if (b <= 1e-15) b = q[++j] ?? 0;
  }
  return cost;
}

const cumulative = (p: number[]) => {
  let c = 0;
  return p.map((v) => (c += v));
};

function Wasserstein() {
  const [centre, setCentre] = useState(8);
  const [pw, setPw] = useState(1);
  const [qw, setQw] = useState(1);
  const p = useMemo(() => bump(W_P_CENTRE, pw), [pw]);
  const q = bump(centre, qw);
  const d = divergences(p, q);
  const plan = transportCost(p, q);
  const sweep = useMemo(() => {
    const cs = linspace(1, 11, 201);
    return { cs, ds: cs.map((c) => divergences(p, bump(c, qw))) };
  }, [p, qw]);
  const step = 0.01;
  const slope = (k: 'w' | 'js') =>
    (divergences(p, bump(centre + step, qw))[k] - divergences(p, bump(centre - step, qw))[k]) / (2 * step);
  const cp = cumulative(p),
    cq = cumulative(q);
  const edges = W_CENTRES.map((x) => x + W_DX / 2);
  const top = Math.max(...p, ...q) * 1.1;
  const wMax = Math.max(...sweep.ds.map((v) => v.w)) * 1.05;

  return (
    <Notebook
      id="15.2"
      title="Wasserstein distance"
      intro={
        <>
          Two distributions over 60 bins: a fixed Pr(x) and a q(x) you can slide. The Wasserstein (earth mover&apos;s)
          distance is the least work needed to move one pile of mass into the other, where work is mass times distance.
          In 1D the cheapest plan moves mass in order from left to right, so the distance is the area between the two
          cumulative distributions. The JS divergence, which a GAN with a perfect discriminator minimises, and the KL
          divergence only compare the heights bin by bin.
        </>
      }
      tryThis={[
        'Slide q well away from Pr so the bumps do not overlap. JS sits at log 2 = 0.693 and its slope is 0: it gives no hint which way to move. The Wasserstein distance keeps falling as q gets closer, with slope ±1.',
        'Watch KL(Pr‖q): it is infinite whenever Pr has mass in a bin where q has none, which is most positions.',
        'Give the two bumps different widths. The Wasserstein distance no longer reaches 0, because some mass must also spread out, but it still changes smoothly.',
        'Compare the two Wasserstein readouts: the area between the CDFs and the cost of the in-order transport plan agree.',
      ]}
      takeaway="Divergences that compare densities point by point saturate when the supports do not overlap, so their gradients vanish. The Wasserstein distance measures how far mass has to travel, so it keeps a useful gradient. That is why the Wasserstein GAN trains more stably."
    >
      <div className="dl-controls">
        <Slider label="centre of q" value={centre} min={1} max={11} onChange={setCentre} />
        <Slider label="width of Pr" value={pw} min={0.3} max={3} onChange={setPw} />
        <Slider label="width of q" value={qw} min={0.3} max={3} onChange={setQw} />
      </div>
      <div className="dl-cols">
        <div>
          <Plot
            x={W_RANGE}
            y={[0, top]}
            height={200}
            xLabel="x"
            ariaLabel="The two discrete distributions"
            draw={(f) => {
              bars(f, W_RANGE[0], W_RANGE[1], p, f.c.s1, 0.6);
              bars(f, W_RANGE[0], W_RANGE[1], q, f.c.s2, 0.6);
            }}
          />
          <Legend
            items={[
              ['s1', 'Pr(x)'],
              ['s2', 'q(x)'],
            ]}
          />
        </div>
        <div>
          <Plot
            x={W_RANGE}
            y={[0, 1.05]}
            height={200}
            xLabel="x"
            ariaLabel="Cumulative distributions with the area between them shaded"
            draw={(f) => {
              f.ctx.save();
              f.ctx.globalAlpha = 0.3;
              f.ctx.fillStyle = f.c.s4;
              cp.forEach((a, i) => {
                const b = cq[i];
                const left = f.x(i * W_DX),
                  right = f.x((i + 1) * W_DX);
                f.ctx.fillRect(left, f.y(Math.max(a, b)), right - left, f.y(Math.min(a, b)) - f.y(Math.max(a, b)));
              });
              f.ctx.restore();
              f.line(edges, cp, f.c.s1, 2);
              f.line(edges, cq, f.c.s2, 2);
            }}
          />
          <p className="dl-caption">Cumulative distributions. The shaded area is the Wasserstein distance.</p>
        </div>
      </div>
      <div className="dl-cols">
        <div>
          <Plot
            x={[1, 11]}
            y={[0, wMax]}
            height={190}
            xLabel="centre of q"
            yLabel="Wasserstein"
            ariaLabel="Wasserstein distance as q slides"
            draw={(f) => {
              f.line(
                sweep.cs,
                sweep.ds.map((v) => v.w),
                f.c.s4,
                2.5,
              );
              f.vline(centre, f.c.muted);
              f.dots([[centre, d.w]], f.c.s4, 5);
            }}
          />
        </div>
        <div>
          <Plot
            x={[1, 11]}
            y={[0, 3]}
            height={190}
            xLabel="centre of q"
            yLabel="divergence"
            ariaLabel="JS and KL divergence as q slides"
            draw={(f) => {
              f.hline(Math.log(2), f.c.muted);
              f.line(
                sweep.cs,
                sweep.ds.map((v) => v.klPQ),
                f.c.s2,
                2,
              );
              f.line(
                sweep.cs,
                sweep.ds.map((v) => v.js),
                f.c.s3,
                2.5,
              );
              f.vline(centre, f.c.muted);
              f.dots([[centre, d.js]], f.c.s3, 5);
            }}
          />
          <Legend
            items={[
              ['s3', 'JS divergence'],
              ['s2', 'KL(Pr‖q), missing where infinite'],
              ['muted', 'log 2'],
            ]}
          />
        </div>
      </div>
      <Readout
        items={[
          ['Wasserstein (area between CDFs)', fmt(d.w)],
          ['Wasserstein (transport plan)', fmt(plan)],
          ['slope of Wasserstein', fmt(slope('w'))],
          ['JS divergence', fmt(d.js)],
          ['slope of JS', fmt(slope('js'))],
          ['KL(Pr‖q)', show(d.klPQ)],
          ['KL(q‖Pr)', show(d.klQP)],
        ]}
      />
    </Notebook>
  );
}

// ---------- 16.1 1D normalizing flows ----------

interface Flow1D {
  alpha: number;
  beta: number;
  gamma: number;
}

/** The flow x = f[z, ϕ] = αz + β tanh(γz). Its slope is α + βγ sech²(γz), so it only increases when α > 0 and β ≥ 0. */
const flowF = (p: Flow1D, z: number) => p.alpha * z + p.beta * Math.tanh(p.gamma * z);
const flowDf = (p: Flow1D, z: number) => p.alpha + (p.beta * p.gamma) / Math.cosh(p.gamma * z) ** 2;
const flowMinSlope = (p: Flow1D) => (p.beta >= 0 ? p.alpha : p.alpha + p.beta * p.gamma);

/** z = f⁻¹[x, ϕ] by bisection, which works because f is increasing. */
function flowInverse(p: Flow1D, x: number): number {
  let lo = -100,
    hi = 100;
  for (let i = 0; i < 70; i++) {
    const mid = (lo + hi) / 2;
    if (flowF(p, mid) < x) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

const FLOW_START: Flow1D = { alpha: 0.6, beta: 0.4, gamma: 1 };
const FLOW_DATA = (() => {
  const r = rng(11);
  return Array.from({ length: 40 }, () => (r() < 0.5 ? -1.6 : 1.4) + 0.45 * gauss(r));
})();
const FLOW_Z = (() => {
  const r = rng(12);
  return Array.from({ length: 4000 }, () => gauss(r));
})();

/** The mean negative log-likelihood of the data, by equation 16.2: log|∂f/∂z| − log Pr(z) at z = f⁻¹[x]. */
function flowNll(p: Flow1D): number {
  return mean(
    FLOW_DATA.map((x) => {
      const z = flowInverse(p, x);
      return Math.log(Math.abs(flowDf(p, z))) - Math.log(normPdf(z));
    }),
  );
}

const flowClamp = (p: Flow1D): Flow1D => ({
  alpha: clamp(p.alpha, 0.1, 2),
  beta: clamp(p.beta, 0, 3),
  gamma: clamp(p.gamma, 0.5, 4),
});

/** Fits the three parameters by gradient descent on the negative log-likelihood, with finite-difference gradients. */
function fitFlow(start: Flow1D): Flow1D {
  let p = flowMinSlope(start) > 0 ? flowClamp(start) : FLOW_START;
  const keys: (keyof Flow1D)[] = ['alpha', 'beta', 'gamma'];
  for (let it = 0; it < 300; it++) {
    const base = flowNll(p);
    const g = keys.map((k) => (flowNll({ ...p, [k]: p[k] + 1e-4 }) - base) / 1e-4);
    const norm = Math.max(1, Math.hypot(...g));
    p = flowClamp({
      alpha: p.alpha - (0.05 * g[0]) / norm,
      beta: p.beta - (0.05 * g[1]) / norm,
      gamma: p.gamma - (0.05 * g[2]) / norm,
    });
  }
  return p;
}

function NormalizingFlow1D() {
  const [p, setP] = useState<Flow1D>(FLOW_START);
  const [xStar, setXStar] = useState(0.5);
  const set = (k: keyof Flow1D) => (v: number) => setP((cur) => ({ ...cur, [k]: v }));
  const invertible = flowMinSlope(p) > 0;
  const zGrid = linspace(-3.5, 3.5, 351);
  const xOf = zGrid.map((z) => flowF(p, z));
  const model = zGrid.map((z) => normPdf(z) / Math.abs(flowDf(p, z)));
  const base = zGrid.map((z) => normPdf(z));
  const hist = densityHistogram(
    FLOW_Z.map((z) => flowF(p, z)),
    -4,
    4,
    64,
  );
  const top = clamp(Math.max(...model.filter((v, i) => Math.abs(xOf[i]) < 4)) * 1.15, 0.45, 1.2);
  const zStar = flowInverse(p, xStar);
  const slopeStar = flowDf(p, zStar);
  const nll = invertible ? flowNll(p) : NaN;
  const dataZ = invertible ? FLOW_DATA.map((x) => flowInverse(p, x)) : [];

  return (
    <Notebook
      id="16.1"
      title="1D normalizing flows"
      intro={
        <>
          A normalising flow draws z from a standard normal and passes it through an invertible function x = f[z, ϕ].
          Here f[z] = αz + β tanh(γz). Where f is steep it stretches the line and the density falls; where it is shallow
          it squeezes the line and the density rises. The change of variables makes this exact: Pr(x) = Pr(z) ·
          |∂f/∂z|⁻¹, at the z = f⁻¹[x] that produced x.
        </>
      }
      tryThis={[
        'Raise β: f gets steep around z = 0, which stretches the middle of the normal and splits it into two bumps.',
        'Compare the dashed line, Pr(z) at z = f⁻¹[x], with the solid one. Their ratio is the change-of-variables term |∂f/∂z|⁻¹.',
        'Press Fit to the data. Gradient descent on the negative log-likelihood (equation 16.2) moves the two bumps onto the black data points, and the data mapped back to z look roughly normal.',
        'Make β negative and γ large. Once the slope goes below zero, f folds over: one x has several z, there is no inverse, and the formula (red) no longer matches the samples.',
      ]}
      takeaway="A flow gets both sampling (push z forwards through f) and an exact likelihood (pull x back through f⁻¹ and correct by the slope). The price is that every layer must be invertible, with a derivative that is cheap to compute."
    >
      <div className="dl-controls">
        <Slider label="α" value={p.alpha} min={0.1} max={2} onChange={set('alpha')} />
        <Slider label="β" value={p.beta} min={-1} max={3} onChange={set('beta')} />
        <Slider label="γ" value={p.gamma} min={0.5} max={4} onChange={set('gamma')} />
        <Slider label="probe x" value={xStar} min={-3.5} max={3.5} onChange={setXStar} />
        <div className="row">
          <button className="btn primary small" onClick={() => setP(fitFlow(p))}>
            Fit to the data
          </button>
          <button className="btn small" onClick={() => setP(FLOW_START)}>
            Reset
          </button>
        </div>
      </div>
      <div className="dl-cols">
        <div>
          <Plot
            x={[-3.5, 3.5]}
            y={[0, 0.45]}
            height={170}
            xLabel="z"
            yLabel="Pr(z)"
            ariaLabel="The base density, with the data mapped back to latent space"
            draw={(f) => {
              f.line(zGrid, base, f.c.s1, 2.5);
              if (invertible) {
                f.vline(zStar, f.c.muted);
                f.dots(
                  dataZ.map((z) => [z, 0.012] as [number, number]),
                  f.c.ink,
                  2.5,
                );
              }
            }}
          />
          <p className="dl-caption">
            Base density. Black dots: the data mapped back by f⁻¹ (the normalising direction).
          </p>
          <Plot
            x={[-3.5, 3.5]}
            y={[-4, 4]}
            height={230}
            xLabel="z"
            yLabel="x = f[z]"
            ariaLabel="The flow function from latent to observed values"
            draw={(f) => {
              f.line([-4, 4], [-4, 4], f.c.muted, 1, [4, 4]);
              f.line(zGrid, xOf, invertible ? f.c.ink : f.c.bad, 2.5);
              if (invertible) {
                f.line([-3.5, zStar, zStar], [xStar, xStar, -4], f.c.s2, 1, [3, 3]);
                f.dots([[zStar, xStar]], f.c.s2, 5);
              }
            }}
          />
        </div>
        <div>
          <Plot
            x={[-4, 4]}
            y={[0, top]}
            height={300}
            xLabel="x"
            yLabel="Pr(x)"
            ariaLabel="The model density from the change of variables, with samples and data"
            draw={(f) => {
              bars(f, -4, 4, hist, f.c.s2, 0.3);
              f.line(xOf, base, f.c.s1, 1.5, [5, 4]);
              f.line(xOf, model, invertible ? f.c.s2 : f.c.bad, 2.5);
              f.dots(
                FLOW_DATA.map((x) => [x, 0.012] as [number, number]),
                f.c.ink,
                2.5,
              );
              f.vline(xStar, f.c.muted);
            }}
          />
          <Legend
            items={[
              ['s2', 'Pr(x) = Pr(z)·|∂f/∂z|⁻¹, over a histogram of samples'],
              ['s1', 'Pr(z) at z = f⁻¹[x], before the correction'],
              ['ink', 'Training data'],
            ]}
          />
          {!invertible && (
            <p className="dl-caption" style={{ color: 'var(--bad)' }}>
              The slope of f goes below zero, so f is not invertible and the formula no longer describes the samples.
            </p>
          )}
        </div>
      </div>
      <Readout
        items={[
          ['z = f⁻¹[x]', invertible ? fmt(zStar) : '—'],
          ['Pr(z)', invertible ? fmt(normPdf(zStar)) : '—'],
          ['∂f/∂z at z', invertible ? fmt(slopeStar) : '—'],
          ['Pr(x) = Pr(z) / |∂f/∂z|', invertible ? fmt(normPdf(zStar) / slopeStar) : '—'],
          ['mean negative log-likelihood of the data', invertible ? fmt(nll) : '—'],
        ]}
      />
    </Notebook>
  );
}

// ---------- 16.2 Autoregressive flows ----------

type Conditioner = 'bend' | 'wave';
interface ArFlow {
  a: number;
  c: number;
  s: number;
  cond: Conditioner;
}

/** The conditioner: the shift μ[z₁] and scale σ[z₁] = exp(s·z₁) that z₁ chooses for the transform of z₂. */
const arMu = (p: ArFlow, z1: number) => (p.cond === 'bend' ? p.c * (z1 * z1 - 1) : 1.5 * p.c * Math.sin(2 * z1));
const arDmu = (p: ArFlow, z1: number) => (p.cond === 'bend' ? 2 * p.c * z1 : 3 * p.c * Math.cos(2 * z1));
const arSigma = (p: ArFlow, z1: number) => Math.exp(p.s * z1);

/** Forward (generative) direction: x₁ = a·z₁, then x₂ = μ[z₁] + σ[z₁]·z₂. */
const arForward = (p: ArFlow, z1: number, z2: number): [number, number] => [
  p.a * z1,
  arMu(p, z1) + arSigma(p, z1) * z2,
];

/** Inverse (normalising) direction, one coordinate at a time: z₁ first, because undoing x₂ needs it. */
function arInverse(p: ArFlow, x1: number, x2: number): [number, number] {
  const z1 = x1 / p.a;
  return [z1, (x2 - arMu(p, z1)) / arSigma(p, z1)];
}

/** Pr(x) = Pr(z₁)Pr(z₂) / |det ∂x/∂z|, where the determinant is the product of the diagonal, a·σ[z₁]. */
function arDensity(p: ArFlow, x1: number, x2: number): number {
  const [z1, z2] = arInverse(p, x1, x2);
  return (normPdf(z1) * normPdf(z2)) / (p.a * arSigma(p, z1));
}

const AR_RANGE: [number, number] = [-4, 4];
const AR_Z = (() => {
  const r = rng(21);
  return Array.from({ length: 300 }, () => [gauss(r), gauss(r)] as [number, number]);
})();

function AutoregressiveFlow() {
  const [p, setP] = useState<ArFlow>({ a: 1, c: 0.5, s: 0.25, cond: 'bend' });
  const [xStar, setXStar] = useState<[number, number]>([1, 1]);
  const set = (k: 'a' | 'c' | 's') => (v: number) => setP((cur) => ({ ...cur, [k]: v }));

  const { peak, mass } = useMemo(() => {
    const n = 120,
      cell = (AR_RANGE[1] - AR_RANGE[0]) / n;
    let best = 0,
      total = 0;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const v = arDensity(p, AR_RANGE[0] + (i + 0.5) * cell, AR_RANGE[0] + (j + 0.5) * cell);
        best = Math.max(best, v);
        total += v * cell * cell;
      }
    }
    return { peak: best, mass: total };
  }, [p]);

  const [z1, z2] = arInverse(p, ...xStar);
  const sg = arSigma(p, z1);
  const J = [
    [p.a, 0],
    [arDmu(p, z1) + p.s * sg * z2, sg],
  ];
  // A check by finite differences on the forward map, with the general 2×2 determinant.
  const e = 1e-5;
  const fd = [0, 1].map((col) => {
    const dz: [number, number] = col === 0 ? [e, 0] : [0, e];
    const up = arForward(p, z1 + dz[0], z2 + dz[1]),
      down = arForward(p, z1 - dz[0], z2 - dz[1]);
    return [(up[0] - down[0]) / (2 * e), (up[1] - down[1]) / (2 * e)];
  });
  const detNumeric = fd[0][0] * fd[1][1] - fd[1][0] * fd[0][1];
  const samples = AR_Z.map(([a, b]) => arForward(p, a, b));
  const lines = [-2, -1, 0, 1, 2];
  const along = linspace(-3, 3, 61);

  return (
    <Notebook
      id="16.2"
      title="Autoregressive flows"
      intro={
        <>
          A 2D flow in which each output depends only on earlier inputs. The first coordinate is scaled, x₁ = a·z₁. The
          second is shifted and scaled by amounts that z₁ chooses: x₂ = μ[z₁] + σ[z₁]·z₂. The shift and scale (the
          conditioner) can be any function, here a bend or a wave, because they never need inverting. The Jacobian ∂x/∂z
          is triangular, so its determinant is just the product of its diagonal.
        </>
      }
      tryThis={[
        'Drag on the left plot to pick a point. The inverse finds z₁ first, then uses it to undo x₂: that order cannot be changed, which is why inverting a long autoregressive flow is slow.',
        'Look at the Jacobian: the lower-left entry can be large, but the determinant ignores it. The general 2×2 determinant from finite differences comes out the same.',
        'Set the scale dependence s to a non-zero value: the density fans out to one side, because σ[z₁] grows with z₁ and the determinant a·σ[z₁] grows with it.',
        'The probability inside the plot stays close to 1 whatever you choose: the determinant keeps the total mass right.',
      ]}
      takeaway="Autoregressive flows can be very flexible, because the conditioner is unconstrained, yet their Jacobian determinant costs only a product of diagonal terms. The catch is direction: one way can be computed in parallel, the other must go one dimension at a time."
    >
      <div className="dl-controls">
        <Chips
          options={[
            { id: 'bend', label: 'μ[z₁] = c(z₁² − 1)' },
            { id: 'wave', label: 'μ[z₁] = 1.5c·sin(2z₁)' },
          ]}
          value={p.cond}
          onChange={(cond) => setP((cur) => ({ ...cur, cond }))}
        />
        <Slider label="scale a" value={p.a} min={0.4} max={2} onChange={set('a')} />
        <Slider label="shift c" value={p.c} min={-1.2} max={1.2} onChange={set('c')} />
        <Slider label="scale dependence s" value={p.s} min={-0.6} max={0.6} onChange={set('s')} />
      </div>
      <div className="dl-cols">
        <div>
          <Plot
            x={AR_RANGE}
            y={AR_RANGE}
            height={320}
            xLabel="x₁"
            yLabel="x₂"
            ariaLabel="The model density over the data plane, with samples and the warped latent grid"
            onDrag={(a, b) => setXStar([clamp(a, -4, 4), clamp(b, -4, 4)])}
            draw={(f) => {
              f.heat((a, b) => shade(f, f.c.s1, (arDensity(p, a, b) / peak) ** 0.8), 70);
              for (const v of lines) {
                f.line(
                  along.map((u) => arForward(p, v, u)[0]),
                  along.map((u) => arForward(p, v, u)[1]),
                  f.c.muted,
                  0.8,
                );
                f.line(
                  along.map((u) => arForward(p, u, v)[0]),
                  along.map((u) => arForward(p, u, v)[1]),
                  f.c.muted,
                  0.8,
                );
              }
              f.dots(samples, f.c.s2, 1.6);
              f.dots([xStar], f.c.ink, 5);
            }}
          />
          <p className="dl-caption">
            Pr(x), darker where higher. Grey lines: the z grid carried forward. Orange: samples. Drag to move the point.
          </p>
        </div>
        <div>
          <Plot
            x={[-3.5, 3.5]}
            y={[-3.5, 3.5]}
            height={320}
            xLabel="z₁"
            yLabel="z₂"
            ariaLabel="The base density over the latent plane with the inverted point"
            draw={(f) => {
              f.heat((a, b) => shade(f, f.c.s1, (normPdf(a) * normPdf(b) * 2 * Math.PI) ** 0.8), 50);
              for (const v of lines) {
                f.vline(v, f.c.muted, []);
                f.hline(v, f.c.muted, []);
              }
              f.dots([[z1, z2]], f.c.ink, 5);
            }}
          />
          <p className="dl-caption">The base density Pr(z) and the point&apos;s z = f⁻¹[x].</p>
        </div>
      </div>
      <div className="dl-cols">
        <div className="dl-scroll">
          <table className="dl-table">
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>∂x/∂z</th>
                <th>∂/∂z₁</th>
                <th>∂/∂z₂</th>
              </tr>
            </thead>
            <tbody>
              {J.map((row, i) => (
                <tr key={i}>
                  <td style={{ textAlign: 'left' }}>x{i === 0 ? '₁' : '₂'}</td>
                  {row.map((v, j) => (
                    <td key={j}>{fmt(v, 4)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="dl-caption">Triangular: x₁ does not depend on z₂.</p>
        </div>
        <Readout
          items={[
            ['z = f⁻¹[x]', `(${fmt(z1)}, ${fmt(z2)})`],
            ['det from the diagonal, a·σ[z₁]', fmt(p.a * sg, 4)],
            ['det by finite differences', fmt(detNumeric, 4)],
            ['Pr(x) at the point', fmt(arDensity(p, ...xStar))],
            ['probability inside the plot', fmt(mass, 3)],
          ]}
        />
      </div>
    </Notebook>
  );
}

// ---------- 16.3 Contraction mappings ----------

const CM_OMEGA = 1.5;

/** f[z] = 0.5 + (L/ω)·sin(ωz). Its slope is L·cos(ωz), so its Lipschitz constant (largest absolute slope) is exactly L. */
const cmF = (L: number, z: number) => 0.5 + (L / CM_OMEGA) * Math.sin(CM_OMEGA * z);

/** Counts the roots of g on [−8, 8] by sign changes on a fine grid. */
function countRoots(g: (z: number) => number): number {
  let n = 0,
    prev = g(-8);
  for (let i = 1; i <= 4000; i++) {
    const v = g(-8 + (16 * i) / 4000);
    if (v === 0 || Math.sign(v) !== Math.sign(prev)) n++;
    prev = v;
  }
  return n;
}

function ContractionMappings() {
  const [mode, setMode] = useState<'fixed' | 'invert'>('fixed');
  const [L, setL] = useState(0.7);
  const [z0, setZ0] = useState(-3);
  const [y, setY] = useState(1.5);
  const [n, setN] = useState(12);
  const g = (z: number) => (mode === 'fixed' ? cmF(L, z) : y - cmF(L, z));
  const zs = [z0];
  for (let k = 0; k < n; k++) zs.push(g(zs[k]));
  const residuals = zs.slice(0, -1).map((z, k) => Math.abs(zs[k + 1] - z));
  const logRes = residuals.map((r) => Math.log10(Math.max(r, 1e-14)));
  const bound = residuals.map((_, k) => Math.log10(Math.max(residuals[0] * L ** k, 1e-14)));
  const roots = mode === 'fixed' ? countRoots((z) => cmF(L, z) - z) : countRoots((z) => z + cmF(L, z) - y);
  const grid = linspace(-4, 4, 321);
  const cobX: number[] = [],
    cobY: number[] = [];
  zs.slice(0, -1).forEach((z, k) => {
    cobX.push(z, z);
    cobY.push(z, zs[k + 1]);
    cobX.push(zs[k + 1]);
    cobY.push(zs[k + 1]);
  });
  const last = zs[zs.length - 1];

  return (
    <Notebook
      id="16.3"
      title="Contraction mappings"
      intro={
        <>
          A function is a contraction if it brings any two points closer together: |f[a] − f[b]| ≤ β|a − b| with β &lt;
          1, where β is its Lipschitz constant. Feeding the output back in, z ← f[z], then converges to the single point
          where f[z] = z, from any start. Residual flows use this to invert a layer y = z + f[z]: iterate z ← y − f[z],
          which is a contraction whenever f is.
        </>
      }
      tryThis={[
        'With L below 1, drag the start point anywhere: the cobweb always spirals or staircases into the same fixed point, and the residual falls at least as fast as the dashed bound Lᵏ.',
        'Push L above 1. The iteration may wander, cycle or settle on one of several fixed points, depending on where it starts.',
        'Switch to Invert y = z + f[z]. With L < 1, z + f[z] always slopes upwards (its slope is at least 1 − L), so each y has exactly one z, and the iteration finds it.',
        'Still inverting, raise L above 1: z + f[z] folds back on itself, some y have three solutions, and the layer is no longer invertible.',
      ]}
      takeaway="Keeping the Lipschitz constant of the residual branch below 1 (in practice, by limiting the size of the weights) guarantees that the residual layer has exactly one inverse, and gives a simple way to compute it."
    >
      <div className="dl-controls">
        <Chips
          options={[
            { id: 'fixed', label: 'Fixed point of f[z]' },
            { id: 'invert', label: 'Invert y = z + f[z]' },
          ]}
          value={mode}
          onChange={setMode}
        />
        <Slider label="Lipschitz constant L" value={L} min={0.1} max={1.8} onChange={setL} />
        <Slider label="start z₀" value={z0} min={-3.8} max={3.8} onChange={setZ0} />
        {mode === 'invert' && <Slider label="target y" value={y} min={-3} max={3} onChange={setY} />}
        <Slider label="iterations" value={n} min={1} max={40} step={1} onChange={setN} show={(v) => String(v)} />
      </div>
      <div className="dl-cols">
        <div>
          <Plot
            x={[-4, 4]}
            y={[-4, 4]}
            height={300}
            xLabel="z"
            yLabel={mode === 'fixed' ? 'f[z]' : 'y − f[z]'}
            ariaLabel="Cobweb diagram of the iteration"
            onDrag={(a, _b, phase) => phase !== 'end' && setZ0(clamp(a, -3.8, 3.8))}
            draw={(f) => {
              f.line([-4, 4], [-4, 4], f.c.muted, 1, [4, 4]);
              f.line(grid, grid.map(g), f.c.s1, 2.5);
              f.line(cobX, cobY, f.c.s2, 1.5);
              f.dots([[z0, z0]], f.c.s2, 4);
              f.dots([[last, g(last)]], f.c.ink, 4.5);
            }}
          />
          <p className="dl-caption">
            Up to the curve, across to the diagonal, repeat. A fixed point is where the curve crosses the dashed line.
            Drag to choose the start.
          </p>
        </div>
        <div>
          <Plot
            x={[0, Math.max(1, n - 1)]}
            y={[-14, 1]}
            height={mode === 'invert' ? 140 : 300}
            xLabel="iteration k"
            yLabel="log₁₀ step size"
            ariaLabel="How far each iteration moves, on a log scale"
            draw={(f) => {
              if (L < 1)
                f.line(
                  bound.map((_, k) => k),
                  bound,
                  f.c.muted,
                  1.5,
                  [5, 4],
                );
              f.line(
                logRes.map((_, k) => k),
                logRes,
                f.c.s2,
                2,
              );
            }}
          />
          {mode === 'invert' && (
            <Plot
              x={[-4, 4]}
              y={[-5, 5]}
              height={150}
              xLabel="z"
              yLabel="z + f[z]"
              ariaLabel="The residual layer's output against its input"
              draw={(f) => {
                f.hline(y, f.c.s4);
                f.line(
                  grid,
                  grid.map((z) => z + cmF(L, z)),
                  f.c.s3,
                  2.5,
                );
                f.dots([[last, last + cmF(L, last)]], f.c.ink, 4.5);
              }}
            />
          )}
          <p className="dl-caption">
            Step size |z₍ₖ₊₁₎ − zₖ|, which is also the residual. Dashed: the guarantee L·previous step, when L &lt; 1.
          </p>
        </div>
      </div>
      <Readout
        items={[
          ['Lipschitz constant', fmt(L)],
          [`z after ${n} iterations`, fmt(last, 5)],
          ['last step size', fmt(residuals[residuals.length - 1], 2)],
          [mode === 'fixed' ? 'fixed points of f' : 'solutions of z + f[z] = y', roots],
        ]}
      />
    </Notebook>
  );
}

// ---------- 17.1 Latent variable models ----------

interface Component {
  w: number;
  mu: number;
  sd: number;
}
const LV_START: Component[] = [
  { w: 0.3, mu: -2, sd: 0.5 },
  { w: 0.5, mu: 0.3, sd: 0.7 },
  { w: 0.2, mu: 2.2, sd: 0.35 },
];
const LV_COLOURS: (keyof Colours)[] = ['s1', 's3', 's4'];

/** The nonlinear model's mean function f[z]: a fixed curve standing in for a decoder network. */
const lvF = (z: number) => 1.5 * Math.sin(1.5 * z) + 0.5 * z;
const LV_ZS = linspace(-4, 4, 801);
const LV_DZ = LV_ZS[1] - LV_ZS[0];

/** Pr(x) = ∫ Norm_x[f[z], σ²]·Norm_z[0, 1] dz, by a fine sum over z. */
const lvMarginal = (x: number, sd: number) => LV_DZ * sum(LV_ZS.map((z) => normPdf(z) * normPdf(x, lvF(z), sd)));

function LatentVariables() {
  const [model, setModel] = useState<'discrete' | 'continuous'>('discrete');
  const [comps, setComps] = useState<Component[]>(LV_START);
  const [edit, setEdit] = useState<'0' | '1' | '2'>('1');
  const [sd, setSd] = useState(0.3);
  const [slices, setSlices] = useState(8);
  const [xStar, setXStar] = useState(0.8);
  const k = +edit;
  const setComp = (key: keyof Component) => (v: number) =>
    setComps((cur) => cur.map((c, i) => (i === k ? { ...c, [key]: v } : c)));
  const total = sum(comps.map((c) => c.w));
  const lambda = comps.map((c) => c.w / total);

  const xs = linspace(-4, 4, 241);
  const continuousCurve = useMemo(() => xs.map((x) => lvMarginal(x, sd)), [sd]); // eslint-disable-line react-hooks/exhaustive-deps
  const sliceZ = Array.from({ length: slices }, (_, i) => -3 + ((i + 0.5) * 6) / slices);
  const sliceW = sliceZ.map((z) => (normPdf(z) * 6) / slices);
  const discreteAt = (x: number) => comps.map((c, i) => lambda[i] * normPdf(x, c.mu, c.sd));
  const marginal = model === 'discrete' ? xs.map((x) => sum(discreteAt(x))) : continuousCurve;
  const slicesAt = (x: number) => sliceZ.map((z, i) => sliceW[i] * normPdf(x, lvF(z), sd));
  const top = Math.max(...marginal) * 1.2;

  const pxStar = model === 'discrete' ? sum(discreteAt(xStar)) : lvMarginal(xStar, sd);
  const posteriorDiscrete = discreteAt(xStar).map((v) => v / pxStar);
  const zPost = linspace(-3, 3, 241);
  const posteriorContinuous = zPost.map((z) => (normPdf(z) * normPdf(xStar, lvF(z), sd)) / pxStar);
  const jointPeak =
    model === 'discrete' ? Math.max(...comps.map((c, i) => lambda[i] / (c.sd * SQRT_2PI))) : 1 / (2 * Math.PI * sd);

  return (
    <Notebook
      id="17.1"
      title="Latent variable models"
      intro={
        <>
          A latent variable model describes Pr(x) indirectly. It picks a hidden z from a prior Pr(z), then x from a
          simple likelihood Pr(x|z), so Pr(x) = ∫ Pr(x|z) Pr(z) dz. With a discrete z this is a mixture of Gaussians,
          and the integral is a sum. With a continuous z and Pr(x|z) = Norm_x[f[z], σ²], as in a VAE&apos;s decoder, it
          is an infinite mixture: one Gaussian for every value of z.
        </>
      }
      tryThis={[
        'In the mixture, move one component and change its weight λ. Pr(x) is the sum of the dashed curves; the left plot shows the joint Pr(x, z), and adding up each column gives Pr(x).',
        'Move the probe x. The posterior Pr(z|x) shows which component probably produced it. Between two components it is split.',
        'Switch to the continuous model. The orange curve is f[z]; each horizontal slice of the joint is a Gaussian centred on it.',
        'Lower the number of slices: Pr(x) becomes a visible sum of a few Gaussians (dashed). Raise it and the sum matches the integral.',
        'Lower σ in the continuous model: the posterior for some x has several peaks, since several z map near the same x. A single Gaussian q(z|x) would fit it badly.',
      ]}
      takeaway="Simple pieces, a normal prior and a normal likelihood, combine into a complex density. The price is the integral over z: for a continuous, high-dimensional z it has no closed form, which is the problem the VAE's lower bound gets around."
    >
      <div className="dl-controls">
        <Chips
          options={[
            { id: 'discrete', label: 'Mixture of Gaussians' },
            { id: 'continuous', label: 'Continuous z' },
          ]}
          value={model}
          onChange={setModel}
        />
        <Slider label="probe x" value={xStar} min={-4} max={4} onChange={setXStar} />
      </div>
      {model === 'discrete' ? (
        <div className="dl-controls">
          <Chips
            options={[
              { id: '0', label: 'z = 1' },
              { id: '1', label: 'z = 2' },
              { id: '2', label: 'z = 3' },
            ]}
            value={edit}
            onChange={setEdit}
          />
          <Slider
            label="weight"
            value={comps[k].w}
            min={0.05}
            max={1}
            onChange={setComp('w')}
            show={() => `λ = ${fmt(lambda[k], 2)}`}
          />
          <Slider label="mean μ" value={comps[k].mu} min={-3.5} max={3.5} onChange={setComp('mu')} />
          <Slider label="std σ" value={comps[k].sd} min={0.15} max={1.5} onChange={setComp('sd')} />
        </div>
      ) : (
        <div className="dl-controls">
          <Slider label="noise σ" value={sd} min={0.1} max={1} onChange={setSd} />
          <Slider
            label="slices of z"
            value={slices}
            min={2}
            max={40}
            step={1}
            onChange={setSlices}
            show={(v) => String(v)}
          />
        </div>
      )}
      <div className="dl-cols">
        <div>
          <Plot
            x={[-4, 4]}
            y={model === 'discrete' ? [0.5, 3.5] : [-3, 3]}
            height={240}
            xLabel="x"
            yLabel="z"
            axes
            ariaLabel="The joint density of data and latent variable"
            draw={(f) => {
              f.heat((x, z) => {
                if (model === 'discrete') {
                  const i = clamp(Math.round(z) - 1, 0, 2);
                  return shade(f, f.c[LV_COLOURS[i]], (lambda[i] * normPdf(x, comps[i].mu, comps[i].sd)) / jointPeak);
                }
                return shade(f, f.c.s1, (normPdf(z) * normPdf(x, lvF(z), sd)) / jointPeak);
              }, 80);
              if (model === 'continuous') f.line(zPost.map(lvF), zPost, f.c.s2, 1.5);
              f.vline(xStar, f.c.ink);
            }}
          />
          <p className="dl-caption">Joint Pr(x, z) = Pr(x|z)·Pr(z), darker where higher.</p>
        </div>
        <div>
          <Plot
            x={[-4, 4]}
            y={[0, top]}
            height={240}
            xLabel="x"
            yLabel="Pr(x)"
            ariaLabel="The marginal density of the data and its components"
            draw={(f) => {
              if (model === 'discrete') {
                comps.forEach((_, i) =>
                  f.line(
                    xs,
                    xs.map((x) => discreteAt(x)[i]),
                    f.c[LV_COLOURS[i]],
                    1.5,
                    [5, 4],
                  ),
                );
              } else {
                sliceZ.forEach((_, i) =>
                  f.line(
                    xs,
                    xs.map((x) => slicesAt(x)[i]),
                    f.c.muted,
                    1,
                  ),
                );
                f.line(
                  xs,
                  xs.map((x) => sum(slicesAt(x))),
                  f.c.s4,
                  1.5,
                  [5, 4],
                );
              }
              f.line(xs, marginal, f.c.s2, 2.5);
              f.vline(xStar, f.c.ink);
            }}
          />
          <p className="dl-caption">
            {model === 'discrete'
              ? 'Orange: Pr(x). Dashed: λₙ·Normₓ[μₙ, σₙ²] for each z.'
              : `Orange: Pr(x) as the integral. Grey: ${slices} weighted slices. Dashed: their sum.`}
          </p>
        </div>
        <div>
          {model === 'discrete' ? (
            <Plot
              x={[0.5, 3.5]}
              y={[0, 1]}
              height={240}
              xLabel="z"
              yLabel="Pr(z | x)"
              ariaLabel="The posterior over the component given the probe value"
              draw={(f) =>
                posteriorDiscrete.forEach((v, i) => {
                  f.ctx.fillStyle = f.c[LV_COLOURS[i]];
                  f.ctx.fillRect(f.x(i + 0.7), f.y(v), f.x(i + 1.3) - f.x(i + 0.7), f.y(0) - f.y(v));
                })
              }
            />
          ) : (
            <Plot
              x={[-3, 3]}
              y={[0, Math.max(...posteriorContinuous) * 1.15 || 1]}
              height={240}
              xLabel="z"
              yLabel="Pr(z | x)"
              ariaLabel="The posterior over the latent variable given the probe value"
              draw={(f) => {
                f.line(
                  zPost,
                  zPost.map((z) => normPdf(z)),
                  f.c.muted,
                  1.5,
                  [5, 4],
                );
                f.line(zPost, posteriorContinuous, f.c.s1, 2.5);
              }}
            />
          )}
          <p className="dl-caption">
            Posterior at the probe, Pr(z|x) = Pr(x|z)Pr(z) / Pr(x)
            {model === 'continuous' ? '; dashed: the prior.' : '.'}
          </p>
        </div>
      </div>
      <Readout
        items={
          model === 'discrete'
            ? [
                ['Pr(x) at the probe', fmt(pxStar, 4)],
                ...posteriorDiscrete.map((v, i) => [`Pr(z = ${i + 1} | x)`, fmt(v, 3)] as [string, string]),
              ]
            : [
                ['Pr(x) by the integral', fmt(pxStar, 4)],
                [`Pr(x) by ${slices} slices`, fmt(sum(slicesAt(xStar)), 4)],
              ]
        }
      />
    </Notebook>
  );
}

// ---------- 17.2 Reparameterization trick ----------

const rpF = (x: number, c: number) => Math.sin(2 * x) + 0.3 * x * x + c;
const rpDf = (x: number) => 2 * Math.cos(2 * x) + 0.6 * x;
/** E[f[x]] for x ~ Norm[μ, σ²], in closed form: E[sin 2x] = sin(2μ)·exp(−2σ²) and E[x²] = μ² + σ². */
const rpExpect = (mu: number, sd: number, c: number) =>
  Math.sin(2 * mu) * Math.exp(-2 * sd * sd) + 0.3 * (mu * mu + sd * sd) + c;
const rpTrue = (mu: number, sd: number) => ({
  mu: 2 * Math.cos(2 * mu) * Math.exp(-2 * sd * sd) + 0.6 * mu,
  sd: -4 * sd * Math.sin(2 * mu) * Math.exp(-2 * sd * sd) + 0.6 * sd,
});
const RP_REPEATS = 1000;

function Reparameterization() {
  const [mu, setMu] = useState(0.5);
  const [sd, setSd] = useState(0.8);
  const [n, setN] = useState(10);
  const [c, setC] = useState(0);
  const [wrt, setWrt] = useState<'mu' | 'sd'>('mu');
  const [seed, setSeed] = useState(1);

  const est = useMemo(() => {
    const r = rng(seed);
    const rep: number[] = [],
      score: number[] = [];
    for (let k = 0; k < RP_REPEATS; k++) {
      let a = 0,
        b = 0;
      for (let i = 0; i < n; i++) {
        const e = gauss(r);
        const x = mu + sd * e;
        if (wrt === 'mu') {
          a += rpDf(x); // ∂f[μ + σε]/∂μ = f'[x]
          b += (rpF(x, c) * e) / sd; // f[x]·∂log Pr(x)/∂μ = f[x](x − μ)/σ²
        } else {
          a += rpDf(x) * e; // ∂f[μ + σε]/∂σ = f'[x]·ε
          b += (rpF(x, c) * (e * e - 1)) / sd; // f[x]·∂log Pr(x)/∂σ = f[x]((x − μ)²/σ³ − 1/σ)
        }
      }
      rep.push(a / n);
      score.push(b / n);
    }
    return { rep, score };
  }, [mu, sd, n, c, wrt, seed]);

  const truth = rpTrue(mu, sd)[wrt];
  const sRep = std(est.rep),
    sScore = std(est.score);
  const half = Math.max(4 * sScore, 4 * sRep, 0.2);
  const range: [number, number] = [truth - half, truth + half];
  const hRep = fractionHistogram(est.rep, range[0], range[1], 50);
  const hScore = fractionHistogram(est.score, range[0], range[1], 50);
  const xs = linspace(-4, 4, 241);
  const fs = xs.map((x) => rpF(x, c));
  const fLo = Math.min(...fs),
    fHi = Math.max(...fs);
  const params = wrt === 'mu' ? linspace(-2, 2, 161) : linspace(0.1, 2, 161);
  const curve = params.map((v) => (wrt === 'mu' ? rpExpect(v, sd, c) : rpExpect(mu, v, c)));
  const here = wrt === 'mu' ? mu : sd;
  const eHere = rpExpect(mu, sd, c);
  const cLo = Math.min(...curve),
    cHi = Math.max(...curve);
  const name = wrt === 'mu' ? 'μ' : 'σ';

  const hist = (h: number[], colour: keyof Colours, title: string, s: number, m: number) => (
    <div>
      <b className="small">{title}</b>
      <Plot
        x={range}
        y={[0, Math.max(...h) * 1.1 || 1]}
        height={170}
        xLabel={`estimate of ∂E/∂${name}`}
        ariaLabel={`Histogram of ${RP_REPEATS} gradient estimates: ${title}`}
        draw={(f) => {
          bars(f, range[0], range[1], h, f.c[colour], 0.7);
          f.vline(truth, f.c.ink, []);
        }}
      />
      <p className="dl-caption">
        Mean {fmt(m)}, standard deviation {fmt(s)}. Black line: the true gradient.
      </p>
    </div>
  );

  return (
    <Notebook
      id="17.2"
      title="Reparameterization trick"
      intro={
        <>
          We want the gradient of E[f[x]] with respect to the mean μ and standard deviation σ of x ~ Norm[μ, σ²], here
          with f[x] = sin(2x) + 0.3x² + c. Sampling x is not differentiable, so there are two ways round it. The score
          function estimator averages f[x]·∂log Pr(x)/∂μ and needs only values of f. The reparameterisation trick writes
          x = μ + σε with ε ~ Norm[0, 1], so the randomness no longer depends on μ or σ, and averages ∂f/∂x·∂x/∂μ
          instead. Both are unbiased; each histogram shows {RP_REPEATS} estimates, each from N samples.
        </>
      }
      tryThis={[
        'Compare the two histograms: both centre on the true gradient, but the score function estimates are far more spread out.',
        'Add a constant c to f. The true gradient does not change, and neither does the reparameterised estimate, but the score function variance grows: it multiplies every value of f by a random weight.',
        'Switch to the gradient with respect to σ, and make σ small. The score function weight (ε² − 1)/σ blows up, while the reparameterised estimate stays steady.',
        'Raise N: both standard deviations shrink as 1/√N, but the gap between them stays.',
      ]}
      takeaway="Moving the randomness into a separate input ε lets backpropagation pass through the sampling step, and uses the slope of f rather than only its values. That gives much lower-variance gradients, which is why the VAE's encoder can be trained with it."
    >
      <div className="dl-controls">
        <Chips
          options={[
            { id: 'mu', label: 'Gradient with respect to μ' },
            { id: 'sd', label: 'Gradient with respect to σ' },
          ]}
          value={wrt}
          onChange={setWrt}
        />
        <Slider label="mean μ" value={mu} min={-2} max={2} onChange={setMu} />
        <Slider label="std σ" value={sd} min={0.1} max={2} onChange={setSd} />
        <Slider label="samples N" value={n} min={1} max={100} step={1} onChange={setN} show={(v) => String(v)} />
        <Slider label="constant c" value={c} min={0} max={10} onChange={setC} />
        <button className="btn small" onClick={() => setSeed((v) => v + 1)}>
          New samples
        </button>
      </div>
      <div className="dl-cols">
        <div>
          <Plot
            x={[-4, 4]}
            y={[fLo - 0.5, fHi + 0.5]}
            height={180}
            xLabel="x"
            yLabel="f[x]"
            ariaLabel="The function and the sampling distribution"
            draw={(f) => {
              const pk = normPdf(mu, mu, sd);
              f.ctx.save();
              f.ctx.globalAlpha = 0.25;
              f.ctx.fillStyle = f.c.s1;
              f.ctx.beginPath();
              f.ctx.moveTo(f.x(-4), f.y(fLo - 0.5));
              xs.forEach((x) => f.ctx.lineTo(f.x(x), f.y(fLo - 0.5 + ((fHi - fLo + 1) * normPdf(x, mu, sd)) / pk)));
              f.ctx.lineTo(f.x(4), f.y(fLo - 0.5));
              f.ctx.fill();
              f.ctx.restore();
              f.line(xs, fs, f.c.s3, 2.5);
            }}
          />
          <p className="dl-caption">Green: f[x]. Blue shading: Pr(x|μ, σ), scaled to fit.</p>
        </div>
        <div>
          <Plot
            x={[params[0], params[params.length - 1]]}
            y={[cLo - 0.3, cHi + 0.3]}
            height={180}
            xLabel={name}
            yLabel="E[f[x]]"
            ariaLabel={`The expectation as a function of ${name}, with its tangent`}
            draw={(f) => {
              f.line(params, curve, f.c.s1, 2.5);
              const d = 0.6;
              f.line([here - d, here + d], [eHere - d * truth, eHere + d * truth], f.c.s2, 1.5, [5, 4]);
              f.dots([[here, eHere]], f.c.s2, 5);
            }}
          />
          <p className="dl-caption">The expectation, exact. Dashed: its tangent, whose slope both estimators target.</p>
        </div>
      </div>
      <div className="dl-cols">
        {hist(hScore, 's2', 'Score function (no reparameterisation)', sScore, mean(est.score))}
        {hist(hRep, 's3', 'Reparameterisation trick', sRep, mean(est.rep))}
      </div>
      <Readout
        items={[
          [`true ∂E/∂${name}`, fmt(truth, 4)],
          ['std, score function', fmt(sScore)],
          ['std, reparameterised', fmt(sRep)],
          ['variance ratio', `${fmt((sScore / sRep) ** 2)}×`],
        ]}
      />
    </Notebook>
  );
}

// ---------- 17.3 Importance sampling ----------

/** f[y] = exp(−2(y − a)²): a bump at y = a. */
const isF = (y: number, a: number) => Math.exp(-2 * (y - a) ** 2);
/** E[f[y]] for y ~ Norm[0, 1], in closed form, since the product of two Gaussians is a Gaussian. */
const isTrue = (a: number) => Math.exp((-a * a) / 2.5) / Math.sqrt(5);

/**
 * The variance of one weighted sample f[y]Pr(y)/q(y), y ~ q = Norm[m, s²], by numerical integration of
 * f²Pr²/q minus the mean squared. It is infinite when q's tails are too thin: here, when s² ≤ 0.1.
 */
function isVariance(a: number, m: number, s: number): number {
  if (s * s <= 0.1) return Infinity;
  const steps = 6000,
    lo = -14,
    dy = 28 / steps;
  let m2 = 0;
  for (let i = 0; i <= steps; i++) {
    const y = lo + i * dy;
    const logv =
      -4 * (y - a) ** 2 - y * y - Math.log(2 * Math.PI) + (y - m) ** 2 / (2 * s * s) + Math.log(s * SQRT_2PI);
    m2 += Math.exp(logv) * dy;
  }
  return Math.max(0, m2 - isTrue(a) ** 2);
}

const IS_REPEATS = 600;

function ImportanceSampling() {
  const [a, setA] = useState(2.5);
  const [m, setM] = useState(0);
  const [s, setS] = useState(1);
  const [n, setN] = useState(20);
  const [seed, setSeed] = useState(1);
  const truth = isTrue(a);

  const est = useMemo(() => {
    const r = rng(seed);
    const direct: number[] = [],
      weighted: number[] = [];
    for (let k = 0; k < IS_REPEATS; k++) {
      let d = 0,
        w = 0;
      for (let i = 0; i < n; i++) {
        d += isF(gauss(r), a);
        const y = m + s * gauss(r);
        w += (isF(y, a) * normPdf(y)) / normPdf(y, m, s);
      }
      direct.push(d / n);
      weighted.push(w / n);
    }
    return { direct, weighted };
  }, [a, m, s, n, seed]);

  const sdDirect = Math.sqrt(isVariance(a, 0, 1) / n);
  const sdQ = Math.sqrt(isVariance(a, m, s) / n);
  const spread = Math.max(sdDirect, Number.isFinite(sdQ) ? sdQ : 0, truth * 0.05);
  const range: [number, number] = [Math.max(0, truth - 4 * spread), truth + 4 * spread];
  const hDirect = fractionHistogram(est.direct, range[0], range[1], 50);
  const hQ = fractionHistogram(est.weighted, range[0], range[1], 50);
  const ys = linspace(-3, 6, 361);
  const top = Math.max(1.05, 1.05 / (s * SQRT_2PI));
  const bestM = 0.8 * a,
    bestS = Math.sqrt(0.2);

  const hist = (h: number[], colour: keyof Colours, title: string, values: number[]) => (
    <div>
      <b className="small">{title}</b>
      <Plot
        x={range}
        y={[0, Math.max(...h) * 1.1 || 1]}
        height={170}
        xLabel="estimate of E[f[y]]"
        ariaLabel={`Histogram of ${IS_REPEATS} estimates: ${title}`}
        draw={(f) => {
          bars(f, range[0], range[1], h, f.c[colour], 0.7);
          f.vline(truth, f.c.ink, []);
        }}
      />
      <p className="dl-caption">
        Mean {fmt(mean(values))}, standard deviation {fmt(std(values))}. Black line: the true value.
      </p>
    </div>
  );

  return (
    <Notebook
      id="17.3"
      title="Importance sampling"
      intro={
        <>
          We estimate E[f[y]] with y ~ Pr(y) = Norm[0, 1], where f is a bump at y = a that sits out in the tail.
          Averaging f over samples of Pr(y) wastes most of them, because few land where f is large. Importance sampling
          draws y from a proposal q(y) instead and averages f[y]·Pr(y)/q(y). The weight Pr/q corrects for sampling from
          the wrong distribution, so the estimate stays unbiased; what changes is its variance.
        </>
      }
      tryThis={[
        'Start with q = Pr(y). Move the bump a further out: most estimates are near 0 and a few are large, so the spread is wide compared with the true value.',
        'Press Best proposal: q becomes proportional to f[y]·Pr(y) (dashed). Every weighted sample then equals the true value exactly, and the variance is 0.',
        'Move q past the bump or make it wide. The estimate is still centred on the truth, but noisier than with the best proposal.',
        'Make q narrow (σ below 0.32). The weights Pr/q explode in the tails and the variance becomes infinite: most runs look fine, and a rare one is wildly off.',
      ]}
      takeaway="A good proposal puts samples where f·Pr is large, and must have tails at least as heavy as the target's. In a VAE the target is the posterior Pr(z|x), so the encoder's q(z|x) is the natural proposal for estimating Pr(x)."
    >
      <div className="dl-controls">
        <Slider label="bump position a" value={a} min={0} max={4} onChange={setA} />
        <Slider label="proposal mean" value={m} min={-2} max={5} onChange={setM} />
        <Slider label="proposal std" value={s} min={0.2} max={2} onChange={setS} />
        <Slider label="samples N" value={n} min={1} max={100} step={1} onChange={setN} show={(v) => String(v)} />
      </div>
      <div className="dl-controls">
        <div className="row">
          <button className="btn primary small" onClick={() => (setM(+bestM.toFixed(3)), setS(+bestS.toFixed(4)))}>
            Best proposal
          </button>
          <button className="btn small" onClick={() => (setM(0), setS(1))}>
            q = Pr(y)
          </button>
          <button className="btn small" onClick={() => setSeed((v) => v + 1)}>
            New samples
          </button>
        </div>
      </div>
      <Plot
        x={[-3, 6]}
        y={[0, top]}
        height={200}
        xLabel="y"
        ariaLabel="The target density, the function, the proposal and the best proposal"
        draw={(f) => {
          f.line(
            ys,
            ys.map((y) => normPdf(y, bestM, bestS)),
            f.c.muted,
            1.5,
            [5, 4],
          );
          f.line(
            ys,
            ys.map((y) => normPdf(y)),
            f.c.s1,
            2.5,
          );
          f.line(
            ys,
            ys.map((y) => isF(y, a)),
            f.c.s3,
            2.5,
          );
          f.line(
            ys,
            ys.map((y) => normPdf(y, m, s)),
            f.c.s2,
            2.5,
          );
        }}
      />
      <Legend
        items={[
          ['s1', 'Pr(y)'],
          ['s3', 'f[y]'],
          ['s2', 'proposal q(y)'],
          ['muted', 'best proposal, ∝ f[y]·Pr(y)'],
        ]}
      />
      <div className="dl-cols">
        {hist(hDirect, 's1', 'Sampling from Pr(y)', est.direct)}
        {hist(hQ, 's2', 'Importance sampling from q(y)', est.weighted)}
      </div>
      <Readout
        items={[
          ['true E[f[y]]', fmt(truth, 4)],
          ['exact std, sampling Pr(y)', fmt(sdDirect)],
          ['exact std, sampling q(y)', show(sdQ)],
          ['variance reduction', Number.isFinite(sdQ) ? (sdQ < 1e-9 ? '∞' : `${fmt((sdDirect / sdQ) ** 2)}×`) : '0×'],
        ]}
      />
    </Notebook>
  );
}

export const CHAPTERS: ChapterDef[] = [
  {
    n: 15,
    title: 'Generative adversarial networks',
    blurb:
      'A generator learns to make samples that a discriminator cannot tell from real data, and the distance between distributions decides whether it gets a useful signal.',
    notebooks: [
      { id: '15.1', title: 'GAN toy example', Component: GanToy },
      { id: '15.2', title: 'Wasserstein distance', Component: Wasserstein },
    ],
  },
  {
    n: 16,
    title: 'Normalizing flows',
    blurb:
      'Invertible functions that reshape a normal distribution, with an exact likelihood from the change of variables.',
    notebooks: [
      { id: '16.1', title: '1D normalizing flows', Component: NormalizingFlow1D },
      { id: '16.2', title: 'Autoregressive flows', Component: AutoregressiveFlow },
      { id: '16.3', title: 'Contraction mappings', Component: ContractionMappings },
    ],
  },
  {
    n: 17,
    title: 'Variational autoencoders',
    blurb:
      'Latent variable models, and the sampling tricks that make them trainable: reparameterisation and importance sampling.',
    notebooks: [
      { id: '17.1', title: 'Latent variable models', Component: LatentVariables },
      { id: '17.2', title: 'Reparameterization trick', Component: Reparameterization },
      { id: '17.3', title: 'Importance sampling', Component: ImportanceSampling },
    ],
  },
];
