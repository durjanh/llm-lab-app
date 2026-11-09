/* Chapters 15 to 21 of "Understanding Deep Learning": GANs, flows, VAEs, diffusion, reinforcement learning, why deep
   learning works, and ethics. Three small demos cover what the /deep-learning notebooks do not: classifier-free
   guidance, policy-gradient training with a KL penalty, and parameters per training example. */
import { useMemo, useState } from 'react';
import { clamp, gauss, linspace, mean, rng, softmax } from '../deep-learning/kit';
import { Chips, Readout, Slider } from '../deep-learning/Notebook';
import { Plot, type Frame } from '../deep-learning/Plot';
import type { BookChapter } from './types';

/* ---------- shared helpers ---------- */

function Legend({ items }: { items: [string, string, boolean?][] }) {
  return (
    <div className="dl-legend">
      {items.map(([colour, label, dashed]) => (
        <span key={label}>
          <i
            style={
              dashed
                ? { background: `repeating-linear-gradient(90deg, ${colour} 0 4px, transparent 4px 7px)` }
                : { background: colour }
            }
          />
          {label}
        </span>
      ))}
    </div>
  );
}

/** Densities of `xs` in equal bins over [lo, hi], so the bars integrate to 1 like a density curve. */
function histogram(xs: ArrayLike<number>, lo: number, hi: number, bins: number): number[] {
  const out = Array(bins).fill(0) as number[];
  const w = (hi - lo) / bins;
  for (let i = 0; i < xs.length; i++) {
    const k = Math.floor((xs[i] - lo) / w);
    if (k >= 0 && k < bins) out[k]++;
  }
  return out.map((c) => c / (xs.length * w));
}

/** Draws a histogram as translucent bars. */
function drawHist(f: Frame, dens: number[], lo: number, hi: number, colour: string, alpha = 0.45) {
  const { ctx } = f;
  const w = (hi - lo) / dens.length;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = colour;
  dens.forEach((d, i) => {
    if (d <= 0) return;
    const x0 = f.x(lo + i * w);
    const x1 = f.x(lo + (i + 1) * w);
    const y1 = f.y(d);
    ctx.fillRect(x0, y1, Math.max(1, x1 - x0 - 1), f.y(0) - y1);
  });
  ctx.restore();
}

/** A thin, see-through line, for individual runs behind their average. */
function faint(f: Frame, xs: number[], ys: number[], colour: string, alpha = 0.22) {
  f.ctx.save();
  f.ctx.globalAlpha = alpha;
  f.line(xs, ys, colour, 1);
  f.ctx.restore();
}

/* ---------- 18.6d Classifier-free guidance ---------- */

/** One normal bump in a mixture: [weight, mean, standard deviation]. */
type Bump = [number, number, number];
type GuideClass = 'a' | 'b';

// Class A has a large bump and a smaller one that sits nearer to class B; class B is one wider bump.
const GUIDE: Record<GuideClass, Bump[]> = {
  a: [
    [0.6, -2.2, 0.35],
    [0.4, -0.6, 0.35],
  ],
  b: [[1, 0.9, 0.6]],
};
const GUIDE_ALL: Bump[] = [...GUIDE.a, ...GUIDE.b].map(([w, m, s]) => [w / 2, m, s]);
const GUIDE_N = 2000;
const GUIDE_STEPS = 50;
const GX = linspace(-4, 4, 321);

/** Cosine noise schedule: the share of signal left at time t in [0, 1]. */
const alphaBar = (t: number) => Math.max(1e-4, Math.cos(((t + 0.008) / 1.008) * (Math.PI / 2)) ** 2);

/**
 * The ideal noise prediction for data drawn from a mixture of normals. At noise level ᾱ each bump is still normal,
 * so the score ∂log q(z)/∂z has a closed form, and ε̂ = −√(1 − ᾱ)·score. A trained network would approximate this.
 */
function epsHat(z: number, ab: number, bumps: Bump[]): number {
  const s = Math.sqrt(ab);
  let top = -Infinity;
  for (const [w, m, sd] of bumps) {
    const v = ab * sd * sd + 1 - ab;
    top = Math.max(top, Math.log(w) - 0.5 * Math.log(v) - (z - s * m) ** 2 / (2 * v));
  }
  let num = 0;
  let den = 0;
  for (const [w, m, sd] of bumps) {
    const v = ab * sd * sd + 1 - ab;
    const r = Math.exp(Math.log(w) - 0.5 * Math.log(v) - (z - s * m) ** 2 / (2 * v) - top);
    num += (r * -(z - s * m)) / v;
    den += r;
  }
  return -Math.sqrt(1 - ab) * (num / den);
}

/** Deterministic DDIM sampling with the guided noise estimate (1 + w)·ε̂(z | c) − w·ε̂(z). */
function guidedSamples(cond: Bump[], w: number): Float64Array {
  const rand = rng(7);
  const ts = linspace(0.995, 0, GUIDE_STEPS + 1);
  const out = new Float64Array(GUIDE_N);
  for (let i = 0; i < GUIDE_N; i++) {
    let z = gauss(rand);
    for (let k = 0; k < GUIDE_STEPS; k++) {
      const at = alphaBar(ts[k]);
      const as = alphaBar(ts[k + 1]);
      const e = (1 + w) * epsHat(z, at, cond) - w * epsHat(z, at, GUIDE_ALL);
      // Clip the predicted clean value, then use the noise consistent with it, so strong guidance cannot overshoot.
      const x0 = clamp((z - Math.sqrt(1 - at) * e) / Math.sqrt(at), -5, 5);
      z = Math.sqrt(as) * x0 + Math.sqrt(1 - as) * ((z - Math.sqrt(at) * x0) / Math.sqrt(1 - at));
    }
    out[i] = z;
  }
  return out;
}

function mixDensity(x: number, bumps: Bump[]): number {
  let p = 0;
  for (const [w, m, s] of bumps) p += (w / (s * Math.sqrt(2 * Math.PI))) * Math.exp(-((x - m) ** 2) / (2 * s * s));
  return p;
}

function moments(bumps: Bump[]): [number, number] {
  const m = bumps.reduce((a, [w, mu]) => a + w * mu, 0);
  const sq = bumps.reduce((a, [w, mu, s]) => a + w * (s * s + mu * mu), 0);
  return [m, Math.sqrt(sq - m * m)];
}

function GuidanceDemo() {
  const [cls, setCls] = useState<GuideClass>('a');
  const [w, setW] = useState(1);
  const samples = useMemo(() => guidedSamples(GUIDE[cls], w), [cls, w]);

  const other: GuideClass = cls === 'a' ? 'b' : 'a';
  const truth = GX.map((x) => mixDensity(x, GUIDE[cls]));
  const otherD = GX.map((x) => mixDensity(x, GUIDE[other]));
  // Guidance aims at p(x | c)·p(c | x)^w: the class density, sharpened wherever a classifier is unsure.
  const raw = GX.map((x, i) => truth[i] * ((0.5 * truth[i]) / Math.max(mixDensity(x, GUIDE_ALL), 1e-300)) ** w);
  const area = raw.reduce((a, v) => a + v, 0) * (GX[1] - GX[0]);
  const tilt = raw.map((v) => v / area);
  const hist = histogram(samples, -4, 4, 64);
  const top = 1.1 * Math.max(...hist, ...truth, ...tilt);

  const xs = Array.from(samples);
  const m = mean(xs);
  const sd = Math.sqrt(mean(xs.map((v) => (v - m) ** 2)));
  const [tm, tsd] = moments(GUIDE[cls]);
  const minor = xs.filter((v) => v > -1.4).length / xs.length;
  const readout: [string, string][] = [
    [`sample mean (class: ${tm.toFixed(2)})`, m.toFixed(2)],
    [`sample spread (class: ${tsd.toFixed(2)})`, sd.toFixed(2)],
  ];
  if (cls === 'a') readout.push(['share in the smaller bump (class: 40%)', `${(100 * minor).toFixed(0)}%`]);

  return (
    <div className="dl-body">
      <div className="dl-controls">
        <Chips
          options={[
            { id: 'a', label: 'condition on class A' },
            { id: 'b', label: 'condition on class B' },
          ]}
          value={cls}
          onChange={setCls}
        />
        <Slider label="guidance weight w" value={w} min={0} max={8} step={0.5} onChange={setW} />
      </div>
      <Plot
        x={[-4, 4]}
        y={[0, top]}
        height={250}
        xLabel="x"
        ariaLabel="Histogram of guided samples against the class density and the density guidance aims at"
        draw={(f) => {
          drawHist(f, hist, -4, 4, f.c.s1);
          f.line(GX, otherD, f.c.muted, 1.5, [2, 4]);
          f.line(GX, truth, f.c.ink, 2, [6, 4]);
          f.line(GX, tilt, f.c.s2, 2);
        }}
      />
      <Legend
        items={[
          ['var(--s1)', `${GUIDE_N.toLocaleString()} guided samples`],
          ['var(--ink)', 'class density p(x | c)', true],
          ['var(--s2)', 'p(x | c)·p(c | x)^w, what guidance aims at'],
          ['var(--muted)', 'the other class', true],
        ]}
      />
      <Readout items={readout} />
      <p className="dl-caption">
        The data are two classes in one dimension. No network is trained: for a mixture of normals the ideal noise
        predictor has a closed form, with and without the class, so this is what a perfectly trained model would do.
        Sampling uses {GUIDE_N.toLocaleString()} deterministic DDIM paths of {GUIDE_STEPS} steps from the same seeded
        noise. With w = 0 the samples match the class. As w grows they crowd into the region that is most clearly that
        class: class A loses most of its smaller bump, which lies near class B, and both classes get narrower and move
        apart. The sampler reaches the solid target curve only approximately.
      </p>
    </div>
  );
}

/* ---------- 19.5b Policy gradients with a baseline and a KL penalty ---------- */

const PG_PASS = [0.2, 0.45, 0.85, 0.3];
const PG_REF = [0.4, 0.3, 0.1, 0.2];
const PG_STEPS = 200;
const PG_SEEDS = 12;
const PG_X = Array.from({ length: PG_STEPS + 1 }, (_, i) => i);

type PgMethod = 'none' | 'mean' | 'grpo';
const PG_METHODS: { id: PgMethod; label: string; colour: string }[] = [
  { id: 'none', label: 'no baseline', colour: 's2' },
  { id: 'mean', label: 'group mean', colour: 's1' },
  { id: 'grpo', label: 'group mean ÷ spread (GRPO)', colour: 's3' },
];

function pick(p: number[], rand: () => number): number {
  let u = rand();
  for (let k = 0; k < p.length - 1; k++) {
    u -= p[k];
    if (u < 0) return k;
  }
  return p.length - 1;
}

const expectedPass = (pi: number[]) => pi.reduce((a, p, k) => a + p * PG_PASS[k], 0);
const klToRef = (pi: number[]) => pi.reduce((a, p, k) => a + (p > 0 ? p * Math.log(p / PG_REF[k]) : 0), 0);

interface PgSettings {
  lr: number;
  group: number;
  beta: number;
  offset: number;
}

/**
 * REINFORCE on one prompt with four possible answers. Each step samples a group of answers, a checker passes each
 * with its own probability (reward 1 or 0, plus an offset), and the softmax logits move along the sampled
 * policy gradient minus the exact gradient of β·KL(π ‖ π_ref).
 */
function trainPolicy(method: PgMethod, s: PgSettings, seed: number): { curve: number[]; pi: number[] } {
  const rand = rng(seed);
  const theta = PG_REF.map(Math.log);
  const curve: number[] = [];
  const acts = new Int32Array(s.group);
  const rew = new Float64Array(s.group);
  for (let step = 0; ; step++) {
    const pi = softmax(theta);
    curve.push(expectedPass(pi));
    if (step === PG_STEPS) return { curve, pi };
    let m = 0;
    for (let i = 0; i < s.group; i++) {
      acts[i] = pick(pi, rand);
      rew[i] = (rand() < PG_PASS[acts[i]] ? 1 : 0) + s.offset;
      m += rew[i];
    }
    m /= s.group;
    let v = 0;
    for (let i = 0; i < s.group; i++) v += (rew[i] - m) ** 2;
    const sd = Math.sqrt(v / s.group);
    const grad = [0, 0, 0, 0];
    for (let i = 0; i < s.group; i++) {
      const adv = method === 'none' ? rew[i] : method === 'mean' ? rew[i] - m : sd > 1e-9 ? (rew[i] - m) / sd : 0;
      // ∂log π(a)/∂θ_k for a softmax policy is 1[a = k] − π_k.
      for (let k = 0; k < 4; k++) grad[k] += (adv * ((acts[i] === k ? 1 : 0) - pi[k])) / s.group;
    }
    if (s.beta > 0) {
      const kl = klToRef(pi);
      for (let k = 0; k < 4; k++) grad[k] -= s.beta * pi[k] * (Math.log(pi[k] / PG_REF[k]) - kl);
    }
    for (let k = 0; k < 4; k++) theta[k] += s.lr * grad[k];
  }
}

function PolicyGradientDemo() {
  const [lr, setLr] = useState(0.5);
  const [group, setGroup] = useState(8);
  const [beta, setBeta] = useState(0.05);
  const [offset, setOffset] = useState(1);
  const [shown, setShown] = useState<PgMethod>('grpo');

  const runs = useMemo(() => {
    const s: PgSettings = { lr, group, beta, offset };
    const out = {} as Record<PgMethod, { curve: number[]; pi: number[] }[]>;
    for (const { id } of PG_METHODS) out[id] = Array.from({ length: PG_SEEDS }, (_, r) => trainPolicy(id, s, 101 + r));
    return out;
  }, [lr, group, beta, offset]);

  const avgCurve = (id: PgMethod) => PG_X.map((i) => mean(runs[id].map((r) => r.curve[i])));
  const finals = (id: PgMethod) => runs[id].map((r) => r.curve[PG_STEPS]);
  const spread = (xs: number[]) => {
    const m = mean(xs);
    return Math.sqrt(mean(xs.map((v) => (v - m) ** 2)));
  };
  const avgPi = PG_REF.map((_, k) => mean(runs[shown].map((r) => r.pi[k])));
  const best = PG_PASS.indexOf(Math.max(...PG_PASS));
  const optimum =
    beta > 0 ? softmax(PG_REF.map((p, k) => Math.log(p) + PG_PASS[k] / beta)) : PG_PASS.map((_, k) => +(k === best));

  return (
    <div className="dl-body">
      <div className="dl-controls">
        <Slider label="learning rate" value={lr} min={0.05} max={2} step={0.05} onChange={setLr} />
        <Slider label="group size G" value={group} min={2} max={16} step={1} onChange={setGroup} />
        <Slider label="KL weight β" value={beta} min={0} max={0.5} step={0.01} onChange={setBeta} />
        <Slider label="reward offset" value={offset} min={0} max={3} step={0.25} onChange={setOffset} />
      </div>
      <div className="dl-controls">
        <span className="small muted">Show single runs for:</span>
        <Chips options={PG_METHODS.map(({ id, label }) => ({ id, label }))} value={shown} onChange={setShown} />
      </div>
      <div className="dl-cols">
        <div>
          <Plot
            x={[0, PG_STEPS]}
            y={[0, 1]}
            height={250}
            xLabel="update step"
            yLabel="chance the answer passes"
            ariaLabel="Expected pass rate of the policy during training, for three baselines"
            draw={(f) => {
              const col = (c: string) => (f.c as unknown as Record<string, string>)[c];
              const shownColour = col(PG_METHODS.find((p) => p.id === shown)?.colour ?? 's1');
              for (const r of runs[shown]) faint(f, PG_X, r.curve, shownColour);
              for (const p of PG_METHODS) f.line(PG_X, avgCurve(p.id), col(p.colour), 2.5);
              f.hline(expectedPass(optimum), f.c.ink, [5, 4]);
              f.hline(expectedPass(PG_REF), f.c.muted, [2, 4]);
            }}
          />
          <Legend
            items={[
              ...PG_METHODS.map((p): [string, string] => [`var(--${p.colour})`, `${p.label} (average of ${PG_SEEDS})`]),
              ['var(--ink)', beta > 0 ? 'KL optimum for rewards of 1 and 0' : 'best answer always', true],
              ['var(--muted)', 'reference policy', true],
            ]}
          />
        </div>
        <div className="dl-scroll">
          <table className="dl-table">
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>baseline</th>
                <th>pass rate at end</th>
                <th>spread over runs</th>
                <th>KL to reference</th>
              </tr>
            </thead>
            <tbody>
              {PG_METHODS.map((p) => (
                <tr key={p.id}>
                  <th style={{ textAlign: 'left' }}>{p.label}</th>
                  <td>{mean(finals(p.id)).toFixed(3)}</td>
                  <td>{spread(finals(p.id)).toFixed(3)}</td>
                  <td>{mean(runs[p.id].map((r) => klToRef(r.pi))).toFixed(3)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <table className="dl-table" style={{ marginTop: 10 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>answer</th>
                <th>passes</th>
                <th>reference π</th>
                <th>trained π</th>
                <th>KL optimum</th>
              </tr>
            </thead>
            <tbody>
              {PG_PASS.map((p, k) => (
                <tr key={k}>
                  <th style={{ textAlign: 'left' }}>{'ABCD'[k]}</th>
                  <td>{p.toFixed(2)}</td>
                  <td>{PG_REF[k].toFixed(2)}</td>
                  <td>{avgPi[k].toFixed(2)}</td>
                  <td>{optimum[k].toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <p className="dl-caption">
        One prompt, four ways to answer it, and a checker that passes each answer with the probability shown: a
        verifiable reward of 1 or 0, as in reasoning-model training. Every run starts from the same reference policy,
        which prefers the weaker answers. &quot;Trained π&quot; averages the {PG_SEEDS} runs of the method picked above.
        The KL optimum is the exact best policy for reward minus β·KL, π* ∝ π_ref·exp(pass rate / β), the closed form
        that DPO is built on; the offset cancels out of it. Raise the offset and the run without a baseline gets much
        noisier, because every sampled answer is pushed up whatever its result; the baselines remove the offset. Raise β
        to 0.2 and GRPO settles above the KL optimum: dividing by the group&apos;s spread (about 0.4 for pass-or-fail
        rewards) scales its rewards up, so the same β holds it back less. Set β to 0 and the policy is free to move all
        its mass to answer C.
      </p>
    </div>
  );
}

/* ---------- 20.2c Parameters per training example ---------- */

interface Scale {
  name: string;
  params: number;
  examples: number;
  text: boolean;
  /** Augmented copies per training image, where the book gives a number. */
  aug?: number;
}

// Counts as the book gives them (MNIST-1D, AlexNet, VGG-19, ResNet-50, GPT-3) or as each model's paper reports them.
const SCALES: Scale[] = [
  { name: 'MNIST-1D net (book)', params: 177_201, examples: 10_000, text: false },
  { name: 'AlexNet (book)', params: 60e6, examples: 1e6, text: false, aug: 2048 },
  { name: 'VGG-19 (book)', params: 138e6, examples: 1.28e6, text: false },
  { name: 'ResNet-50 (book)', params: 25.6e6, examples: 1.28e6, text: false },
  { name: 'GPT-3 (book)', params: 175e9, examples: 300e9, text: true },
  { name: 'Chinchilla', params: 70e9, examples: 1.4e12, text: true },
  { name: 'Llama 2 70B', params: 70e9, examples: 2e12, text: true },
  { name: 'Llama 3 8B', params: 8e9, examples: 15e12, text: true },
];
const SEQ_LEN = 2048;

function count(n: number): string {
  const units: [number, string][] = [
    [1e12, 'T'],
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'k'],
  ];
  for (const [u, s] of units) if (n >= u) return `${+(n / u).toPrecision(3)}${s}`;
  return String(Math.round(n));
}

function ParamCountDemo() {
  const [unit, setUnit] = useState<'token' | 'seq'>('token');
  const [aug, setAug] = useState<'no' | 'yes'>('no');
  const rows = SCALES.map((s) => {
    const ex = s.text
      ? unit === 'seq'
        ? s.examples / SEQ_LEN
        : s.examples
      : s.examples * (aug === 'yes' ? (s.aug ?? 1) : 1);
    return { ...s, ex, ratio: s.params / ex };
  });
  const chinchilla = Math.log10(unit === 'seq' ? SEQ_LEN / 20 : 1 / 20);
  const n = rows.length;

  return (
    <div className="dl-body">
      <div className="dl-controls">
        <Chips
          options={[
            { id: 'token', label: 'a text example is one token' },
            { id: 'seq', label: `a text example is a ${SEQ_LEN.toLocaleString()}-token passage` },
          ]}
          value={unit}
          onChange={setUnit}
        />
        <Chips
          options={[
            { id: 'no', label: 'count images once' },
            { id: 'yes', label: "count AlexNet's 2,048 augmentations" },
          ]}
          value={aug}
          onChange={setAug}
        />
      </div>
      <div className="dl-cols">
        <div>
          <Plot
            x={[-4.6, 4.6]}
            y={[-0.7, n]}
            height={n * 30 + 34}
            axes={false}
            ariaLabel="Parameters per training example on a log scale, for image models and language models"
            draw={(f) => {
              const { ctx } = f;
              for (let p = -4; p <= 4; p++) {
                f.vline(p, p === 0 ? f.c.ink2 : f.c.line, p === 0 ? [] : [2, 3]);
                f.text(p === 0 ? '1' : `10^${p}`, p, -0.55, f.c.muted, 'center');
              }
              rows.forEach((r, i) => {
                const yc = n - i - 0.5;
                const v = clamp(Math.log10(r.ratio), -4.5, 4.5);
                ctx.fillStyle = r.text ? f.c.s1 : f.c.s3;
                const x0 = f.x(Math.min(0, v));
                ctx.fillRect(x0, f.y(yc + 0.3), Math.abs(f.x(v) - f.x(0)), f.y(yc - 0.3) - f.y(yc + 0.3));
                f.text(r.name, v >= 0 ? -0.12 : 0.12, yc - 0.12, f.c.ink2, v >= 0 ? 'right' : 'left');
              });
              f.vline(chinchilla, f.c.s2, [6, 4]);
            }}
          />
          <Legend
            items={[
              ['var(--s3)', 'image and toy models'],
              ['var(--s1)', 'language models'],
              ['var(--s2)', '≈20 tokens per parameter (Chinchilla)', true],
            ]}
          />
        </div>
        <div className="dl-scroll">
          <table className="dl-table">
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>model</th>
                <th>parameters</th>
                <th>training examples</th>
                <th>parameters per example</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.name}>
                  <th style={{ textAlign: 'left' }}>{r.name}</th>
                  <td>{count(r.params)}</td>
                  <td>{count(r.ex)}</td>
                  <td>{r.ratio >= 1 ? r.ratio.toPrecision(3) : `1/${(1 / r.ratio).toPrecision(3)}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <p className="dl-caption">
        Bars to the right of the solid line have more parameters than training examples, which is where the book finds
        almost every state-of-the-art image model. Counted per token, language models sit well to the left: a
        compute-optimal model sees about twenty tokens per parameter, and smaller models served at scale are trained on
        far more. Whether that makes them underparameterised depends on the unit. A token carries much less information
        than an image, and an LLM usually sees each token about once, while an image model sees each image for many
        epochs. Llama 3 8B is shown with 15T tokens; Meta reports a little over that.
      </p>
    </div>
  );
}

/* ---------- the chapters ---------- */

export const CHAPTERS: BookChapter[] = [
  {
    n: 15,
    title: 'Generative adversarial networks',
    offers: (
      <p>
        How to train a generator without ever writing down a probability. A second network, the discriminator, tries to
        tell real data from generated data, and its gradient is the only thing that teaches the generator. The chapter
        explains why this game is hard to win, what its loss really measures, and the run of fixes and architectures
        (the Wasserstein loss, progressive growing, conditioning, StyleGAN) that made GAN images photographic.
      </p>
    ),
    examples: [
      {
        id: '15.1a',
        title: 'A 1D GAN that slides its samples',
        page: 277,
        notebooks: ['15.1'],
        shows: (
          <>
            The smallest possible generator, x* = z + θ, starts at θ = 3.0 with its samples to the left of the real
            data. The discriminator is a sigmoid that scores how real a point looks. Each round, the generator moves θ
            towards where the sigmoid is high, then the discriminator is refitted. As the two sets overlap the sigmoid
            flattens, so the push on θ fades. At the end the discriminator is at chance and is thrown away.
          </>
        ),
      },
      {
        id: '15.1b',
        title: 'The GAN loss as a minimax game',
        page: 278,
        notebooks: ['15.1'],
        shows: (
          <>
            The discriminator minimises binary cross-entropy with real examples labelled 1 and generated ones 0. The
            generator maximises that same quantity, so the problem is a saddle point (a Nash equilibrium), not a
            minimum. In practice it is split into two losses and the two networks take turns with gradient steps.
          </>
        ),
      },
      {
        id: '15.1c',
        title: 'DCGAN, and mode dropping and collapse',
        page: 279,
        shows: (
          <>
            An early image GAN: a 100-dimensional latent becomes a 4×4×1024 tensor, and transposed convolutions double
            the resolution up to a 64×64 colour image squashed by tanh. It only trained reliably with a specific recipe
            (strided convolutions, BatchNorm in most layers, leaky ReLU in the discriminator, Adam with low momentum).
            The typical failures are named here: mode dropping, where whole kinds of image never appear, and mode
            collapse, where the generator ignores z and makes nearly the same image every time.
          </>
        ),
      },
      {
        id: '15.2a',
        title: 'What the loss measures: Jensen–Shannon divergence',
        page: 282,
        shows: (
          <>
            With the best possible discriminator, Pr(real | x) = Pr(x) / (Pr(x*) + Pr(x)), and the loss becomes the
            Jensen–Shannon divergence between generated and real distributions. The book splits it into a quality term
            (no samples where there is no data) and a coverage term (samples wherever there is data). The generator only
            feels the first, which explains why it is content to make a subset of the data well.
          </>
        ),
      },
      {
        id: '15.2b',
        title: 'Vanishing gradients when the discriminator wins',
        page: 283,
        shows: (
          <>
            Real images and generated images both lie on thin, low-dimensional surfaces, so they may not overlap at all.
            Then the discriminator separates them perfectly, its sigmoid is flat where the samples are, and the
            generator gets almost no gradient. An experiment that freezes a DCGAN generator and keeps training the
            discriminator shows the generator&apos;s gradient falling by orders of magnitude.
          </>
        ),
      },
      {
        id: '15.2c',
        title: 'Earth mover’s distance on discrete bins',
        page: 284,
        notebooks: ['15.2'],
        shows: (
          <>
            The Wasserstein distance is the least work, mass times distance moved, needed to reshape one histogram into
            another. It is a linear program over a transport plan P whose rows sum to one distribution and columns to
            the other. Its dual maximises Σ Pr(i)·f<sub>i</sub> − Σ q(j)·f<sub>j</sub> with neighbouring f values never
            more than one apart. Unlike the JS divergence, it keeps shrinking smoothly as two distributions approach,
            even when they do not overlap.
          </>
        ),
      },
      {
        id: '15.2d',
        title: 'The Wasserstein GAN loss',
        page: 286,
        notebooks: ['15.2'],
        shows: (
          <>
            In the continuous case the dual says: find the function f with slope at most 1 everywhere that best
            separates the two distributions in mean. A network plays f, now a critic with an unbounded score rather than
            a probability. Its slope limit is enforced by clipping weights to a small range such as ±0.01, or by the
            gradient penalty of WGAN-GP. The result is a training signal that does not vanish.
          </>
        ),
      },
      {
        id: '15.3',
        title: 'Progressive growing, minibatch discrimination and truncation',
        page: 287,
        shows: (
          <>
            Three tricks for quality. Progressive growing trains at 4×4 first and fades in layers for each higher
            resolution. Minibatch discrimination lets the critic see statistics of a whole batch, so it can punish a
            generator whose samples are all alike. Truncation draws z only from near the centre of its distribution,
            giving up variety for typical, cleaner samples: the image counterpart of lowering an LLM&apos;s temperature.
            Moving smoothly through z gives plausible interpolations, but only over short distances.
          </>
        ),
      },
      {
        id: '15.4',
        title: 'Conditional GAN, ACGAN and InfoGAN',
        page: 289,
        shows: (
          <>
            Three ways to control what is generated. A conditional GAN feeds an attribute vector c to both networks. An
            auxiliary classifier GAN makes the discriminator also predict the class, with C + 1 outputs. InfoGAN invents
            its own attributes and asks the discriminator to recover them, so they end up meaning the most salient
            factors in the data; on MNIST, digit identity, slant and stroke width.
          </>
        ),
      },
      {
        id: '15.5a',
        title: 'Pix2Pix: translating paired images',
        page: 292,
        shows: (
          <>
            A U-Net maps one image to another (grey to colour, map to satellite photo), trained with an ℓ1 loss to the
            true output plus a discriminator that judges (input, output) pairs. Because the ℓ1 loss already fixes the
            layout, the discriminator only needs to judge local texture, so it scores patches (PatchGAN). Noise added to
            the input was simply ignored by the network.
          </>
        ),
      },
      {
        id: '15.5b',
        title: 'Adversarial loss and SRGAN',
        page: 293,
        shows: (
          <>
            Any supervised model can gain an adversarial term that penalises outputs a discriminator can tell from real
            ones. The super-resolution GAN combines a pixel loss, a perceptual loss on VGG features and an adversarial
            loss, so upscaled images look sharp rather than blurred. The book notes the trade: outputs look more real,
            but need not score better on the original loss.
          </>
        ),
      },
      {
        id: '15.5c',
        title: 'CycleGAN: translating without pairs',
        page: 293,
        shows: (
          <>
            With photos and Monet paintings but no matched pairs, two translators are trained together. A cycle loss
            demands that photo → painting → photo returns the original, adversarial losses make each translation look
            like its target domain, and content losses keep the layout.
          </>
        ),
      },
      {
        id: '15.6',
        title: 'StyleGAN',
        page: 296,
        shows: (
          <>
            The generator starts from a learned constant (4×4×512) rather than from z. Per-layer noise, scaled per
            channel, supplies unimportant detail such as exact hair placement. The style latent goes through a
            seven-layer fully connected network to an intermediate w, which sets each channel&apos;s mean and variance
            (adaptive instance normalisation) at every scale. Early layers control pose and face shape; late layers
            control colour and fine texture.
          </>
        ),
      },
    ],
    inLlms: (
      <p>
        GANs are not how text models are trained. Picking a discrete token is not differentiable, so a
        discriminator&apos;s gradient cannot flow back into the generator, and text GANs had to fall back on policy
        gradients (chapter 19). But one network judging another runs all through LLM work. A <b>reward model</b> in RLHF
        is a learned judge whose score the policy is pushed to raise, and like a GAN generator the policy can learn to
        exploit the judge&apos;s blind spots. <b>LLM-as-a-judge</b> evaluation and automated red teaming are
        discriminator ideas. Truncation is the image version of temperature and top-p sampling. In image generation,
        adversarial losses live on inside the autoencoders of latent diffusion models and in samplers distilled to a few
        steps.
      </p>
    ),
    next: [
      <>
        <b>SeqGAN</b> (Yu et al., 2017) trained a text GAN by treating the generator as a policy and the
        discriminator&apos;s score as its reward, the route RLHF later took with a reward model trained on human
        preferences.
      </>,
      <>
        <b>ELECTRA</b> (Clark et al., 2020) pre-trains an encoder as a discriminator that spots tokens swapped in by a
        small generator. It is GAN-shaped but not adversarial, and the authors found it more compute-efficient than
        masked-language-model pre-training.
      </>,
      <>
        <b>Adversarial Diffusion Distillation</b> (Sauer et al., 2023), behind SDXL Turbo, uses a GAN discriminator to
        compress a diffusion model into one to four sampling steps.
      </>,
      <>
        <b>GigaGAN</b> (Kang et al., 2023) scaled a GAN up for text-to-image generation, keeping the GAN&apos;s
        single-pass sampling speed.
      </>,
      <>
        <b>Red teaming language models with language models</b> (Perez et al., 2022) sets one model to find prompts that
        make another misbehave: the adversarial game, played with words.
      </>,
    ],
    labs: [
      ['/image-generation', 'Image generation'],
      ['/preference-tuning', 'Preference tuning'],
      ['/deep-learning', 'Deep learning notebooks'],
    ],
  },
  {
    n: 16,
    title: 'Normalizing flows',
    offers: (
      <p>
        A generative model with an exact likelihood. Push a normal distribution through an invertible network and keep
        track of how much each layer stretches space. The chapter builds this from one dimension, lists what an
        invertible layer must provide, and works through the main layer types (linear, elementwise, coupling,
        autoregressive and residual) up to the GLOW image model.
      </p>
    ),
    examples: [
      {
        id: '16.1a',
        title: 'A 1D flow: stretching thins the density',
        page: 304,
        notebooks: ['16.1'],
        shows: (
          <>
            A normal z passes through a function x = f[z]. Where f is steep, a little probability is spread over a wide
            range of x, so the density falls; where f is shallow it piles up. Exactly: Pr(x) = |∂f/∂z|⁻¹ · Pr(z).
            Sampling uses f; measuring a likelihood needs the inverse z = f⁻¹[x], the &quot;normalising&quot; direction.
          </>
        ),
      },
      {
        id: '16.1b',
        title: 'Training a flow by maximum likelihood',
        page: 307,
        notebooks: ['16.1'],
        shows: (
          <>
            Map each training point back to its z, then minimise Σ (log|∂f/∂z| − log Pr(z<sub>i</sub>)). The first term
            penalises stretching, the second rewards landing where the base density is high. No bound or approximation
            is involved.
          </>
        ),
      },
      {
        id: '16.2',
        title: 'Deep flows and what each layer must provide',
        page: 307,
        shows: (
          <>
            A deep flow is a chain of invertible layers, inverted in reverse order, and its Jacobian determinant is the
            product of the layers&apos; determinants. That gives four requirements: the layers together must be
            expressive, each must be invertible, the inverse must be cheap, and so must the determinant. The rest of the
            chapter is a tour of layers that meet them.
          </>
        ),
      },
      {
        id: '16.3a',
        title: 'Linear and elementwise flows',
        page: 310,
        shows: (
          <>
            A general linear layer costs O(D³) to invert; writing it as permutation × lower-triangular × (diagonal +
            upper-triangular) brings this to O(D²) with a log-determinant read off the diagonals. But a linear map of a
            normal is still normal. Elementwise flows add nonlinearity, for example a monotone piecewise-linear map on
            [0, 1] whose K slopes sum to one, but cannot create correlations between dimensions on their own.
          </>
        ),
      },
      {
        id: '16.3b',
        title: 'Coupling flows',
        page: 311,
        shows: (
          <>
            Split the input in two. Copy the first half; transform the second half elementwise, with parameters computed
            from the first half by any network at all, invertible or not. Inverting is easy because the first half is
            still known, and the Jacobian is triangular. Permuting the variables between layers lets every variable
            eventually affect every other.
          </>
        ),
      },
      {
        id: '16.3c',
        title: 'Autoregressive and inverse autoregressive flows',
        page: 313,
        notebooks: ['16.2'],
        shows: (
          <>
            Each output dimension is transformed with parameters that depend on all earlier input dimensions. A masked
            network computes every dimension at once in one direction, the same trick as masked self-attention, but the
            other direction must go one dimension at a time. A masked autoregressive flow is fast to train and slow to
            sample; the inverse version is the opposite. A trained teacher of the first kind can train a student of the
            second to get both.
          </>
        ),
      },
      {
        id: '16.3d',
        title: 'Residual flows: iRevNet and iResNet',
        page: 314,
        notebooks: ['16.3'],
        shows: (
          <>
            iRevNet uses two residual half-steps, undone by subtracting in reverse order; it is invertible for any
            residual functions, so training need not store activations. iResNet keeps the ordinary h + f[h] and inverts
            it by fixed-point iteration, which works when f is a contraction (slope below 1, enforced by keeping each
            weight matrix&apos;s largest singular value under 1). Its log-determinant is estimated with a power series
            and Hutchinson&apos;s trace estimator.
          </>
        ),
      },
      {
        id: '16.4',
        title: 'Multi-scale flows',
        page: 317,
        shows: (
          <>
            A flow&apos;s latent must be as large as its data. Multi-scale flows let parts of z join (or, in the
            normalising direction, leave) at intermediate layers, so the later layers work on fewer dimensions and both
            sampling and density evaluation get faster.
          </>
        ),
      },
      {
        id: '16.5a',
        title: 'Exact densities and anomaly detection',
        page: 318,
        shows: (
          <>
            Of the book&apos;s four generative models, only flows give an exact log-likelihood. That suits anomaly
            detection: fit a flow to clean data and flag points it finds improbable. The book adds a caution from
            chapter 8: in high dimensions, outliers can still receive high likelihood, because likely points and typical
            points are not the same thing.
          </>
        ),
      },
      {
        id: '16.5b',
        title: 'GLOW: a flow for images',
        page: 319,
        shows: (
          <>
            GLOW combines coupling layers whose affine parameters come from a convolutional network, 1×1 convolutions
            stored as LU factors to mix channels, a squeeze that trades resolution for channels, and multi-scale
            factoring. Noise is added to pixel values (dequantisation) so the likelihood cannot grow without bound.
            Sampling from a sharpened base density improves realism, much like truncation in GANs, and interpolating
            between the latents of two real faces gives a smooth morph.
          </>
        ),
      },
      {
        id: '16.5c',
        title: 'Learning to sample from a known density',
        page: 321,
        shows: (
          <>
            Sometimes a density is easy to evaluate but hard to sample. A student flow generates its own samples, so it
            knows their z and their likelihood without inverting anything, and is trained to minimise the reverse KL
            divergence to the teacher. This is how flows can supply a richer posterior to a VAE.
          </>
        ),
      },
    ],
    inLlms: (
      <p>
        An LLM is not a flow, but it shares a flow&apos;s accounting. An autoregressive language model computes an exact
        likelihood one conditional at a time, as an autoregressive flow does, and reports it as perplexity. The masking
        that lets a masked autoregressive flow evaluate every dimension at once is the causal mask of a transformer, and
        sampling is sequential in both for the same reason. The chapter&apos;s ideas also live on in image and video
        generation: <b>flow matching</b> and <b>rectified flow</b>, descendants of continuous normalising flows, train
        many current generators. Reversible residual layers (iRevNet) save activation memory and were tried in
        transformers.
      </p>
    ),
    next: [
      <>
        <b>Neural ODEs</b> (Chen et al., 2018) and <b>FFJORD</b> (Grathwohl et al., 2019) make a flow continuous in
        time, where the log-determinant becomes a trace that Hutchinson&apos;s estimator handles, as in iResNet.
      </>,
      <>
        <b>Flow matching</b> (Lipman et al., 2023) and <b>rectified flow</b> (Liu et al., 2023) train a continuous flow
        by regressing a velocity field, with no ODE solving during training. Stable Diffusion 3 (Esser et al., 2024) is
        built on rectified flow.
      </>,
      <>
        <b>Discrete flow matching</b> (Gat et al., 2024) carries the idea to tokens, as a non-autoregressive way to
        generate text and code.
      </>,
      <>
        <b>TarFlow</b> (Zhai et al., 2024) builds an autoregressive flow from transformer blocks and closes much of the
        gap in image quality between flows and diffusion models that the book points out.
      </>,
      <>
        The <b>Reformer</b> (Kitaev et al., 2020) used reversible residual layers in a transformer so that activations
        need not be kept for backpropagation.
      </>,
    ],
    labs: [
      ['/image-generation', 'Image generation'],
      ['/building', 'How LLMs are built'],
      ['/deep-learning', 'Deep learning notebooks'],
    ],
  },
  {
    n: 17,
    title: 'Variational autoencoders',
    offers: (
      <p>
        How to fit a model in which every data point is made from a hidden code, when the likelihood is an integral
        nobody can compute. The chapter derives the evidence lower bound (ELBO) from Jensen&apos;s inequality, shows
        when it is tight, and builds the variational autoencoder as the network that estimates and maximises it, with
        the reparameterisation trick to carry gradients through the sampling step.
      </p>
    ),
    examples: [
      {
        id: '17.1',
        title: 'A mixture of Gaussians as a latent variable model',
        page: 328,
        notebooks: ['17.1'],
        shows: (
          <>
            A discrete hidden z picks a component with probability λ<sub>n</sub>, and x is then drawn from that
            component&apos;s normal. Summing the joint over z gives a multi-modal density built from simple parts: the
            pattern every latent variable model follows.
          </>
        ),
      },
      {
        id: '17.2',
        title: 'The nonlinear latent variable model',
        page: 328,
        notebooks: ['17.1'],
        shows: (
          <>
            Now z is continuous with a standard normal prior, and x is normal around a network output f[z, ϕ] with
            spherical noise σ². The density of x is an infinite mixture: one small Gaussian for every z, laid along the
            curve the network traces. Sampling is easy (draw z, run the network, add noise); the likelihood is not.
          </>
        ),
      },
      {
        id: '17.3a',
        title: 'Jensen’s inequality',
        page: 331,
        shows: (
          <>
            Because log is concave, the log of an average is at least the average of the logs: log E[y] ≥ E[log y]. The
            figures show it as a weighted average of points on the curve, which must lie below the curve.
          </>
        ),
      },
      {
        id: '17.3b',
        title: 'Deriving the evidence lower bound',
        page: 333,
        shows: (
          <>
            Multiply and divide the integrand by any distribution q(z), then apply Jensen: log Pr(x | ϕ) ≥ ∫ q(z)
            log[Pr(x, z | ϕ) / q(z)] dz. The right-hand side is the ELBO. Giving q its own parameters θ turns fitting
            into maximising one function of both ϕ and θ.
          </>
        ),
      },
      {
        id: '17.4',
        title: 'When the bound is tight; reconstruction minus KL',
        page: 334,
        shows: (
          <>
            Rewritten, the ELBO is the log-likelihood minus KL(q ‖ posterior), so it is tight exactly when q is the true
            posterior over z given x. Rewritten again, it is the expected reconstruction log-likelihood minus KL(q ‖
            prior), the form the VAE uses. Changing θ moves the bound up towards the likelihood; changing ϕ moves along
            it.
          </>
        ),
      },
      {
        id: '17.5',
        title: 'The variational approximation',
        page: 336,
        shows: (
          <>
            The true posterior needs the evidence Pr(x), which is the thing we cannot compute. So q is restricted to a
            normal with diagonal covariance whose mean and variance an encoder network predicts from x. It fits well
            when the posterior has one peak and badly when it has several.
          </>
        ),
      },
      {
        id: '17.6',
        title: 'The VAE: encode, sample, decode',
        page: 336,
        shows: (
          <>
            For one training example: predict μ and Σ, draw one z, and score log Pr(x | z) − KL(q ‖ prior), where the KL
            to a standard normal has the closed form ½(tr Σ + μᵀμ − D − log det Σ). It is variational because q
            approximates the posterior, and an autoencoder because x goes to a smaller z and back.
          </>
        ),
      },
      {
        id: '17.7',
        title: 'The reparameterisation trick',
        page: 339,
        notebooks: ['17.2'],
        shows: (
          <>
            A sampling step blocks backpropagation. Writing z = μ + Σ<sup>½</sup>ε with ε drawn from a standard normal
            moves the randomness into an input branch, so gradients reach the encoder through μ and Σ.
          </>
        ),
      },
      {
        id: '17.8a',
        title: 'Estimating a likelihood by importance sampling',
        page: 340,
        notebooks: ['17.3'],
        shows: (
          <>
            Averaging Pr(x | z) over z drawn from the prior wastes almost every sample in high dimensions, because few
            land where x is likely. Drawing z from the encoder&apos;s q(z | x) instead, and reweighting by Pr(z) / q(z),
            gives a usable estimate, for evaluating a model or flagging anomalies.
          </>
        ),
      },
      {
        id: '17.8b',
        title: 'Generation and resynthesis',
        page: 341,
        shows: (
          <>
            Plain VAE samples look too smooth without the output noise and too noisy with it. Better results come from
            sampling the aggregated posterior, from hierarchical priors and careful architecture; the book notes that
            diffusion models can be read as hierarchical VAEs. Resynthesis encodes a real face, adds a direction such as
            &quot;smiling minus neutral&quot; found from labelled group means, and decodes, using spherical rather than
            straight-line interpolation.
          </>
        ),
      },
      {
        id: '17.8c',
        title: 'Disentanglement: beta-VAE and total correlation',
        page: 342,
        shows: (
          <>
            Weighting the KL-to-prior term by β &gt; 1 pushes the posterior towards the prior&apos;s independent
            dimensions, encouraging each latent coordinate to mean one thing. The total correlation VAE penalises
            dependence between latents directly. Trained on chairs, separate coordinates came to control rotation, size
            and leg style.
          </>
        ),
      },
    ],
    inLlms: (
      <p>
        The ELBO and the reparameterisation trick sit under most of today&apos;s image generators. A{' '}
        <b>latent diffusion model</b> first trains an autoencoder with a light KL penalty (a VAE in all but emphasis) to
        squash an image into a small latent grid, runs diffusion there, and uses the decoder to turn the result back
        into pixels. Discrete cousins, VQ-VAE and VQGAN, turn images into tokens a transformer can read and write, and
        neural audio codecs do the same for speech. The ELBO&apos;s shape, a reward minus a KL to a prior, reappears in
        RLHF, where the policy maximises reward minus a KL penalty to a reference model. And the question of what each
        latent direction means is the one sparse autoencoders now ask of an LLM&apos;s activations.
      </p>
    ),
    next: [
      <>
        <b>Latent diffusion</b> (Rombach et al., 2022) runs diffusion in a VAE&apos;s latent space instead of in pixels,
        cutting the cost of training and sampling sharply; it is the design behind Stable Diffusion.
      </>,
      <>
        <b>VQ-VAE</b> (van den Oord et al., 2017) swaps the Gaussian latent for a learned codebook, so an image or a
        sound becomes a sequence of discrete tokens; DALL·E (Ramesh et al., 2021) generated images as such tokens with a
        transformer.
      </>,
      <>
        <b>Sparse autoencoders</b> on LLM activations (Bricken et al., 2023; Templeton et al., 2024) learn a large
        dictionary of features, many of them interpretable: the disentanglement goal, pointed at a language model.
      </>,
      <>
        <b>Coconut</b> (Hao et al., 2024) lets an LLM reason in a continuous latent space, feeding its hidden state back
        as input instead of writing every step out as tokens.
      </>,
    ],
    labs: [
      ['/image-generation', 'Image generation'],
      ['/vision', 'Images as tokens'],
      ['/deep-learning', 'Deep learning notebooks'],
    ],
  },
  {
    n: 18,
    title: 'Diffusion models',
    offers: (
      <p>
        The generative model behind most current image and video systems, derived from first principles. A fixed process
        mixes data with noise over many small steps, and a network learns to undo one step at a time. The chapter
        derives the closed-form forward kernel, the ELBO for the reverse chain, the simplification to &quot;predict the
        noise&quot;, and the practical machinery: one time-conditioned U-Net, faster samplers, guidance and cascades.
      </p>
    ),
    examples: [
      {
        id: '18.2a',
        title: 'The forward process on 1D data',
        page: 350,
        notebooks: ['18.1'],
        shows: (
          <>
            Each step shrinks the value by √(1 − β<sub>t</sub>) and adds normal noise of variance β<sub>t</sub>. With T
            = 100 steps and β = 0.03, three starting points wander towards zero and spread out until their origin is
            lost. The chain has no parameters, and after enough steps every input ends at a standard normal.
          </>
        ),
      },
      {
        id: '18.2b',
        title: 'The diffusion kernel and the marginals',
        page: 353,
        notebooks: ['18.1'],
        shows: (
          <>
            Substituting the steps into one another gives z<sub>t</sub> = √α<sub>t</sub>·x + √(1 − α<sub>t</sub>)·ε,
            with α<sub>t</sub> the product of the (1 − β) terms, so any step can be sampled directly. Spreading this
            kernel over the whole data distribution gives the marginal q(z<sub>t</sub>), a progressively blurred copy of
            the data.
          </>
        ),
      },
      {
        id: '18.2c',
        title: 'Running one step backwards',
        page: 354,
        notebooks: ['18.2'],
        shows: (
          <>
            Reversing a step with Bayes&apos; rule needs the unknown marginal. Computed numerically in 1D, the reverse
            distribution is usually close to normal when β is small, though not always. Conditioning on the clean x as
            well makes it exactly normal, with a closed-form mean and variance: this is the target the decoder is
            trained against.
          </>
        ),
      },
      {
        id: '18.3',
        title: 'The decoder and ancestral sampling',
        page: 356,
        notebooks: ['18.2'],
        shows: (
          <>
            Each reverse step is modelled as a normal whose mean a network predicts from z<sub>t</sub>, with a fixed
            variance. The approximation is good when steps are small and many. To generate, draw z<sub>T</sub> from a
            standard normal and sample each earlier step in turn.
          </>
        ),
      },
      {
        id: '18.4',
        title: 'The ELBO and the diffusion loss',
        page: 357,
        notebooks: ['18.2'],
        shows: (
          <>
            The same Jensen argument as the VAE, with the fixed encoder as q. After a telescoping cancellation the bound
            is a reconstruction term minus a sum of KL divergences between the true one-step posteriors and the
            model&apos;s steps; each KL between normals reduces to a squared difference of means. Since the encoder has
            no parameters, the decoder does all the work. The book&apos;s 1D model is fitted as look-up tables.
          </>
        ),
      },
      {
        id: '18.5',
        title: 'Predicting the noise',
        page: 361,
        notebooks: ['18.3'],
        shows: (
          <>
            Because x = (z<sub>t</sub> − √(1 − α<sub>t</sub>)·ε) / √α<sub>t</sub>, the target can be rewritten in terms
            of the noise ε. Letting the network predict ε and dropping the per-step weights leaves the loss used in
            practice: ‖g<sub>t</sub>[√α<sub>t</sub>·x + √(1 − α<sub>t</sub>)·ε] − ε‖².
          </>
        ),
      },
      {
        id: '18.6a',
        title: 'The training and sampling algorithms',
        page: 363,
        notebooks: ['18.3'],
        shows: (
          <>
            Training: pick an example, a step and some noise, and take one least-squares step. Every example is reused
            with fresh noise at every step, which is free data augmentation. Sampling: start from noise and call the
            network once per step, adding a little fresh noise each time, which is why generation is slow.
          </>
        ),
      },
      {
        id: '18.6b',
        title: 'One U-Net for every step',
        page: 364,
        shows: (
          <>
            For images, a single U-Net with residual blocks and periodic self-attention predicts the noise at every
            step. The step number enters as a sinusoidal embedding added to the channels at each stage. Good images can
            need T = 1000 steps.
          </>
        ),
      },
      {
        id: '18.6c',
        title: 'Faster sampling: DDIM and skipped steps',
        page: 364,
        notebooks: ['18.4'],
        shows: (
          <>
            The loss only depends on the one-step-to-any-step kernel, so one trained model fits a whole family of
            forward processes. Denoising diffusion implicit models are deterministic after the first step, and
            accelerated versions use a short sub-sequence of steps; about 50 steps then give good samples.
          </>
        ),
      },
      {
        id: '18.6d',
        title: 'Classifier guidance and classifier-free guidance',
        page: 365,
        Demo: GuidanceDemo,
        shows: (
          <>
            Classifier guidance nudges each denoising step along the gradient of a classifier&apos;s log Pr(c | z
            <sub>t</sub>). Classifier-free guidance trains one model both with and without the condition, dropping it at
            random, and mixes the two noise predictions at sampling time. Over-weighting the condition gives very clean
            but stereotyped samples. The demo shows why: the mix aims at the class density multiplied by Pr(c | x)
            <sup>w</sup>, which empties the parts of a class that look like another class.
          </>
        ),
      },
      {
        id: '18.6e',
        title: 'Better quality: learned variances, schedules and cascades',
        page: 367,
        shows: (
          <>
            Predicting the reverse variances as well as the means helps most when sampling with few steps; tuning the
            noise schedule helps too. High-resolution images come from a cascade: a low-resolution model, then models
            that upscale while conditioning on the smaller image and on a text embedding from a language model.
          </>
        ),
      },
    ],
    inLlms: (
      <p>
        Diffusion is how most current image and video generators work, usually in a VAE&apos;s latent space and
        increasingly with a transformer in place of the U-Net. The prompt reaches the denoiser through a language
        model&apos;s embeddings, and classifier-free guidance (the demo above) sets how closely the picture follows it.
        Diffusion is also arriving in text. <b>Masked diffusion language models</b> such as LLaDA corrupt a passage by
        masking tokens rather than adding Gaussian noise, and learn to fill the masks back in, several at a time and in
        any order. They replace the one-token-per-step loop of an autoregressive LLM with a fixed number of parallel
        denoising steps, which is why they are being explored for faster generation and for filling gaps in the middle
        of text.
      </p>
    ),
    next: [
      <>
        <b>D3PM</b> (Austin et al., 2021) defined diffusion on discrete tokens, with masking as one kind of corruption;{' '}
        <b>SEDD</b> (Lou et al., 2024) and <b>MDLM</b> (Sahoo et al., 2024) narrowed the perplexity gap to
        autoregressive models.
      </>,
      <>
        <b>LLaDA</b> (Nie et al., 2025) trained an 8-billion-parameter masked diffusion language model from scratch and
        reported results close to an autoregressive model of similar size, and better on a reversal task where
        left-to-right models struggle.
      </>,
      <>
        <b>Diffusion Transformers</b> (Peebles &amp; Xie, 2023) replaced the U-Net with a transformer over latent
        patches and found that quality improved steadily with compute, as it does for LLMs.
      </>,
      <>
        <b>Consistency models</b> (Song et al., 2023) learn to jump from any noise level straight to the clean sample,
        so generation takes one or a few steps.
      </>,
      <>
        <b>Classifier-free guidance for language models</b> (Sanchez et al., 2023) applied the same conditional-minus-
        unconditional mixing to next-token logits, making outputs follow the prompt more closely.
      </>,
    ],
    labs: [
      ['/image-generation', 'Image generation'],
      ['/vision', 'Images as tokens'],
      ['/deep-learning', 'Deep learning notebooks'],
    ],
  },
  {
    n: 19,
    title: 'Reinforcement learning',
    offers: (
      <p>
        A compact course in reinforcement learning: Markov decision processes and the Bellman equations, then tabular
        methods (dynamic programming, Monte Carlo, temporal difference), deep Q-networks, policy gradients, actor-critic
        methods and offline RL. It is the foundation of how LLMs are post-trained, since RLHF and reinforcement learning
        from verifiable rewards are policy-gradient methods.
      </p>
    ),
    examples: [
      {
        id: '19.1a',
        title: 'The penguin on the ice: Markov and reward processes',
        page: 375,
        notebooks: ['19.1'],
        shows: (
          <>
            A penguin on a 4×4 grid of ice slides to a random neighbouring square each step: a Markov process. Fish
            squares give a reward, and with discount γ = 0.9 the return G<sub>t</sub> adds future rewards, each shrunk
            by γ per step of delay. The chapter&apos;s opening names the difficulties: sparse rewards, rewards that
            arrive long after the action that earned them (temporal credit assignment), randomness, and the balance
            between exploring and exploiting.
          </>
        ),
      },
      {
        id: '19.1b',
        title: 'Decision processes, partial observability and policies',
        page: 376,
        notebooks: ['19.1'],
        shows: (
          <>
            Adding actions makes a Markov decision process: the penguin picks a direction but moves that way only half
            the time. If it can only see nearby tiles, two different squares can look identical (a partially observable
            MDP). A policy maps states to actions, deterministically or as a probability distribution; stochastic
            policies explore more and can be necessary under partial observability.
          </>
        ),
      },
      {
        id: '19.2',
        title: 'State values, action values and the Bellman equations',
        page: 378,
        notebooks: ['19.2'],
        shows: (
          <>
            The value of a state is the expected return from it under a policy; the value of an action adds one chosen
            step first. If the optimal action values are known, acting greedily on them is optimal. The Bellman
            equations tie the two: a state&apos;s value is the policy-weighted average of its action values, and an
            action&apos;s value is its reward plus the discounted value of where it leads.
          </>
        ),
      },
      {
        id: '19.3a',
        title: 'Dynamic programming',
        page: 383,
        notebooks: ['19.2'],
        shows: (
          <>
            With known transitions and rewards, sweep the states making each value consistent with its successors
            (bootstrapping), then make the policy greedy, and repeat. Policy iteration evaluates fully before improving;
            value iteration does one sweep. The penguin learns to avoid holes and head for the fish.
          </>
        ),
      },
      {
        id: '19.3b',
        title: 'Monte Carlo methods',
        page: 384,
        notebooks: ['19.3'],
        shows: (
          <>
            Without a model of the world, play whole episodes and average the returns that followed each state-action
            pair. Unseen actions never get values, so exploration needs exploring starts or an ε-greedy policy. The
            section also separates on-policy learning from off-policy learning, where one behaviour policy gathers data
            for another target policy.
          </>
        ),
      },
      {
        id: '19.3c',
        title: 'Temporal difference: SARSA and Q-learning',
        page: 385,
        notebooks: ['19.4'],
        shows: (
          <>
            Update after every step, towards the reward plus the discounted value of the next step: sampling like Monte
            Carlo, bootstrapping like dynamic programming. SARSA uses the next action actually taken; Q-learning uses
            the best next action. The book traces one Q-learning update by hand, with no reward, a best next value of
            0.43, γ = 0.9 and learning rate 0.1. Both updates are contraction mappings, so they converge if every pair
            keeps being visited.
          </>
        ),
      },
      {
        id: '19.4a',
        title: 'Fitted Q-learning and the deep Q-network',
        page: 386,
        shows: (
          <>
            A network replaces the table, trained on the squared TD error, but convergence is no longer guaranteed
            because the target moves with the parameters. The deep Q-network for Atari stacks four 84×84 greyscale
            frames, outputs values for 18 joystick actions, clips rewards to ±1, replays stored experience in random
            batches, and freezes a copy of the network to compute targets. It reached human-tester level on many games
            after about 38 days of play each, and failed on sparse-reward games such as Montezuma&apos;s Revenge.
          </>
        ),
      },
      {
        id: '19.4b',
        title: 'Double Q-learning',
        page: 388,
        shows: (
          <>
            Taking a maximum over noisy value estimates picks out the lucky ones, so values are overestimated. Two
            models fix this: one chooses the best next action and the other says what it is worth.
          </>
        ),
      },
      {
        id: '19.5a',
        title: 'Policy gradients and REINFORCE',
        page: 389,
        shows: (
          <>
            Learn a stochastic policy directly, by gradient ascent on the expected return. The likelihood-ratio identity
            turns the gradient into an average of ∂log Pr(τ)/∂θ times the return, and the environment&apos;s transition
            probabilities drop out, so no model of the world and no Markov assumption are needed. Unusual trajectories
            with high returns cause the biggest updates. REINFORCE weights each action by the discounted return that
            followed it.
          </>
        ),
      },
      {
        id: '19.5b',
        title: 'Baselines and the advantage',
        page: 392,
        notebooks: ['19.5'],
        Demo: PolicyGradientDemo,
        shows: (
          <>
            Subtracting a baseline that does not depend on the action leaves the expected gradient unchanged but can cut
            its variance sharply: a control variate. A state-dependent baseline, the learned state value, turns the
            return into an advantage estimate. Notebook 19.5 measures the variance of single gradient estimates; the
            demo here runs the training itself, on one prompt with a pass-or-fail checker, comparing no baseline, the
            group mean, and GRPO&apos;s group mean divided by the group&apos;s spread, with a KL penalty to a reference
            policy as in RLHF.
          </>
        ),
      },
      {
        id: '19.6',
        title: 'Actor-critic methods',
        page: 394,
        shows: (
          <>
            Instead of waiting for the episode to end, estimate the rest of the return as the next reward plus the
            discounted value of the next state, from a second network. The policy is the actor and the value network the
            critic, often sharing one body with two heads; in practice updates still come in batches.
          </>
        ),
      },
      {
        id: '19.7',
        title: 'Offline RL and the decision transformer',
        page: 395,
        shows: (
          <>
            When exploring is dangerous or expensive, learn from logged trajectories alone. The decision transformer
            treats this as sequence prediction: a causal transformer reads returns-to-go, states and actions and
            predicts the next action. At test time it is prompted with the return wanted and the figure is reduced as
            rewards arrive, swapping RL&apos;s instability for supervised learning.
          </>
        ),
      },
    ],
    inLlms: (
      <p>
        Post-training a chat model is reinforcement learning in a simple environment. The state is the prompt and the
        tokens so far, an action is the next token, and the reward usually arrives once, at the end. In <b>RLHF</b> the
        reward comes from a reward model trained on human preference pairs, and the policy is updated with <b>PPO</b>,
        an actor-critic method with a learned value network, plus a KL penalty that keeps it near the supervised model.{' '}
        <b>GRPO</b> drops the critic: it samples a group of answers to each prompt and uses the group&apos;s mean reward
        as the baseline, which is the control-variate idea of section 19.5.3. Reasoning models are trained with{' '}
        <b>reinforcement learning from verifiable rewards</b>, where a program checks the final answer or runs the
        tests, so the reward is harder to game than a learned judge, though not impossible. The credit assignment
        problem from the chapter&apos;s opening is why long chains of thought are hard to train: one reward at the end
        has to be shared among thousands of tokens.
      </p>
    ),
    next: [
      <>
        <b>InstructGPT</b> (Ouyang et al., 2022) set the RLHF recipe: supervised fine-tuning, a reward model from human
        rankings, then <b>PPO</b> (Schulman et al., 2017) with a KL penalty to the supervised model.
      </>,
      <>
        <b>DPO</b> (Rafailov et al., 2023) uses the closed-form optimum of KL-regularised reward maximisation (the last
        column of the demo&apos;s table) to turn preference learning into a classification loss, with no sampling and no
        separate reward model.
      </>,
      <>
        <b>GRPO</b>, from DeepSeekMath (Shao et al., 2024), replaces PPO&apos;s critic with group-relative advantages.{' '}
        <b>DeepSeek-R1</b> (DeepSeek-AI, 2025) used it with rule-based rewards for correctness and format to train long
        chains of thought; its R1-Zero variant started from the base model with no supervised fine-tuning.
      </>,
      <>
        <b>Tülu 3</b> (Lambert et al., 2024) named the approach reinforcement learning with verifiable rewards (RLVR):
        training on prompts whose answers code can check, such as maths and precise instruction-following.
      </>,
      <>
        <b>Process reward models</b> (Lightman et al., 2023) score each reasoning step rather than only the final
        answer, attacking the credit assignment problem directly.
      </>,
    ],
    labs: [
      ['/preference-tuning', 'Preference tuning'],
      ['/reasoning-models', 'Reasoning models'],
      ['/training', 'Training'],
      ['/deep-learning', 'Deep learning notebooks'],
    ],
  },
  {
    n: 20,
    title: 'Why does deep learning work?',
    offers: (
      <p>
        An honest chapter about what is not yet understood. It argues that both the easy fitting and the good
        generalisation of deep networks are surprising, then sorts the evidence: what makes training succeed, what loss
        surfaces look like, what predicts generalisation, and whether networks really need to be so large and so deep.
        It ends without a theory, because there is not one yet.
      </p>
    ),
    examples: [
      {
        id: '20.1',
        title: 'The case against deep learning',
        page: 402,
        shows: (
          <>
            A two-layer network fits 10,000 MNIST-1D examples perfectly with about 4,000 parameters, although finding
            the global minimum of a non-convex function is NP-hard in general. Generalising is stranger still:
            quantising the 40 inputs to 10 levels gives 10<sup>40</sup> possible inputs, and a network with 177,201
            parameters can carve up to 10<sup>42</sup> linear regions, yet it behaves sensibly between the few training
            points. Nor is it clear that big models are overparameterised: GPT-3 had 175 billion parameters and saw 300
            billion tokens.
          </>
        ),
      },
      {
        id: '20.2a',
        title: 'Fitting random data',
        page: 404,
        notebooks: ['20.1'],
        shows: (
          <>
            AlexNet still fits CIFAR-10 when the images are replaced by Gaussian noise or the labels are shuffled, only
            more slowly. Neither L2 regularisation nor dropout is needed for this. So the ease of fitting does not come
            from structure in the data or from explicit regularisation.
          </>
        ),
      },
      {
        id: '20.2b',
        title: 'Full-batch gradient descent on random labels',
        page: 405,
        notebooks: ['20.2'],
        shows: (
          <>
            Four networks of one to four layers, each with about 15,200 parameters, are trained on 4,000 MNIST-1D
            examples with random labels by plain full-batch gradient descent at learning rate 0.0025. With no
            randomness, no regularisation and nothing to learn, all four still reach zero training error, the deeper
            ones in fewer epochs. That hints the loss surfaces have no bad local minima to get stuck in.
          </>
        ),
      },
      {
        id: '20.2c',
        title: 'Overparameterisation',
        page: 405,
        Demo: ParamCountDemo,
        shows: (
          <>
            With far more parameters than constraints there is a huge family of equally good solutions, so some
            direction always lowers the loss: &quot;a haystack of needles&quot;. Most ImageNet models have 10 to 100
            times more parameters than training images. Convergence proofs exist, but assume widths far beyond practice.
            The demo puts the book&apos;s own counts beside today&apos;s LLMs, and shows that by this measure an LLM
            counted in tokens is not overparameterised at all.
          </>
        ),
      },
      {
        id: '20.2d',
        title: 'Activations, initialisation, depth and lottery tickets',
        page: 406,
        notebooks: ['20.3'],
        shows: (
          <>
            Activations with flat tails (sigmoid, tanh) make fitting harder than ReLUs. Initialising at larger multiples
            of He&apos;s scale slows fitting but does not stop it. On depth, the lottery ticket experiment trains a
            network, prunes its smallest weights and retrains the survivors from their original starting values, which
            works as well as the full network; from a fresh random start it does not. Large networks may succeed because
            they contain many lucky sub-networks.
          </>
        ),
      },
      {
        id: '20.3a',
        title: 'Many minima, and a straight road to them',
        page: 408,
        shows: (
          <>
            Permuting hidden units, or scaling weights on either side of a ReLU, gives identical networks, so global
            minima come in large families. The loss usually falls steadily along the straight line from the initial to
            the final weights, real training paths stay in low-dimensional subspaces, and a network trained only within
            a random 750-dimensional subspace (0.4% of its parameters) reaches 90% of its full performance.
          </>
        ),
      },
      {
        id: '20.3b',
        title: 'Connected minima and the shape of the surface',
        page: 408,
        shows: (
          <>
            A straight line between two independently found minima crosses a ridge, but curved paths of low loss connect
            them, more easily as networks get wider and deeper; minima that share their early training are often
            linearly connected. Critical points at high loss tend to be saddles rather than minima, and curvature is
            unusually positive in a band of weight norms (the Goldilocks zone) that includes the usual initialisations.
          </>
        ),
      },
      {
        id: '20.4a',
        title: 'The training algorithm and flat minima',
        page: 411,
        shows: (
          <>
            Which of the many minima training reaches decides generalisation. SGD generalises better than full-batch
            descent, and the ratio of batch size to learning rate matters, consistent with SGD&apos;s implicit
            regularisation. Flat minima are thought to generalise better, and averaging weights along a trajectory both
            flattens the minimum and helps; but flatness can be changed by harmless rescaling, and random labels do not
            make minima sharper.
          </>
        ),
      },
      {
        id: '20.4b',
        title: 'Architecture, weight norm, grokking and double descent',
        page: 413,
        shows: (
          <>
            Matching the architecture to the data (convolutions for grids, transformers for sets) is a strong inductive
            bias. Generalisation is also best when the weight norm sits in the Goldilocks zone. That offers an account
            of grokking, where test accuracy jumps long after training error reaches zero, as the time weight decay
            takes to pull oversized weights back into the zone; and of double descent, since the weight norm peaks where
            parameters roughly equal data points.
          </>
        ),
      },
      {
        id: '20.4c',
        title: 'Adversarial examples',
        page: 414,
        notebooks: ['20.4'],
        shows: (
          <>
            An imperceptible change to a correctly classified image can flip its label. The leading explanation is that
            the network relies on features that are genuinely predictive in the training data but too faint for people
            to notice, rather than on a failure off the data manifold.
          </>
        ),
      },
      {
        id: '20.5',
        title: 'Pruning and distillation',
        page: 415,
        shows: (
          <>
            Can a trained network be shrunk below one parameter per example without losing accuracy? Pruning kept VGG
            accurate on ImageNet with 8% of its weights; iterated lottery-ticket pruning removed 98.5% of VGG-19 on
            CIFAR-10 and 80% of ResNet-50 on ImageNet. Distillation trains a small student on a teacher&apos;s logits.
            None of these gets below the data count, and a 2021 result (Bubeck and Sellke) says smooth interpolation in
            D dimensions needs D times more parameters than interpolation alone.
          </>
        ),
      },
      {
        id: '20.6',
        title: 'Do networks have to be deep?',
        page: 418,
        shows: (
          <>
            Shallow networks can approximate anything in principle, yet the best models have tens or hundreds of layers.
            Wide-shallow variants come close, and residual networks seem to rely mostly on paths of 5 to 17 layers.
            Three explanations are weighed: deep networks express more complex functions, they are easier to train
            (shallow students cannot match deep teachers at a fixed parameter budget), and their structure is a good
            prior (even an untrained CNN helps with denoising).
          </>
        ),
      },
    ],
    inLlms: (
      <p>
        Every frontier LLM is a bet on this chapter&apos;s empirical findings, made before the theory exists.{' '}
        <b>Scaling laws</b> answer &quot;how big should the model be&quot; in practice: loss falls as a smooth power law
        in parameters, data and compute, and the Chinchilla study found that for a fixed compute budget parameters and
        training tokens should grow together, at roughly twenty tokens per parameter. Counted that way an LLM sees far
        more tokens than it has parameters, yet it trains reliably. The chapter&apos;s other findings show up too.{' '}
        <b>LoRA</b> fine-tunes in a tiny subspace, as the intrinsic-dimension result suggests is possible; grokking was
        first seen in small transformers; pruning, quantisation and <b>distillation</b> turn large models into the
        smaller ones that are actually served; model merging works because fine-tuned models from one start sit in a
        connected low-loss region; and adversarial examples return as jailbreaks.
      </p>
    ),
    next: [
      <>
        <b>Scaling laws</b> (Kaplan et al., 2020) and the compute-optimal <b>Chinchilla</b> laws (Hoffmann et al., 2022)
        turned &quot;bigger is better&quot; into a forecast of loss from parameters, data and compute.
      </>,
      <>
        Training small models far past the Chinchilla ratio, as with <b>Llama 3</b> 8B on over 15 trillion tokens (Meta,
        2024), buys a model that is cheaper to serve; <b>Beyond Chinchilla-optimal</b> (Sardana et al., 2024) adds
        inference cost to the scaling law.
      </>,
      <>
        <b>Scaling test-time compute</b> (Snell et al., 2024) asks the same question at inference: when it pays more to
        let a model think longer than to make it larger.
      </>,
      <>
        <b>LoRA</b> (Hu et al., 2022) trains only small low-rank weight updates, building on the finding that
        fine-tuning has a low intrinsic dimension (Aghajanyan et al., 2021).
      </>,
      <>
        <b>Model soups</b> (Wortsman et al., 2022) and <b>task arithmetic</b> (Ilharco et al., 2023) average or add
        fine-tuned weights, relying on the connected minima described in section 20.3.
      </>,
    ],
    labs: [
      ['/training-at-scale', 'Training at scale'],
      ['/training', 'Training'],
      ['/benchmarks', 'Benchmarks'],
      ['/deep-learning', 'Deep learning notebooks'],
    ],
  },
  {
    n: 21,
    title: 'Deep learning and ethics',
    offers: (
      <p>
        A chapter, written with Travis LaCroix, on the harms deep learning can cause and the researcher&apos;s share of
        responsibility for them. It frames many problems as value alignment between a human principal and an AI agent,
        then covers bias and fairness, moral agency, transparency and explainability, deliberate misuse and wider social
        costs, works through a case study, and argues that science is not value-free.
      </p>
    ),
    examples: [
      {
        id: '21.1a',
        title: 'Value alignment: outer, inner, principal and agent',
        page: 421,
        shows: (
          <>
            A loss function is a proxy for what we want. Outer misalignment is a bad proxy with loopholes: a chess agent
            rewarded for capturing pieces may settle for draws. Inner misalignment is a good proxy that training still
            fails to instil, because of poor optimisation or unrepresentative data. The problem has a technical half
            (how to encode values) and a normative half (which values). Framed as principal and agent, trouble comes
            from misspecified objectives or from information the agent has and the principal does not.
          </>
        ),
      },
      {
        id: '21.1b',
        title: 'Where bias enters, and how it is mitigated',
        page: 422,
        notebooks: ['21.1'],
        shows: (
          <>
            Bias can enter at problem specification, in the data (a face upscaler trained mostly on white celebrities
            turned a low-resolution photo of Barack Obama into a white man), in modelling and validation (reasonable
            fairness definitions that cannot all hold at once), and in deployment (model outputs published online become
            the next model&apos;s training data). Errors compound where categories intersect. Removing protected
            attributes does not work, because other features carry them; the alternative is to choose a fairness
            criterion and intervene at some stage of the pipeline.
          </>
        ),
      },
      {
        id: '21.1c',
        title: 'Artificial moral agency',
        page: 425,
        shows: (
          <>
            Autonomous cars, weapons and care robots may face choices with moral weight. Agents range from ethical
            impact agents (any deployed technology) through implicit and explicit ethical agents to full ethical agents
            with beliefs and intentions. Machine ethics builds rules in from the top down, learns them from human
            judgements from the bottom up, or mixes the two; some argue moral agency is not needed for safety at all.
          </>
        ),
      },
      {
        id: '21.1d',
        title: 'Transparency and explainability',
        page: 426,
        notebooks: ['21.2'],
        shows: (
          <>
            Transparency comes in levels: knowing the algorithm (functional), the code that runs it (structural), and
            the particular run with its data and weights (run). GPT-3 is functionally transparent from its paper but not
            structurally or at run level; GPT-4 is not transparent at all. Where a whole system cannot be explained,
            local methods such as LIME fit a simple model to the network&apos;s answers near one input.
          </>
        ),
      },
      {
        id: '21.2',
        title: 'Intentional misuse',
        page: 427,
        shows: (
          <>
            Systems that work as designed can still be misused: face recognition for tracking protesters (and face
            analysis that claims far more than it can do), autonomous weapons and disinformation, fraud helped by
            generated text and by people&apos;s tendency to treat chatbots as people, and privacy. Removing names is not
            anonymisation: in 1997 a governor&apos;s &quot;anonymous&quot; health records were identified by matching
            them against public voter rolls.
          </>
        ),
      },
      {
        id: '21.3',
        title: 'Wider costs',
        page: 429,
        shows: (
          <>
            Language and image models can reproduce copyrighted training data verbatim, and the ownership of generated
            work is unsettled. Leaning on automated judgements risks automation bias and moral deskilling. Training has
            an energy cost, estimated at around 284 tonnes of CO₂ for one 213-million-parameter transformer including
            its architecture search, and closed models disclose none. Jobs will change, and the cost of large models
            concentrates power in a few firms.
          </>
        ),
      },
      {
        id: '21.4',
        title: 'Case study: inferring sexual orientation from faces',
        page: 431,
        shows: (
          <>
            A 2018 study claimed a network could infer sexual orientation from face photos, and was widely reported. The
            book lists its problems: unrepresentative, mostly white training data; labels and validation that ignore how
            fluid sexuality is; an obvious use in persecuting LGBTQ+ people where they are criminalised; cues that seem
            to come from grooming and presentation rather than face structure; photos scraped from a dating site; and
            claims, starting with the title, that overstated the result. The test it proposes: does the work serve the
            community it concerns?
          </>
        ),
      },
      {
        id: '21.5',
        title: 'The value-free ideal of science',
        page: 432,
        shows: (
          <>
            Values shape which problems are chosen, how evidence is gathered, when a hypothesis is accepted and how
            results are used. Machine learning generalises from samples, so any prediction may be wrong; deciding to act
            on one weighs the cost of being wrong either way, which is a value judgement. Models are useful precisely
            because they are value-laden.
          </>
        ),
      },
      {
        id: '21.6',
        title: 'Responsible research as a collective action problem',
        page: 433,
        shows: (
          <>
            Good outcomes need cooperation that no single researcher is rewarded for. Two concrete steps: communicate
            results without overclaiming or misleading anthropomorphism, and widen who takes part, since homogeneous
            groups build their own perspective into data and code. The closing themes: research cannot avoid ethics,
            technical choices carry values, the structures around AI deserve questioning, and social problems do not
            always have technical fixes.
          </>
        ),
      },
    ],
    inLlms: (
      <p>
        Alignment is now an engineering discipline inside every LLM lab, and the chapter&apos;s framing maps onto it.
        The training objective is a proxy (next-token prediction for a base model, a reward model in RLHF), so outer
        misalignment appears as <b>reward hacking</b> and sycophancy, where the model learns to please the judge rather
        than help. Inner alignment is the worry that a model which behaves well in training has learned something else.
        Information asymmetry is why <b>interpretability</b> research, model cards and system cards exist, and why
        closed models are hard to audit from outside. The misuse section reads as a list of what <b>guardrails</b> and
        usage policies try to block: fraud, disinformation, privacy leaks and memorised training data. Approaches such
        as Constitutional AI write the values down, which addresses the normative half of the problem that the chapter
        says no technique settles alone.
      </p>
    ),
    next: [
      <>
        <b>Constitutional AI</b> (Bai et al., 2022) trains a harmless assistant from a short written list of principles,
        using AI feedback in place of most human harm labels, so the encoded values are explicit and open to inspection.
      </>,
      <>
        <b>Scaling laws for reward model overoptimisation</b> (Gao et al., 2023) measure outer misalignment directly: as
        a policy optimises a learned reward harder, the true reward first rises and then falls.
      </>,
      <>
        <b>Sleeper agents</b> (Hubinger et al., 2024) and <b>alignment faking</b> (Greenblatt et al., 2024) study
        inner-alignment failures in LLMs: hidden behaviour that survives safety training, and a model that complies in
        training to avoid being changed.
      </>,
      <>
        <b>Weak-to-strong generalisation</b> (Burns et al., 2023) asks how a weaker supervisor can align a stronger
        model, the principal–agent information gap at its sharpest.
      </>,
      <>
        <b>Extracting training data from large language models</b> (Carlini et al., 2021) showed that models can
        reproduce memorised personal data word for word, making the chapter&apos;s privacy and copyright risks concrete.
      </>,
    ],
    labs: [
      ['/guardrails', 'Guardrails'],
      ['/injection', 'Prompt injection'],
      ['/evals', 'Evals'],
      ['/confidence', 'Confidence'],
      ['/preference-tuning', 'Preference tuning'],
    ],
  },
];
