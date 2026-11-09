import { useMemo, useState } from 'react';
import { Chips, Readout, Slider } from '../deep-learning/Notebook';
import { Plot, mix, type Frame } from '../deep-learning/Plot';
import { fmt, gauss, linspace, mean, rng, sum } from '../deep-learning/kit';
import type { BookChapter } from './types';

/* ---------- helpers for the two demos ---------- */

type Pt = [number, number];

/** The current theme's series colours, for legends outside a canvas. */
const SERIES = { s1: 'var(--s1)', s2: 'var(--s2)', s3: 'var(--s3)', s4: 'var(--s4)', brand: 'var(--brand)' };

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

/** Fills the area between two curves, e.g. a ±2σ band, with a translucent colour. */
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

/* ---------- Demo for 5.3c: heteroscedastic regression ---------- */

/** Fixed inputs and unit noise draws, so the slider rescales the same noise rather than drawing new data. */
const HET = (() => {
  const r = rng(534);
  const xs: number[] = [];
  const eps: number[] = [];
  for (let i = 0; i < 48; i++) {
    xs.push(4 * r());
    eps.push(gauss(r));
  }
  return { xs, eps };
})();

/** A regression model that predicts a normal distribution: mean a + b·x and spread σ = |c + d·x|. */
interface HetFit {
  mean: Pt;
  spread: Pt;
}

const meanAt = (f: HetFit, x: number) => f.mean[0] + f.mean[1] * x;
const sigmaAt = (f: HetFit, x: number) => Math.max(Math.abs(f.spread[0] + f.spread[1] * x), 1e-3);

/** Mean negative log-likelihood per point of the data under a fitted normal distribution. */
function meanNll(f: HetFit, xs: number[], ys: number[]): number {
  return mean(
    xs.map((x, i) => {
      const s = sigmaAt(f, x);
      return 0.5 * Math.log(2 * Math.PI * s * s) + (ys[i] - meanAt(f, x)) ** 2 / (2 * s * s);
    }),
  );
}

/** Least squares line plus one σ for every x (the root mean squared residual): the homoscedastic maximum-likelihood fit. */
function fitConstant(xs: number[], ys: number[]): HetFit {
  const mx = mean(xs);
  const my = mean(ys);
  const b = sum(xs.map((x, i) => (x - mx) * (ys[i] - my))) / sum(xs.map((x) => (x - mx) ** 2));
  const a = my - b * mx;
  const rms = Math.sqrt(mean(xs.map((x, i) => (ys[i] - a - b * x) ** 2)));
  return { mean: [a, b], spread: [rms, 0] };
}

/** Fits the mean and σ both as lines in x by minimising the negative log-likelihood with Adam, from the constant fit. */
function fitVarying(xs: number[], ys: number[], start: HetFit): HetFit {
  const p = [start.mean[0], start.mean[1], start.spread[0], start.spread[1]];
  const m = [0, 0, 0, 0];
  const v = [0, 0, 0, 0];
  const steps = 3000;
  const n = xs.length;
  for (let t = 1; t <= steps; t++) {
    const g = [0, 0, 0, 0];
    for (let i = 0; i < n; i++) {
      const x = xs[i];
      const r = ys[i] - (p[0] + p[1] * x);
      const s = p[2] + p[3] * x;
      const sa = Math.max(Math.abs(s), 1e-3);
      const dMu = -r / (sa * sa);
      const dS = (1 / sa - (r * r) / (sa * sa * sa)) * (s >= 0 ? 1 : -1);
      g[0] += dMu / n;
      g[1] += (dMu * x) / n;
      g[2] += dS / n;
      g[3] += (dS * x) / n;
    }
    const lr = 0.02 * (1 - t / steps) + 0.001;
    for (let k = 0; k < 4; k++) {
      m[k] = 0.9 * m[k] + 0.1 * g[k];
      v[k] = 0.999 * v[k] + 0.001 * g[k] * g[k];
      const mHat = m[k] / (1 - 0.9 ** t);
      const vHat = v[k] / (1 - 0.999 ** t);
      p[k] -= (lr * mHat) / (Math.sqrt(vHat) + 1e-8);
    }
  }
  return { mean: [p[0], p[1]], spread: [p[2], p[3]] };
}

type HetModel = 'const' | 'vary';

function HeteroscedasticDemo() {
  const [growth, setGrowth] = useState(0.35);
  const [model, setModel] = useState<HetModel>('vary');
  const { ys, constant, varying } = useMemo(() => {
    const ys = HET.xs.map((x, i) => 0.5 + 0.6 * x + (0.15 + growth * x) * HET.eps[i]);
    const constant = fitConstant(HET.xs, ys);
    return { ys, constant, varying: fitVarying(HET.xs, ys, constant) };
  }, [growth]);
  const fit = model === 'const' ? constant : varying;
  const grid = linspace(0, 4, 41);
  const outside = (lo: number, hi: number) => {
    const idx = HET.xs.map((x, i) => [x, i] as Pt).filter(([x]) => x >= lo && x < hi);
    const miss = idx.filter(([x, i]) => Math.abs(ys[i] - meanAt(fit, x)) > 2 * sigmaAt(fit, x)).length;
    return `${miss} of ${idx.length}`;
  };
  return (
    <div className="dl-body">
      <div className="dl-controls">
        <Chips
          options={[
            { id: 'const', label: 'Constant σ' },
            { id: 'vary', label: 'σ depends on x' },
          ]}
          value={model}
          onChange={setModel}
        />
        <Slider label="how fast the noise grows" value={growth} min={0} max={0.5} onChange={setGrowth} />
      </div>
      <Legend
        items={[
          [SERIES.s1, 'predicted mean and ±2σ band'],
          [SERIES.s4, 'true ±2σ (dashed)'],
        ]}
      />
      <Plot
        x={[0, 4]}
        y={[-2.5, 7.5]}
        height={260}
        xLabel="x"
        yLabel="y"
        ariaLabel="Data whose noise grows with x, with the fitted mean and a band of two predicted standard deviations"
        draw={(f) => {
          const mu = grid.map((x) => meanAt(fit, x));
          const sd = grid.map((x) => sigmaAt(fit, x));
          band(
            f,
            grid,
            mu.map((m, i) => m - 2 * sd[i]),
            mu.map((m, i) => m + 2 * sd[i]),
            f.c.s1,
          );
          const truth = grid.map((x) => 0.5 + 0.6 * x);
          const trueSd = grid.map((x) => 0.15 + growth * x);
          f.line(
            grid,
            truth.map((t, i) => t + 2 * trueSd[i]),
            f.c.s4,
            1.5,
            [5, 4],
          );
          f.line(
            grid,
            truth.map((t, i) => t - 2 * trueSd[i]),
            f.c.s4,
            1.5,
            [5, 4],
          );
          f.line(grid, mu, f.c.s1, 2);
          f.dots(
            HET.xs.map((x, i) => [x, ys[i]] as Pt),
            f.c.ink,
            3,
          );
        }}
      />
      <div className="dl-caption">
        Both models predict a normal distribution for y at each x. Here the mean and σ are each a straight line in x
        (the book uses a shallow network for each); σ = |c + dx| keeps it positive. Both are fitted by minimising the
        negative log-likelihood.
      </div>
      <Readout
        items={[
          ['NLL per point, constant σ', fmt(meanNll(constant, HET.xs, ys))],
          ['NLL per point, σ depends on x', fmt(meanNll(varying, HET.xs, ys))],
          ['σ at x = 0.5 / 3.5', `${fmt(sigmaAt(fit, 0.5), 2)} / ${fmt(sigmaAt(fit, 3.5), 2)}`],
          ['points outside ±2σ, x < 2', outside(0, 2)],
          ['points outside ±2σ, x ≥ 2', outside(2, 4.01)],
        ]}
      />
      <p className="small muted">
        With the constant model, the band is too wide on the left and too narrow on the right: it misses more points
        where the data is noisy. Letting σ depend on x lowers the loss and makes the band honest in both halves. Set the
        growth to 0 and the two models agree.
      </p>
    </div>
  );
}

/* ---------- Demo for 6.4a: normalised (sign) steps against gradient descent and Adam ---------- */

const SG_X: Pt = [-9, 2];
const SG_Y: Pt = [-2.2, 2.2];
const SG_START: Pt = [-8, 1.7];
const SG_STEPS = 80;
/** 100 times steeper across φ₁ than along φ₀, like the surface in the book's Adam figure. */
const sgLoss = (a: number, b: number) => 0.5 * (0.1 * a * a + 10 * b * b);
const sgGrad = (a: number, b: number): Pt => [0.1 * a, 10 * b];
const SG_LOG_LO = Math.log(1e-3);
const SG_LOG_HI = Math.log(sgLoss(-9, 2.2));

type Method = 'gd' | 'sign' | 'adam';
const METHODS: { id: Method; label: string; colour: keyof typeof SERIES }[] = [
  { id: 'gd', label: 'gradient descent (α = 0.18)', colour: 's2' },
  { id: 'sign', label: 'sign steps', colour: 's4' },
  { id: 'adam', label: 'Adam', colour: 'brand' },
];

/** Runs the three optimisers from the same start; the paths are short, so they are computed in one go. */
function runOptimisers(alpha: number, cosine: boolean): Record<Method, Pt[]> {
  const decay = (t: number) => (cosine ? 0.5 * (1 + Math.cos((Math.PI * t) / SG_STEPS)) : 1);
  const sign = (v: number) => Math.sign(v);
  const out: Record<Method, Pt[]> = { gd: [SG_START], sign: [SG_START], adam: [SG_START] };
  let adamM: Pt = [0, 0];
  let adamV: Pt = [0, 0];
  for (let t = 1; t <= SG_STEPS; t++) {
    const k = decay(t - 1);
    const rate = alpha * k;
    // Plain gradient descent, with the largest fixed rate that is stable across the steep direction.
    const [a0, b0] = out.gd[t - 1];
    const g0 = sgGrad(a0, b0);
    out.gd.push([a0 - 0.18 * k * g0[0], b0 - 0.18 * k * g0[1]]);
    // Normalised gradient: keep only the sign, so every coordinate moves by the same amount.
    const [a1, b1] = out.sign[t - 1];
    const g1 = sgGrad(a1, b1);
    out.sign.push([a1 - rate * sign(g1[0]), b1 - rate * sign(g1[1])]);
    // Adam: smoothed gradient over the root of the smoothed squared gradient, both bias-corrected.
    const [a2, b2] = out.adam[t - 1];
    const g2 = sgGrad(a2, b2);
    adamM = [0.9 * adamM[0] + 0.1 * g2[0], 0.9 * adamM[1] + 0.1 * g2[1]];
    adamV = [0.999 * adamV[0] + 0.001 * g2[0] ** 2, 0.999 * adamV[1] + 0.001 * g2[1] ** 2];
    const step = (j: 0 | 1) => {
      const mHat = adamM[j] / (1 - 0.9 ** t);
      const vHat = adamV[j] / (1 - 0.999 ** t);
      return (rate * mHat) / (Math.sqrt(vHat) + 1e-8);
    };
    out.adam.push([a2 - step(0), b2 - step(1)]);
  }
  return out;
}

type Schedule = 'constant' | 'cosine';

function SignStepsDemo() {
  const [alpha, setAlpha] = useState(0.3);
  const [schedule, setSchedule] = useState<Schedule>('constant');
  const [t, setT] = useState(SG_STEPS);
  const paths = useMemo(() => runOptimisers(alpha, schedule === 'cosine'), [alpha, schedule]);
  const losses = useMemo(() => {
    const out = {} as Record<Method, number[]>;
    for (const { id } of METHODS) out[id] = paths[id].map(([a, b]) => Math.log10(Math.max(sgLoss(a, b), 1e-9)));
    return out;
  }, [paths]);
  const steps = linspace(0, SG_STEPS, SG_STEPS + 1);
  return (
    <div className="dl-body">
      <div className="dl-controls">
        <Slider label="step size α" value={alpha} min={0.05} max={0.6} onChange={setAlpha} />
        <Chips
          options={[
            { id: 'constant', label: 'Constant α' },
            { id: 'cosine', label: 'Cosine decay' },
          ]}
          value={schedule}
          onChange={setSchedule}
        />
        <Slider label="show up to step" value={t} min={0} max={SG_STEPS} step={1} onChange={setT} show={String} />
      </div>
      <Legend items={METHODS.map((m) => [SERIES[m.colour], m.label] as [string, string])} />
      <div className="dl-cols">
        <div>
          <Plot
            x={SG_X}
            y={SG_Y}
            height={240}
            xLabel="φ₀"
            yLabel="φ₁"
            ariaLabel="A loss surface far steeper in one direction, with the paths of three optimisers"
            draw={(f) => {
              f.heat((a, b) => {
                const v = (Math.log(sgLoss(a, b) + 1e-3) - SG_LOG_LO) / (SG_LOG_HI - SG_LOG_LO);
                return mix(f.c.surface, f.c.s1, 0.55 * (1 - Math.min(1, Math.max(0, v))));
              }, 70);
              for (const m of METHODS) {
                const path = paths[m.id].slice(0, t + 1);
                f.line(
                  path.map((p) => p[0]),
                  path.map((p) => p[1]),
                  f.c[m.colour],
                  1.6,
                );
                f.dots([path[path.length - 1]], f.c[m.colour], 4);
              }
              f.dots([[0, 0]], f.c.ink, 2.5);
            }}
          />
          <div className="dl-caption">L = ½(0.1φ₀² + 10φ₁²); darker is lower. All three start at (−8, 1.7).</div>
        </div>
        <div>
          <Plot
            x={[0, SG_STEPS]}
            y={[-8, 2]}
            height={240}
            xLabel="step"
            yLabel="log₁₀ loss"
            ariaLabel="Loss of the three optimisers against step"
            draw={(f) => {
              for (const m of METHODS) f.line(steps, losses[m.id], f.c[m.colour], 2);
              f.vline(t, f.c.muted, [2, 3]);
            }}
          />
          <div className="dl-caption">The dotted line marks the step shown on the left.</div>
        </div>
      </div>
      <Readout
        items={METHODS.map((m) => [`${m.id === 'gd' ? 'gradient descent' : m.label} loss`, fmt(10 ** losses[m.id][t])])}
      />
      <p className="small muted">
        Sign steps move both parameters by α each time, so they cross the shallow direction quickly, but with a fixed α
        they never settle: they rattle back and forth across the steep direction. Adam starts out almost the same (its
        first step is exactly a sign step) and then damps the rattle as its averages build up. Switch to cosine decay:
        once α shrinks, the sign steps settle too. That is why sign-based optimisers such as Lion are always paired with
        a falling learning rate.
      </p>
    </div>
  );
}

/* ---------- The chapters ---------- */

export const CHAPTERS: BookChapter[] = [
  {
    n: 1,
    title: 'Introduction',
    offers: (
      <p>
        A map of the field before any maths. It splits machine learning into supervised, unsupervised and reinforcement
        learning, shows how real inputs and outputs become vectors of numbers, and introduces generative models and
        latent variables, which the second half of the book builds on. It ends with a direct section on the harms AI can
        cause.
      </p>
    ),
    examples: [
      {
        id: '1.1a',
        title: 'Regression and classification problems',
        page: 2,
        shows: (
          <>
            <p>
              Five small tasks cover the main output types: a house price (one number), a molecule&apos;s freezing and
              boiling points (several numbers), whether a restaurant review is positive (two classes), and the genre of
              a music clip or the object in a photo (many classes). The model is a black box from one vector of numbers
              to another; for a classifier, the output vector holds a probability for each class.
            </p>
            <p>An LLM is the last kind, with one class for every token in its vocabulary.</p>
          </>
        ),
      },
      {
        id: '1.1b',
        title: 'Encoding text, audio and images',
        page: 2,
        shows: (
          <p>
            The inputs differ in shape. House features are tabular: their order carries no meaning. A review is a
            sequence whose word order matters, encoded as indices into a vocabulary of 10,000 words. Ten seconds of
            audio at 44.1 kHz is 441,000 numbers, and an image has spatial structure that a flat vector hides. Later
            chapters design a network for each kind of structure, and tokenisation is the LLM version of this step.
          </p>
        ),
      },
      {
        id: '1.1c',
        title: "Predicting a child's height from age",
        page: 4,
        shows: (
          <p>
            The plainest picture of a model: a curve through pairs of ages and heights, which predicts 139 cm at age 10.
            The model is really a whole family of curves, and training picks the member that best matches the labelled
            examples. Those labels play the part of a teacher, which is where the name supervised learning comes from.
          </p>
        ),
        notebooks: ['2.1'],
      },
      {
        id: '1.1d',
        title: 'Outputs with structure',
        page: 5,
        shows: (
          <p>
            Segmentation, depth estimation, speech transcription, translation and text-to-image all produce large,
            structured outputs. Two things make the last three hard: there are many correct answers, and the output must
            obey a grammar (valid French, a plausible image). The grammar can be learned from unlabelled data alone.
            That is the bridge to generative models, and the reason LLMs are pre-trained on raw text.
          </p>
        ),
      },
      {
        id: '1.2a',
        title: 'Generating and completing text',
        page: 7,
        shows: (
          <p>
            A short story sampled from a model of text, and GPT-3 continuing a passage it was given (figures 1.6 and
            1.8). The second is conditional generation: part of the output is fixed and the model fills in the rest. The
            book warns that the model completes documents from the statistics of language, not from understanding. This
            is exactly how a base model behaves before instruction tuning.
          </p>
        ),
      },
      {
        id: '1.2b',
        title: 'Latent variables and the human face',
        page: 9,
        shows: (
          <p>
            A face is moved by about 42 muscles, so most of the variation in pictures of one person under fixed lighting
            could be described by about 42 numbers. Real data fills a tiny, low-dimensional part of the space of all
            possible inputs. A generative model can sample a few simple latent numbers and map them to data, and moving
            between two latent codes blends two real images (figure 1.11).
          </p>
        ),
      },
      {
        id: '1.2c',
        title: 'From a caption to images through latent spaces',
        page: 11,
        shows: (
          <p>
            Mapping a caption straight to pixels is hard. Mapping the caption&apos;s latent variables to the
            image&apos;s latent variables has three benefits: it needs fewer paired examples, any sensible latent gives
            a plausible picture, and adding randomness gives many different images for one caption (figure 1.12).
          </p>
        ),
      },
      {
        id: '1.3',
        title: 'A walking robot and a chess player',
        page: 12,
        shows: (
          <p>
            Two reinforcement-learning settings. A robot rewarded at checkpoints, and a chess player rewarded only for
            winning, both face temporal credit assignment: which of many actions earned the reward? Both also face the
            choice between exploiting a known strategy (shuffling along on its side) and exploring for a better one
            (learning to walk). A policy network maps the observed state to an action.
          </p>
        ),
      },
      {
        id: '1.4',
        title: 'A salary model that learns old biases',
        page: 13,
        shows: (
          <p>
            Trained on historical pay, a model would predict lower salaries for women, because the data records that
            history. The section adds real cases (a face upscaler that made people look whiter, an image generator that
            drew only men as lawyers) and goes on to explainability, military use, concentration of power and
            existential risk. The point for practitioners: the training data&apos;s past becomes the model&apos;s
            prediction unless someone checks.
          </p>
        ),
      },
    ],
    inLlms: (
      <>
        <p>
          An LLM is a generative model of text. Pre-training is the book&apos;s unsupervised case done with a supervised
          loss: every position in the corpus supplies its own label, the next token, so no human labelling is needed.
          This is called <i>self-supervised</i> learning. Text completion (1.2a) is exactly what the resulting base
          model does.
        </p>
        <p>
          Instruction tuning and preference tuning then reshape it, and reinforcement learning treats each generated
          token as an action and the score of the finished answer as a delayed reward. The credit-assignment problem
          from 1.3 returns inside reasoning-model training, and the bias and explainability concerns of 1.4 are now
          central to how models are evaluated and released.
        </p>
      </>
    ),
    next: [
      'Scaling laws (Kaplan et al., 2020): language-model loss falls as a smooth power law in parameters, data and compute, which made large training runs plannable.',
      'RLHF for instruction following, InstructGPT (Ouyang et al., 2022): a reward model learned from human rankings, then reinforcement learning with the language model as the policy.',
      'Reinforcement learning from verifiable rewards, as in DeepSeek-R1 (DeepSeek-AI, 2025) using GRPO (Shao et al., 2024): long reasoning learned from a reward given only for a correct final answer.',
      'Constitutional AI (Bai et al., 2022): a written set of principles and AI feedback replace much of the human labelling used to make a model harmless.',
      'Sparse-autoencoder interpretability, "Towards Monosemanticity" (Bricken et al., 2023): splitting a model\'s activations into features people can name, a direct attack on the explainability problem.',
    ],
    labs: [
      ['/what-is-gpt', 'What is GPT'],
      ['/ml', 'Machine learning'],
      ['/preference-tuning', 'Preference tuning'],
      ['/reasoning-models', 'Reasoning models'],
    ],
  },
  {
    n: 2,
    title: 'Supervised learning',
    offers: (
      <p>
        The whole supervised recipe on the smallest possible model, a straight line. A model is a family of functions
        picked out by parameters, a loss scores each choice, training searches for the lowest loss, and a separate test
        set says whether the result generalises. Every later chapter swaps in a bigger model, a better loss or a smarter
        search, but keeps this frame.
      </p>
    ),
    examples: [
      {
        id: '2.1',
        title: 'Valuing a used car',
        page: 17,
        shows: (
          <p>
            The age and mileage of a second-hand Toyota Prius go in; an estimated price comes out. The example fixes the
            notation used for the rest of the book: an input vector x whose entries always come in the same order, a
            model y = f[x, φ], inference as running the function, and learning as choosing φ from training pairs.
          </p>
        ),
      },
      {
        id: '2.2a',
        title: 'A line as a family of models',
        page: 18,
        shows: (
          <p>
            1D linear regression, y = φ₀ + φ₁x, has two parameters: the intercept and the slope. Each pair of values
            picks one line out of infinitely many, which is the sense in which a model equation describes a family and
            the parameters choose a member.
          </p>
        ),
        notebooks: ['2.1'],
      },
      {
        id: '2.2b',
        title: 'The least-squares loss on twelve points',
        page: 19,
        shows: (
          <p>
            Three candidate lines through the same 12 points are scored by summing the squared vertical gaps to the
            data. Two poor lines score 7.07 and 10.28; the best line scores 0.20. Squaring makes the direction of an
            error irrelevant. Chapter 5 explains why squares, and not some other measure, are the natural choice.
          </p>
        ),
        notebooks: ['2.1'],
      },
      {
        id: '2.2c',
        title: 'The loss surface',
        page: 21,
        shows: (
          <p>
            With only two parameters, the loss can be computed for every pair and drawn as a bowl or a heat map. The
            best line sits at the bottom. Real networks have far too many parameters to draw, so this picture carries
            the intuition for every later chapter on training.
          </p>
        ),
        notebooks: ['2.1'],
      },
      {
        id: '2.2d',
        title: 'Walking downhill',
        page: 22,
        shows: (
          <p>
            Start at random parameters, measure which way the surface slopes, step downhill, and repeat; four steps
            already reach a good line (figure 2.4). A footnote points out that linear regression has a closed-form
            answer, but the iterative method is the one that still works for models with millions of parameters.
          </p>
        ),
        notebooks: ['6.2'],
      },
      {
        id: '2.2e',
        title: 'Testing: underfitting and overfitting',
        page: 22,
        shows: (
          <p>
            Loss on separate test data measures how well the model generalises. A line may be too simple to capture the
            real relationship (underfitting); a very flexible model may learn quirks of the particular training sample
            (overfitting). Chapter 8 returns to this with measurements.
          </p>
        ),
      },
    ],
    inLlms: (
      <>
        <p>
          An LLM is still y = f[x, φ]: x is the tokens so far, y is a distribution over the next token, and φ is
          billions of numbers instead of two. Running it is inference; training is the same argmin over a loss.
        </p>
        <p>
          The straight line survives too. Every projection in a transformer (queries, keys, values, the MLP layers and
          the final unembedding) is a linear map like φ₀ + φ₁x, scaled up to matrices. The test set becomes validation
          loss during training and benchmarks afterwards, and <i>contamination</i>, where test items leak into the
          training data, is the modern way of accidentally testing on what you trained on.
        </p>
      </>
    ),
    next: [
      'Compute-optimal scaling, Chinchilla (Hoffmann et al., 2022): for a fixed compute budget, grow parameters and training tokens together, at roughly 20 tokens per parameter.',
      'Deep double descent (Nakkiran et al., 2019), building on Belkin et al. (2019): test error can fall again as models grow past the size where they fit the training set exactly, which revises the simple underfit-overfit picture.',
      "Linear probes (Alain & Bengio, 2016): fit a linear model like this chapter's to a network's hidden activations to test what information each layer holds.",
      'Contamination-resistant evaluation such as LiveBench (White et al., 2024): questions released over time keep the test set apart from training data.',
    ],
    labs: [
      ['/ml', 'Machine learning'],
      ['/training', 'Training'],
      ['/benchmarks', 'Benchmarks'],
      ['/evals', 'Evals'],
    ],
  },
  {
    n: 3,
    title: 'Shallow neural networks',
    offers: (
      <p>
        One hidden layer, taken apart piece by piece. With ReLU activations a shallow network builds a piecewise-linear
        function: each hidden unit adds one joint, and the output is a weighted sum of clipped lines (or, with more
        inputs, clipped planes). The chapter shows why this family can approximate any continuous function, counts its
        linear regions, and sets out the vocabulary (weights, biases, pre-activations, activations, MLP) used for the
        rest of the book.
      </p>
    ),
    examples: [
      {
        id: '3.1a',
        title: 'A network with ten parameters',
        page: 25,
        shows: (
          <p>
            One input, three hidden units, one output: y = φ₀ + φ₁a[θ₁₀ + θ₁₁x] + φ₂a[θ₂₀ + θ₂₁x] + φ₃a[θ₃₀ + θ₃₁x],
            with a[·] the ReLU. Different values of the ten parameters give different continuous piecewise-linear
            functions, each with at most four pieces.
          </p>
        ),
        notebooks: ['3.1'],
      },
      {
        id: '3.1b',
        title: 'Building the output from clipped lines',
        page: 26,
        shows: (
          <p>
            The computation in stages (figure 3.3): three lines, each clipped at zero, each scaled by its output weight,
            then summed with an offset. A joint appears where a unit&apos;s line crosses zero. Each region has its own
            activation pattern (which units are on), and its slope is the sum of θ·φ over the active units, for example
            θ₁₁φ₁ + θ₃₁φ₃ where units 1 and 3 are on. Only three of the four slopes are free.
          </p>
        ),
        notebooks: ['3.1'],
      },
      {
        id: '3.2',
        title: 'Universal approximation by adding joints',
        page: 29,
        shows: (
          <p>
            With D hidden units there are at most D joints and D + 1 pieces. More pieces follow any continuous curve on
            a bounded interval more closely (figure 3.5). The universal approximation theorem guarantees that some
            shallow network reaches any accuracy you ask for; it says nothing about how many units that takes or whether
            training will find them.
          </p>
        ),
      },
      {
        id: '3.3a',
        title: 'One input, two outputs',
        page: 30,
        shows: (
          <p>
            Four hidden units feed two outputs, each its own weighted sum of the same units (18 parameters). The two
            output functions share their joints but have different slopes and heights: different mixtures of the same
            features. An LLM&apos;s final layer works the same way, scoring every token in the vocabulary from one
            shared hidden vector.
          </p>
        ),
      },
      {
        id: '3.3b',
        title: 'Two inputs, three hidden units',
        page: 31,
        shows: (
          <p>
            Each hidden unit is now a tilted plane, clipped along a line. Summing three clipped planes gives a surface
            of flat convex polygons, seven in the book&apos;s example (figure 3.8), each with its own activation
            pattern.
          </p>
        ),
        notebooks: ['3.2'],
      },
      {
        id: '3.3c',
        title: 'Counting linear regions',
        page: 33,
        shows: (
          <p>
            Each unit&apos;s joint is a hyperplane. With as many units as inputs and the hyperplanes on the axes, D
            <sub>i</sub> inputs give 2<sup>Di</sup> regions (quadrants, octants, …). Zaslavsky&apos;s bound counts the
            general case: Σ<sub>j=0..Di</sub> C(D, j), which is 7 for three units and two inputs. With 500 units and 100
            inputs, a network of only 51,001 parameters can have more than 10<sup>107</sup> regions.
          </p>
        ),
        notebooks: ['3.3'],
      },
      {
        id: '3.4a',
        title: 'Three inputs, two outputs',
        page: 33,
        shows: (
          <p>
            The general shallow network (equations 3.11 and 3.12), drawn for three inputs, three hidden units and two
            outputs: 15 weights and 5 biases, 20 parameters. The activation must be non-linear; with a linear one the
            whole network collapses into a single linear map, however many units it has.
          </p>
        ),
      },
      {
        id: '3.4b',
        title: 'Other activation functions',
        page: 37,
        shows: (
          <p>
            The chapter notes survey alternatives to the ReLU (figure 3.13). Sigmoid and tanh flatten out at both ends,
            so their gradients vanish; the ReLU&apos;s zero gradient below zero can leave a unit permanently off (a
            dying ReLU). Leaky and parametric ReLU, softplus, GELU, SiLU/Swish, ELU, SELU and HardSwish each smooth or
            patch this. No single choice wins everywhere; the book keeps the ReLU because its regions are easy to count.
          </p>
        ),
        notebooks: ['3.4'],
      },
    ],
    inLlms: (
      <>
        <p>
          Every transformer layer contains a shallow network: the feed-forward (MLP) block. It widens each token&apos;s
          vector to a larger hidden layer (768 to 3,072 in GPT-2 small), applies an activation, and projects back. That
          is equations 3.11 and 3.12, applied to each position separately. In a standard dense transformer about
          two-thirds of each layer&apos;s parameters sit in this block.
        </p>
        <p>
          The activation has moved on from the ReLU: GPT-2 uses GELU, and LLaMA-style models use SwiGLU, a gated
          variant. Interpretability research calls the hidden units <i>neurons</i> and studies their pre-activations,
          using the vocabulary this chapter sets out.
        </p>
      </>
    ),
    next: [
      'GLU variants in the feed-forward block (Shazeer, 2020): gating one projection with another, as SwiGLU does, improved transformer quality and became standard in open models.',
      'Mixture of experts, Switch Transformer (Fedus et al., 2021): many feed-forward networks per layer and a router that sends each token to one, so parameters grow without growing the compute per token.',
      'Feed-forward layers as key-value memories (Geva et al., 2021): the first layer detects patterns in the input and the second writes out what tends to follow, a reading of the MLP block as stored knowledge.',
      'Toy models of superposition (Elhage et al., 2022): networks store more features than they have neurons by overlapping them, which is why single neurons are hard to interpret.',
      'Kolmogorov-Arnold Networks (Liu et al., 2024): learnable activation functions on the connections instead of fixed ones on the units, a different answer to the approximation question.',
    ],
    labs: [
      ['/transformer', 'Transformer'],
      ['/building', 'Building a GPT'],
      ['/deep-learning', 'Deep learning notebooks'],
    ],
  },
  {
    n: 4,
    title: 'Deep neural networks',
    offers: (
      <p>
        Why stack layers. Composing two shallow networks shows that the first can fold its input so that the second
        network&apos;s pattern repeats, multiplying the number of linear regions. The chapter then writes a deep network
        in matrix form, names its hyperparameters (depth and width), and weighs deep against shallow: far more regions
        per parameter and better results in practice, with honest caveats about how much of that is understood.
      </p>
    ),
    examples: [
      {
        id: '4.1a',
        title: 'Composing two three-unit networks',
        page: 41,
        shows: (
          <p>
            The first network zig-zags across the range [−1, 1] three times, so the second network&apos;s three-piece
            function is replayed on each stretch, flipped and rescaled. The result has nine linear regions; the same six
            hidden units used side by side in one layer could make at most seven.
          </p>
        ),
        notebooks: ['4.1'],
      },
      {
        id: '4.1b',
        title: 'Composition with two inputs',
        page: 43,
        shows: (
          <p>
            The two-input network from figure 3.8 (seven regions, one of them flat) feeds a second network with two
            units. Each of the six sloped regions is split in two by the second network, giving 13 regions (figure 4.2).
          </p>
        ),
      },
      {
        id: '4.1c',
        title: 'Folding the input space',
        page: 43,
        shows: (
          <p>
            Another reading of the same composition: the first network folds the input line back onto itself, the second
            applies its function to the folded line, and unfolding reveals the copies (figure 4.3). Each layer can fold
            again, which is why the number of pieces can grow exponentially with depth.
          </p>
        ),
        notebooks: ['4.1', '4.2'],
      },
      {
        id: '4.2',
        title: 'From composition to a two-layer network',
        page: 43,
        shows: (
          <p>
            Substituting the first network&apos;s output into the second network&apos;s pre-activations gives a network
            with two hidden layers whose nine middle weights are forced to be an outer product. Let those nine weights
            take any values and you have a general deep network, which can do everything the composition could and more.
          </p>
        ),
      },
      {
        id: '4.3',
        title: 'Two hidden layers of three units',
        page: 45,
        shows: (
          <p>
            A second way to see depth (figure 4.5): the second layer&apos;s pre-activations are three piecewise-linear
            functions sharing the first layer&apos;s joints; the ReLU clips each, adding new joints; the output sums
            them. Written as one expression (equation 4.10) the network is correct but unreadable, a reminder that it is
            still just an equation.
          </p>
        ),
        notebooks: ['4.2'],
      },
      {
        id: '4.4',
        title: 'Weights as matrices',
        page: 48,
        shows: (
          <p>
            A network with 3 inputs, hidden layers of 4, 2 and 3 units, and 2 outputs (figure 4.6). The weight matrices
            are 4×3, 2×4, 3×2 and 2×3, and the bias vectors have lengths 4, 2, 3 and 2: 43 parameters in all. The
            general form h<sub>k</sub> = a[β<sub>k−1</sub> + Ω<sub>k−1</sub>h<sub>k−1</sub>] is how every deep network
            is written from here on.
          </p>
        ),
      },
      {
        id: '4.5',
        title: 'Regions per parameter, shallow against deep',
        page: 50,
        shows: (
          <>
            <p>
              With one input, a shallow network of D units makes at most D + 1 regions from 3D + 1 parameters. K layers
              of D units make up to (D + 1)<sup>K</sup> regions from 3D + 1 + (K − 1)D(D + 1) parameters: five layers of
              ten units have 471 parameters and up to 161,051 regions. Problem 4.11 sharpens the contrast: a shallow
              network of 95 units and a deep one of 10 layers of 5 units both have 286 parameters, but the first makes
              at most 96 regions and the second up to 6<sup>10</sup>, about 60 million.
            </p>
            <p>
              The book is careful: those regions are not placed freely, so they only help if the target function has
              matching structure. Depth also helps through local-to-global processing of large inputs and, in practice,
              easier training and better generalisation, neither fully explained.
            </p>
          </>
        ),
        notebooks: ['4.3'],
      },
    ],
    inLlms: (
      <>
        <p>
          An LLM is a deep network written exactly as in equation 4.15: dozens of layers (12 in GPT-2 small, 96 in
          GPT-3), each a few matrix multiplications with non-linearities between them. That is why GPUs, built for
          matrix arithmetic, run them so well. Depth and width (the number of layers and the model dimension) are the
          first hyperparameters any model card lists.
        </p>
        <p>
          One change matters a great deal. A transformer layer adds its output to a running <i>residual stream</i>{' '}
          instead of replacing its input (chapter 11), so later layers refine what earlier ones wrote rather than only
          folding it. Probing studies find earlier layers carrying more local, surface features of the tokens and later
          layers more abstract ones, a loose echo of the local-to-global argument in 4.5.
        </p>
      </>
    ),
    next: [
      'Recurrent depth (Geiping et al., 2025): run one block of layers many times at inference, so a model can spend more depth on harder inputs without adding parameters.',
      'Mixture-of-Depths (Raposo et al., 2024): a router lets each token skip some layers, spending depth only where it helps.',
      'Layer pruning, "The Unreasonable Ineffectiveness of the Deeper Layers" (Gromov et al., 2024): many of the deepest layers of open LLMs can be removed with little loss after a short repair fine-tune, a hint that depth is under-used.',
      'Early exit with LayerSkip (Elhoushi et al., 2024): train intermediate layers to predict tokens, then draft with the early layers and check with the full model.',
      "The tuned lens (Belrose et al., 2023): decode each layer's hidden state into a next-token prediction to watch the answer form with depth.",
    ],
    labs: [
      ['/transformer', 'Transformer'],
      ['/building', 'Building a GPT'],
      ['/transformer-tricks', 'Transformer tricks'],
      ['/hardware', 'Hardware'],
    ],
  },
  {
    n: 5,
    title: 'Loss functions',
    offers: (
      <p>
        Where loss functions come from. Instead of predicting y directly, the network predicts the parameters of a
        probability distribution over y, and training makes the observed data as probable as possible. One recipe then
        produces least squares (normal distribution), binary cross-entropy (Bernoulli) and multiclass cross-entropy
        (categorical), and extends to counts, angles, rankings and more. The chapter closes by showing that minimising
        negative log-likelihood and minimising cross-entropy are the same thing.
      </p>
    ),
    examples: [
      {
        id: '5.1a',
        title: 'Predicting distributions instead of values',
        page: 57,
        shows: (
          <p>
            Four cases set the new point of view (figure 5.1): a real-valued output with a normal curve predicted at
            each x, four classes with a histogram at each x, counts, and angles. In each, the network outputs the
            parameters of a distribution, and the loss rewards putting high probability on the y that was actually
            observed.
          </p>
        ),
      },
      {
        id: '5.1b',
        title: 'Why take logs',
        page: 59,
        shows: (
          <p>
            The likelihood is a product of many probabilities, each often small, so it quickly becomes too small for a
            computer to hold. The logarithm keeps the same maximum (it only ever increases) and turns the product into a
            sum. A minus sign turns maximising into minimising: the negative log-likelihood. For a single answer at
            inference time, return the most probable y.
          </p>
        ),
      },
      {
        id: '5.3a',
        title: 'Univariate regression gives least squares',
        page: 61,
        shows: (
          <p>
            Let the network predict the mean of a normal distribution with a fixed variance. Write out the negative
            log-likelihood, drop the terms that do not depend on the parameters, and what is left is the sum of squared
            errors. Least squares is maximum likelihood under independent Gaussian noise, which answers the question
            left open in chapter 2.
          </p>
        ),
        notebooks: ['5.1'],
      },
      {
        id: '5.3b',
        title: 'Learning the variance too',
        page: 62,
        shows: (
          <p>
            The variance does not move the best mean, but it can be learned alongside it. For a given line the best σ is
            the root mean squared residual. The model now reports how uncertain it is, though the uncertainty is the
            same for every input.
          </p>
        ),
        notebooks: ['5.1'],
      },
      {
        id: '5.3c',
        title: 'Heteroscedastic regression',
        page: 64,
        shows: (
          <p>
            A second network output predicts the spread, squared so that the variance stays positive, and the
            uncertainty can now change with the input (figure 5.5). The notebooks only cover a constant σ, so the demo
            below fits both models to data whose noise grows with x and compares how honest their ±2σ bands are.
          </p>
        ),
        Demo: HeteroscedasticDemo,
      },
      {
        id: '5.4',
        title: 'Binary classification',
        page: 64,
        shows: (
          <p>
            For a yes/no label (is the review positive, is a tumour present) the distribution is a Bernoulli with one
            parameter λ, the probability of a 1. A logistic sigmoid squashes the network&apos;s output into [0, 1] to
            give λ, and the negative log-likelihood is the binary cross-entropy. To give a single answer, predict 1 when
            λ is above 0.5.
          </p>
        ),
        notebooks: ['5.2'],
      },
      {
        id: '5.5a',
        title: 'Multiclass classification',
        page: 67,
        shows: (
          <p>
            For K classes the distribution is categorical. Softmax turns K arbitrary outputs into K positive numbers
            that sum to one (figure 5.10, with K = 3), and the loss is −log of the probability given to the correct
            class: the multiclass cross-entropy. One of the book&apos;s two examples is predicting which of K words
            comes next in a sentence, which is the training objective of every LLM.
          </p>
        ),
        notebooks: ['5.3'],
      },
      {
        id: '5.5b',
        title: 'A distribution for every data type',
        page: 69,
        shows: (
          <p>
            The same recipe covers other outputs once a suitable distribution is chosen (figure 5.11): Laplace or t for
            regression that resists outliers, a mixture of Gaussians when one input has several likely outputs (the
            notes&apos; example could be near −2 or +3 but not between), exponential or gamma for positive values, beta
            for proportions, von Mises for directions, Poisson for counts and Plackett-Luce for rankings.
          </p>
        ),
      },
      {
        id: '5.6',
        title: 'Several outputs at once',
        page: 69,
        shows: (
          <p>
            Treat each output as independent and the likelihood becomes a product, so the losses add. Outputs of
            different types combine the same way: wind direction with a von Mises distribution and wind speed with an
            exponential one, in a single loss.
          </p>
        ),
      },
      {
        id: '5.7',
        title: 'Cross-entropy as a distance between distributions',
        page: 71,
        shows: (
          <p>
            Describe the training data as a set of point masses and measure the KL divergence from that to the
            model&apos;s distribution. One term does not depend on the model, and the term that remains is the
            cross-entropy, equal to the negative log-likelihood up to a factor of 1/I. The two names in common use
            describe one quantity.
          </p>
        ),
      },
    ],
    inLlms: (
      <>
        <p>
          Pre-training an LLM is example 5.5a at scale. At each position the model outputs one number (a logit) per
          vocabulary entry, 50,257 for GPT-2; softmax turns them into a categorical distribution; and the loss is −log
          of the probability given to the real next token. The training curves in every LLM paper plot this
          cross-entropy, and perplexity is its exponential.
        </p>
        <p>
          Two details differ from the chapter. Tokens in a sequence are not independent: the chain rule splits the
          sequence&apos;s probability into next-token terms, each conditioned on everything before it, so the losses
          still add. And implementations take the log inside the softmax (log-softmax) for the numerical reason in 5.1b.
          At generation time the predicted distribution is sampled, often after dividing the logits by a{' '}
          <i>temperature</i>. Because the model predicts a whole distribution, its uncertainty already varies with the
          input, as in the heteroscedastic example.
        </p>
      </>
    ),
    next: [
      "Knowledge distillation (Hinton et al., 2015): train a small model with cross-entropy against a large model's full output distribution instead of the single observed token; Gemma 2 (Gemma Team, 2024) trained its smaller models this way.",
      'Multi-token prediction (Gloeckle et al., 2024): extra output heads predict several future tokens at once, adding training signal and allowing faster decoding; DeepSeek-V3 (DeepSeek-AI, 2024) trains with a variant.',
      'The z-loss used for PaLM (Chowdhery et al., 2022): a small penalty on the log of the softmax normaliser that keeps logits from drifting and steadies large training runs.',
      'Direct Preference Optimization (Rafailov et al., 2023): the maximum-likelihood recipe applied to pairs of answers under a Bradley-Terry model, which turns preference tuning into a simple classification loss.',
      "Calibration of self-knowledge (Kadavath et al., 2022): large models' probabilities can be well calibrated on multiple-choice questions, so the predicted distribution is a usable confidence signal.",
    ],
    labs: [
      ['/training', 'Training'],
      ['/sampling', 'Sampling'],
      ['/confidence', 'Confidence'],
      ['/tokens', 'Tokens'],
      ['/preference-tuning', 'Preference tuning'],
    ],
  },
  {
    n: 6,
    title: 'Fitting models',
    offers: (
      <p>
        How to find the bottom of a loss surface. The chapter starts with gradient descent on the straight-line model,
        moves to a two-parameter Gabor model whose loss has local minima and saddle points, and then builds the tools
        used in practice: stochastic minibatches, momentum, Nesterov momentum and Adam. Every optimiser used to train
        LLMs today descends from what is here.
      </p>
    ),
    examples: [
      {
        id: '6.1a',
        title: 'Gradient descent for the line',
        page: 78,
        shows: (
          <p>
            The loss for linear regression is a sum over data points, so its gradient is a sum of per-point gradients
            (equation 6.7). With a line search choosing each step size, four steps get close to the minimum of the
            bowl-shaped, convex loss (figure 6.1).
          </p>
        ),
        notebooks: ['6.2'],
      },
      {
        id: '6.1b',
        title: 'The Gabor model',
        page: 80,
        shows: (
          <p>
            f[x, φ] = sin(φ₀ + 0.06φ₁x)·exp(−(φ₀ + 0.06φ₁x)²/32): a wave that fades away from its centre. φ₀ shifts it
            and φ₁ squeezes it. The training set is 28 points made with φ = [0, 16.6] plus noise. It is the smallest
            model whose loss is non-convex yet can still be drawn.
          </p>
        ),
        notebooks: ['6.3'],
      },
      {
        id: '6.1c',
        title: 'Local minima and saddle points',
        page: 81,
        shows: (
          <p>
            The Gabor loss has several local minima, each a plausible-looking but wrong fit, and one global minimum with
            a loss of 0.64. It also has saddle points, where the gradient is zero but the surface rises one way and
            falls another. Where plain gradient descent starts decides where it ends, and a small gradient does not
            prove it has finished.
          </p>
        ),
        notebooks: ['6.3'],
      },
      {
        id: '6.1d',
        title: 'Line search by bracketing',
        page: 93,
        shows: (
          <p>
            From the chapter notes (figure 6.10): to choose a step size, evaluate the loss at two points inside the
            search range, discard the end that cannot contain the minimum, and repeat until the range is small.
          </p>
        ),
        notebooks: ['6.1'],
      },
      {
        id: '6.2a',
        title: 'Minibatches as a changing loss surface',
        page: 84,
        shows: (
          <p>
            With batches of three Gabor points, each batch defines its own loss surface (figure 6.6). A step downhill on
            one batch&apos;s surface can be uphill on the full loss, which is how stochastic gradient descent climbs out
            of a wrong valley. On average, the batch gradient equals the full gradient.
          </p>
        ),
        notebooks: ['6.3'],
      },
      {
        id: '6.2b',
        title: 'Epochs and learning-rate schedules',
        page: 85,
        shows: (
          <p>
            Batches are drawn without replacement, and one full pass through the data is an epoch: 1,000 iterations with
            batches of 20 on 100 examples is 200 epochs (problem 6.9). Training usually starts with a large learning
            rate, to move between valleys, and lowers it later, to settle in one.
          </p>
        ),
      },
      {
        id: '6.3a',
        title: 'Momentum',
        page: 86,
        shows: (
          <p>
            Step along a running weighted average of past gradients instead of the latest one. Gradients that agree add
            up and speed progress; gradients that flip back and forth cancel out, so the path through a narrow valley is
            smoother (figure 6.7).
          </p>
        ),
        notebooks: ['6.4'],
      },
      {
        id: '6.3b',
        title: 'Nesterov accelerated momentum',
        page: 86,
        shows: (
          <p>
            Take the momentum step first, then measure the gradient at the point it lands on and use that to correct the
            move (figure 6.8). The gradient is taken where the parameters are about to be, not where they were. Notebook
            6.4 shows plain momentum only.
          </p>
        ),
      },
      {
        id: '6.4a',
        title: 'Normalised gradient steps',
        page: 88,
        shows: (
          <p>
            When the loss is much steeper in one direction than another, any single learning rate is either too slow
            along the gentle direction or unstable along the steep one (figure 6.9a–b). Dividing each gradient entry by
            its own size keeps only its sign: every parameter moves the same distance, so progress is quick in all
            directions, but the steps never shrink and the parameters rattle around the minimum (figure 6.9c). The
            notebooks skip this stage, and it is worth seeing: the Lion optimiser uses the same sign step today.
          </p>
        ),
        Demo: SignStepsDemo,
      },
      {
        id: '6.4b',
        title: 'Adam',
        page: 88,
        shows: (
          <p>
            Adam keeps a smoothed gradient and a smoothed squared gradient, corrects both for starting at zero, and
            steps by their ratio. Early on it behaves like the sign steps of 6.4a; as the averages build up, the rattle
            dies away and it settles at the minimum (figure 6.9d). It also balances step sizes across layers whose
            gradients differ greatly in scale, and is less sensitive to the choice of learning rate.
          </p>
        ),
        notebooks: ['6.5'],
      },
    ],
    inLlms: (
      <>
        <p>
          LLMs are trained with minibatch stochastic gradient descent, almost always using AdamW: Adam with weight decay
          applied separately from the adaptive step. GPT-3, for example, used β₁ = 0.9 and β₂ = 0.95. A batch holds
          millions of tokens, and large models see most of their data only once, so a whole run is often about one
          epoch.
        </p>
        <p>
          The learning rate warms up over the first steps (Adam&apos;s statistics are noisy at the start, as the chapter
          notes say) and then decays, commonly on a cosine curve. Gradient clipping caps the occasional huge step. Bad
          local minima like the Gabor model&apos;s are rarely the trouble at this scale; loss spikes and instability
          are.
        </p>
      </>
    ),
    next: [
      'AdamW (Loshchilov & Hutter, 2019): decoupling weight decay from the adaptive step, now the default optimiser for training transformers.',
      'The Lion optimiser (Chen et al., 2023): found by a program search, it steps by the sign of a blend of momentum and gradient, like the normalised steps in 6.4, and keeps only one moment in memory.',
      'The Muon optimiser (Jordan et al., 2024): orthogonalises the momentum of each weight matrix before stepping; Moonshot AI showed it scales to LLM training (Liu et al., 2025).',
      'μP hyperparameter transfer (Yang et al., 2022): a parameterisation under which the best learning rate found on a small model carries over to a much wider one, cutting the cost of tuning.',
      'Warmup-stable-decay schedules (Hu et al., 2024, MiniCPM) and schedule-free optimisation (Defazio et al., 2024): ways to train without fixing the run length in advance, which a cosine schedule needs.',
    ],
    labs: [
      ['/training', 'Training'],
      ['/training-at-scale', 'Training at scale'],
      ['/deep-learning', 'Deep learning notebooks'],
    ],
  },
];
