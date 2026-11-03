import { useMemo, useState } from 'react';
import type { ChapterDef } from './chapters';
import { ACTIVATIONS, clamp, fmt, gauss, linspace, rng, type Activation } from './kit';
import { Chips, Notebook, Readout, Slider } from './Notebook';
import { Plot, mix, type Colours } from './Plot';

const relu = (z: number) => (z > 0 ? z : 0);

/** A y range that fits the values, with a little room above and below. */
function autoRange(values: number[], minSpan = 0.5, pad = 0.12): [number, number] {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return [-1, 1];
  let lo = Math.min(...finite);
  let hi = Math.max(...finite);
  if (hi - lo < minSpan) {
    const m = (hi + lo) / 2;
    lo = m - minSpan / 2;
    hi = m + minSpan / 2;
  }
  const p = (hi - lo) * pad;
  return [lo - p, hi + p];
}

/** Blue for negative, orange for positive, the background colour at zero; t from -1 to 1. */
function diverge(c: Colours, t: number): string {
  return t < 0 ? mix(c.surface, c.s1, Math.min(1, -t)) : mix(c.surface, c.s2, Math.min(1, t));
}

/** A distinct colour for each activation pattern, so linear regions show as patches. */
function patchColour(key: number): string {
  return `hsl(${(Math.imul(key + 1, 2654435761) >>> 0) % 360}, 55%, 62%)`;
}

/** Big counts readably: grouped digits, or powers of ten once they get long. */
function big(n: number): string {
  return n < 1e7 ? Math.round(n).toLocaleString('en-GB') : n.toExponential(2).replace('e+', ' × 10^');
}

/**
 * The linear pieces of a 1D piecewise-linear function, found by sampling. `at` gives each x's activation
 * pattern and the exact slope there. A new pattern starts a new piece unless its slope is unchanged
 * (a unit switching on with zero weight adds no joint). Returns the count and where the joints are.
 */
function pieces(lo: number, hi: number, n: number, at: (x: number) => { key: string; slope: number }) {
  const joints: number[] = [];
  let prevKey: string | null = null;
  let prevSlope = 0;
  let prevX = lo;
  for (let i = 0; i < n; i++) {
    const x = lo + ((hi - lo) * i) / (n - 1);
    const { key, slope } = at(x);
    if (key !== prevKey) {
      if (prevKey !== null && Math.abs(slope - prevSlope) > 1e-9 * Math.max(1, Math.abs(slope), Math.abs(prevSlope))) {
        joints.push((x + prevX) / 2);
      }
      prevKey = key;
      prevSlope = slope;
    }
    prevX = x;
  }
  return { count: joints.length + 1, joints };
}

/** A shallow network with one input and one output: hidden units [bias, slope], outputs [φ0, φ1, …]. */
interface Net1D {
  units: [number, number][];
  out: number[];
}

/** The network's output at x, its exact slope there, and which ReLUs are on. */
function run1D(net: Net1D, x: number) {
  let y = net.out[0];
  let dy = 0;
  let key = '';
  net.units.forEach(([b, w], k) => {
    const z = b + w * x;
    if (z > 0) {
      y += net.out[k + 1] * z;
      dy += net.out[k + 1] * w;
      key += '1';
    } else key += '0';
  });
  return { y, dy, key };
}

const UNIT_COLOURS = ['s1', 's2', 's3'] as const;

/* ------------------------------------------------------------------ 1.1 */

function BackgroundMaths() {
  const [beta, setBeta] = useState(1);
  const [omega, setOmega] = useState(0.5);
  const [b2, setB2] = useState(0);
  const [w1, setW1] = useState(1);
  const [w2, setW2] = useState(-0.5);
  const [a, setA] = useState(1);
  const [b, setB] = useState(0.5);
  const line = linspace(-5, 5, 2);
  const zMax = Math.abs(b2) + 5 * Math.abs(w1) + 5 * Math.abs(w2) || 1;
  const xs = linspace(-3, 3, 241);
  return (
    <Notebook
      id="1.1"
      title="Background mathematics"
      intro="Three pieces of maths the whole book leans on: linear functions in one and two dimensions, and the exponential and logarithm, which turn sums into products and back."
      tryThis={[
        'Set ω to 0: the line is flat, and y no longer depends on x.',
        'In the 2D function, set ω₂ to 0. The colours only change left to right: x₂ has no effect.',
        'Move a and b and check that exp(a + b) always equals exp(a) × exp(b).',
      ]}
      takeaway="A neural network is built from linear functions joined by simple non-linear ones. Losses use exp and log because they turn products of probabilities into sums, which are easier to optimise."
    >
      <div className="dl-cols">
        <div>
          <Plot
            x={[-5, 5]}
            y={[-10, 10]}
            height={220}
            xLabel="x"
            yLabel="y"
            ariaLabel="A straight line y = β + ωx"
            draw={(f) => {
              f.line(line, line.map((x) => beta + omega * x), f.c.s1, 2.5);
              f.dots([[0, beta]], f.c.s2, 5);
            }}
          />
          <div className="dl-controls">
            <Slider label="β (offset)" value={beta} min={-5} max={5} onChange={setBeta} />
            <Slider label="ω (slope)" value={omega} min={-3} max={3} onChange={setOmega} />
          </div>
          <p className="dl-caption">
            y = {fmt(beta)} + {fmt(omega)}x. The orange dot is β, where the line crosses x = 0; ω is how much y rises for each step in x.
          </p>
        </div>
        <div>
          <Plot
            x={[-5, 5]}
            y={[-5, 5]}
            height={220}
            xLabel="x₁"
            yLabel="x₂"
            ariaLabel="A linear function of two inputs as a heat map"
            draw={(f) => {
              f.heat((x1, x2) => diverge(f.c, (b2 + w1 * x1 + w2 * x2) / zMax), 60);
              // Where z = 0: the line the colours change sign across.
              if (Math.abs(w2) > 1e-9) f.line([-5, 5], [-5, 5].map((x1) => -(b2 + w1 * x1) / w2), f.c.ink, 1.5, [5, 4]);
              else if (Math.abs(w1) > 1e-9) f.vline(-b2 / w1, f.c.ink);
            }}
          />
          <div className="dl-controls">
            <Slider label="β" value={b2} min={-5} max={5} onChange={setB2} />
            <Slider label="ω₁" value={w1} min={-2} max={2} onChange={setW1} />
            <Slider label="ω₂" value={w2} min={-2} max={2} onChange={setW2} />
          </div>
          <p className="dl-caption">
            z = {fmt(b2)} + {fmt(w1)}x₁ + {fmt(w2)}x₂. Orange is positive, blue negative; the dashed line is z = 0. A linear
            function of two inputs is a tilted plane.
          </p>
        </div>
      </div>
      <div className="dl-cols">
        <div>
          <Plot
            x={[-3, 3]}
            y={[-3, 6]}
            height={220}
            xLabel="x"
            ariaLabel="The exponential and logarithm functions"
            draw={(f) => {
              f.line(xs, xs, f.c.muted, 1, [4, 4]);
              f.line(xs, xs.map(Math.exp), f.c.s1, 2.5);
              f.line(xs, xs.map((x) => (x > 0 ? Math.log(x) : NaN)), f.c.s2, 2.5);
              f.dots([[a, Math.exp(a)]], f.c.s1, 5);
              if (Math.exp(a) <= 3) f.dots([[Math.exp(a), a]], f.c.s2, 5);
            }}
          />
          <div className="dl-legend">
            <span><i style={{ background: 'var(--s1)' }} />exp(x)</span>
            <span><i style={{ background: 'var(--s2)' }} />log(x), only for x &gt; 0</span>
            <span><i style={{ background: 'var(--muted)' }} />y = x: each is the other reflected</span>
          </div>
        </div>
        <div>
          <div className="dl-controls">
            <Slider label="a" value={a} min={-2} max={2} onChange={setA} />
            <Slider label="b" value={b} min={-2} max={2} onChange={setB} />
          </div>
          <Readout
            items={[
              ['exp(a + b)', fmt(Math.exp(a + b), 5)],
              ['exp(a) × exp(b)', fmt(Math.exp(a) * Math.exp(b), 5)],
              ['log(exp(a))', fmt(Math.log(Math.exp(a)), 5)],
              ['log(exp(a) × exp(b))', fmt(Math.log(Math.exp(a) * Math.exp(b)), 5)],
            ]}
          />
          <p className="dl-caption">
            exp is always positive and grows fast; log undoes it. log of a product is the sum of the logs, which is why a
            likelihood (a product over data points) becomes a loss that is a sum.
          </p>
        </div>
      </div>
    </Notebook>
  );
}

/* ------------------------------------------------------------------ 2.1 */

const DATA_21: [number, number][] = (() => {
  const r = rng(21);
  return Array.from({ length: 12 }, () => {
    const x = 0.1 + 1.8 * r();
    return [x, 0.4 + 0.9 * x + 0.25 * gauss(r)] as [number, number];
  });
})();

const loss21 = (p0: number, p1: number) => DATA_21.reduce((s, [x, y]) => s + (p0 + p1 * x - y) ** 2, 0);

const BEST_21 = (() => {
  const n = DATA_21.length;
  const mx = DATA_21.reduce((s, [x]) => s + x, 0) / n;
  const my = DATA_21.reduce((s, [, y]) => s + y, 0) / n;
  const p1 = DATA_21.reduce((s, [x, y]) => s + (x - mx) * (y - my), 0) / DATA_21.reduce((s, [x]) => s + (x - mx) ** 2, 0);
  return [my - p1 * mx, p1] as const;
})();

function Supervised() {
  const [p0, setP0] = useState(1.5);
  const [p1, setP1] = useState(-0.5);
  const L = loss21(p0, p1);
  const corners = [-1, 2].flatMap((a) => [-1, 3].map((b) => loss21(a, b)));
  const lMin = loss21(...BEST_21);
  const lMax = Math.max(...corners);
  const drag = (x: number, y: number) => {
    setP0(clamp(x, -1, 2));
    setP1(clamp(y, -1, 3));
  };
  return (
    <Notebook
      id="2.1"
      title="Supervised learning"
      intro="A model maps an input x to an output y. Here the model is a line, y = φ₀ + φ₁x, and training means choosing φ₀ and φ₁ to make the squared distances to the data (the least-squares loss) as small as possible."
      tryThis={[
        'Drag on the loss map on the right: the line on the left follows.',
        'Find the darkest green by hand, then press Best fit and see how close you got.',
        'Watch the red residuals: the loss is the sum of their squares.',
      ]}
      takeaway="Training is a search over parameters for the lowest loss. For a line the best answer has a formula; for neural networks it does not, so we walk downhill on the loss surface (chapter 6)."
    >
      <div className="dl-cols">
        <div>
          <Plot
            x={[0, 2]}
            y={[-0.5, 3]}
            height={240}
            xLabel="input x"
            yLabel="output y"
            ariaLabel="Training data with a fitted line and its residuals"
            draw={(f) => {
              for (const [x, y] of DATA_21) f.line([x, x], [y, p0 + p1 * x], f.c.bad, 1.5);
              f.line([0, 2], [p0, p0 + 2 * p1], f.c.s1, 2.5);
              f.dots(DATA_21, f.c.ink, 4);
            }}
          />
          <div className="dl-controls">
            <Slider label="φ₀ (offset)" value={p0} min={-1} max={2} onChange={setP0} />
            <Slider label="φ₁ (slope)" value={p1} min={-1} max={3} onChange={setP1} />
            <button className="btn small" onClick={() => (setP0(BEST_21[0]), setP1(BEST_21[1]))}>
              Best fit
            </button>
          </div>
          <Readout
            items={[
              ['least-squares loss', fmt(L, 4)],
              ['the lowest possible', fmt(lMin, 4)],
            ]}
          />
        </div>
        <div>
          <Plot
            x={[-1, 2]}
            y={[-1, 3]}
            height={240}
            xLabel="φ₀"
            yLabel="φ₁"
            ariaLabel="The loss for every choice of the two parameters, as a heat map"
            onDrag={drag}
            draw={(f) => {
              f.heat((a, b) => mix(f.c.s3, f.c.surface, Math.log(loss21(a, b) / lMin) / Math.log(lMax / lMin)), 60);
              f.dots([[BEST_21[0], BEST_21[1]]], f.c.ink, 3);
              f.dots([[p0, p1]], f.c.s2, 6);
            }}
          />
          <p className="dl-caption">
            The loss surface: each point is one line. Greener is a lower loss; the black dot is the best fit, the orange dot is
            your line. Click or drag to move it.
          </p>
        </div>
      </div>
    </Notebook>
  );
}

/* ------------------------------------------------------------------ 3.1 */

function ShallowOne() {
  const [units, setUnits] = useState<[number, number][]>([
    [0.3, -1.0],
    [-1.0, 2.0],
    [-0.5, 0.65],
  ]);
  const [out, setOut] = useState([-0.3, 2.0, -1.0, 7.0]);
  const net: Net1D = { units, out };
  const xs = linspace(0, 1, 201);
  const pre = units.map(([b, w]) => xs.map((x) => b + w * x));
  const act = pre.map((zs) => zs.map(relu));
  const weighted = act.map((hs, k) => hs.map((h) => out[k + 1] * h));
  const y = xs.map((x) => run1D(net, x).y);
  const joints = units.map(([b, w]) => (Math.abs(w) > 1e-9 ? -b / w : NaN)).filter((j) => j > 0 && j < 1);
  const setUnit = (k: number, i: 0 | 1, v: number) => setUnits((u) => u.map((p, j) => (j === k ? (i === 0 ? [v, p[1]] : [p[0], v]) : p)));
  const setW = (k: number, v: number) => setOut((o) => o.map((p, j) => (j === k ? v : p)));
  const panel = (title: string, lines: number[][], extra?: number[]) => {
    const yr = autoRange([...lines.flat(), ...(extra ?? [])]);
    return (
      <div>
        <div className="small" style={{ marginBottom: 4 }}><b>{title}</b></div>
        <Plot
          x={[0, 1]}
          y={yr}
          height={170}
          xLabel="x"
          ariaLabel={title}
          draw={(f) => {
            f.hline(0, f.c.muted, [2, 3]);
            lines.forEach((ys, k) => f.line(xs, ys, f.c[UNIT_COLOURS[k]], 2));
            if (extra) f.line(xs, extra, f.c.ink, 1.5, [5, 4]);
          }}
        />
      </div>
    );
  };
  return (
    <Notebook
      id="3.1"
      title="Shallow networks I"
      intro="One input, three hidden units, one output. Each hidden unit computes a line (its pre-activation), clips it at zero with a ReLU, and is scaled by an output weight. The output is the sum of the three, plus an offset: a piecewise-linear function with a joint wherever a unit switches on or off."
      tryThis={[
        'Change one unit’s bias and watch its joint (the dotted line) slide along x.',
        'Set an output weight to 0: that unit vanishes from the output and its joint disappears.',
        'Make a slope negative: the unit is then on to the left of its joint instead of the right.',
      ]}
      takeaway="With D hidden units, a shallow network with one input makes up to D + 1 linear pieces. More units, more pieces: enough of them can approximate any continuous function (the universal approximation theorem)."
    >
      <div className="dl-cols">
        {panel('1. Pre-activations θ₀ + θ₁x', pre)}
        {panel('2. After the ReLU', act)}
        {panel('3. Times the output weights', weighted, xs.map(() => out[0]))}
        <div>
          <div className="small" style={{ marginBottom: 4 }}><b>4. Output: their sum plus φ₀</b></div>
          <Plot
            x={[0, 1]}
            y={autoRange(y)}
            height={170}
            xLabel="x"
            ariaLabel="The network's output"
            draw={(f) => {
              for (const j of joints) f.vline(j, f.c.muted, [2, 3]);
              f.line(xs, y, f.c.brand, 2.5);
              f.dots(joints.map((j) => [j, run1D(net, j).y]), f.c.ink, 4);
            }}
          />
        </div>
      </div>
      <div className="dl-legend">
        <span><i style={{ background: 'var(--s1)' }} />Unit 1</span>
        <span><i style={{ background: 'var(--s2)' }} />Unit 2</span>
        <span><i style={{ background: 'var(--s3)' }} />Unit 3</span>
        <span><i style={{ background: 'var(--ink)' }} />φ₀ (dashed)</span>
      </div>
      <div className="dl-cols">
        {units.map(([b, w], k) => (
          <div key={k} className="dl-controls">
            <b className="small" style={{ color: `var(--${UNIT_COLOURS[k]})` }}>Unit {k + 1}</b>
            <Slider label="bias θ₀" value={b} min={-2} max={2} onChange={(v) => setUnit(k, 0, v)} />
            <Slider label="slope θ₁" value={w} min={-3} max={3} onChange={(v) => setUnit(k, 1, v)} />
            <Slider label="weight φ" value={out[k + 1]} min={-8} max={8} step={0.05} onChange={(v) => setW(k + 1, v)} />
          </div>
        ))}
        <div className="dl-controls">
          <Slider label="offset φ₀" value={out[0]} min={-2} max={2} onChange={(v) => setW(0, v)} />
          <span className="small muted">Joints in [0, 1]: {joints.length}, so {joints.length + 1} linear pieces.</span>
        </div>
      </div>
    </Notebook>
  );
}

/* ------------------------------------------------------------------ 3.2 */

type Unit2 = [number, number, number]; // bias, weight on x₁, weight on x₂

const START_32: { units: Unit2[]; out: number[] } = {
  units: [
    [-4, 0.9, 0],
    [5, -0.9, -0.5],
    [-7, 0.5, 0.9],
  ],
  out: [0, -1, 2, 0.6],
};

function ShallowTwo() {
  const [units, setUnits] = useState<Unit2[]>(START_32.units);
  const [out, setOut] = useState(START_32.out);
  const [pick, setPick] = useState<'0' | '1' | '2'>('0');
  const [seed, setSeed] = useState(0);
  const k = +pick;
  const hidden = (j: number, x1: number, x2: number) => relu(units[j][0] + units[j][1] * x1 + units[j][2] * x2);
  const output = (x1: number, x2: number) => out[0] + units.reduce((s, _, j) => s + out[j + 1] * hidden(j, x1, x2), 0);
  const grid = linspace(0, 10, 31);
  const yMax = Math.max(1e-6, ...grid.flatMap((a) => grid.map((b) => Math.abs(output(a, b)))));
  const regions = useMemo(() => {
    const seen = new Set<number>();
    const g = linspace(0, 10, 120);
    for (const a of g) for (const b of g) seen.add(units.reduce((key, u, j) => key | ((u[0] + u[1] * a + u[2] * b > 0 ? 1 : 0) << j), 0));
    return seen.size;
  }, [units]);
  const setU = (i: number, v: number) => setUnits((us) => us.map((u, j) => (j === k ? (u.map((p, n) => (n === i ? v : p)) as Unit2) : u)));
  const randomise = () => {
    const r = rng(100 + seed);
    setSeed((s) => s + 1);
    setUnits(
      [0, 1, 2].map(() => {
        const angle = r() * Math.PI * 2;
        const [w1, w2] = [Math.cos(angle), Math.sin(angle)];
        const [p1, p2] = [1 + 8 * r(), 1 + 8 * r()]; // the joint line passes through a point in view
        return [-(w1 * p1 + w2 * p2), w1, w2] as Unit2;
      }),
    );
    setOut([0, ...[0, 1, 2].map(() => +(gauss(r) * 1.5).toFixed(2))]);
  };
  const boundary = (f: Parameters<Parameters<typeof Plot>[0]['draw']>[0], u: Unit2, colour: string) => {
    const [b, w1, w2] = u;
    if (Math.abs(w2) > 1e-9) f.line([0, 10], [0, 10].map((x1) => -(b + w1 * x1) / w2), colour, 1.5, [5, 4]);
    else if (Math.abs(w1) > 1e-9) f.line([-b / w1, -b / w1], [0, 10], colour, 1.5, [5, 4]);
  };
  return (
    <Notebook
      id="3.2"
      title="Shallow networks II"
      intro="Two inputs, three hidden units. Each unit is now a tilted plane clipped at zero, so it switches on along a line. The output adds the three, giving a surface made of flat polygons: the linear regions, separated by the units' joint lines."
      tryThis={[
        'Pick a unit and change its bias: its joint line moves parallel to itself.',
        'Change its two weights: the line turns.',
        'Press Randomise a few times and count the regions. Three lines can cut the plane into at most 7.',
      ]}
      takeaway="In 2D the joints become lines, and the regions become convex polygons. The output is linear inside each one."
    >
      <div className="dl-cols">
        {units.map((u, j) => {
          const hMax = Math.max(1e-6, ...[0, 10].flatMap((a) => [0, 10].map((b) => hidden(j, a, b))));
          return (
            <div key={j}>
              <div className="small" style={{ marginBottom: 4 }}><b>Hidden unit {j + 1}</b> (after its ReLU)</div>
              <Plot
                x={[0, 10]}
                y={[0, 10]}
                height={170}
                xLabel="x₁"
                yLabel="x₂"
                ariaLabel={`Hidden unit ${j + 1} as a heat map`}
                draw={(f) => {
                  const c = f.c[UNIT_COLOURS[j]];
                  f.heat((a, b) => mix(f.c.surface, c, hidden(j, a, b) / hMax), 45);
                  boundary(f, u, f.c.ink);
                }}
              />
            </div>
          );
        })}
      </div>
      <div className="dl-cols">
        <div>
          <div className="small" style={{ marginBottom: 4 }}><b>Output</b>: φ₀ + Σ φₖ hₖ</div>
          <Plot
            x={[0, 10]}
            y={[0, 10]}
            height={260}
            xLabel="x₁"
            yLabel="x₂"
            ariaLabel="The network's output as a heat map, with the joint lines"
            draw={(f) => {
              f.heat((a, b) => diverge(f.c, output(a, b) / yMax), 64);
              units.forEach((u, j) => boundary(f, u, f.c[UNIT_COLOURS[j]]));
            }}
          />
          <p className="dl-caption">
            Orange is positive, blue negative. The dashed lines are where each unit switches on. Regions in view: <b>{regions}</b>.
          </p>
        </div>
        <div className="dl-controls" style={{ flexDirection: 'column', alignItems: 'flex-start' }}>
          <Chips
            options={[
              { id: '0', label: 'Unit 1' },
              { id: '1', label: 'Unit 2' },
              { id: '2', label: 'Unit 3' },
            ]}
            value={pick}
            onChange={setPick}
          />
          <Slider label="bias θ₀" value={units[k][0]} min={-10} max={10} step={0.1} onChange={(v) => setU(0, v)} />
          <Slider label="weight θ₁ (x₁)" value={units[k][1]} min={-2} max={2} onChange={(v) => setU(1, v)} />
          <Slider label="weight θ₂ (x₂)" value={units[k][2]} min={-2} max={2} onChange={(v) => setU(2, v)} />
          <Slider label="output weight φ" value={out[k + 1]} min={-3} max={3} onChange={(v) => setOut((o) => o.map((p, j) => (j === k + 1 ? v : p)))} />
          <div className="row">
            <button className="btn small" onClick={randomise}>Randomise</button>
            <button className="btn small" onClick={() => (setUnits(START_32.units), setOut(START_32.out))}>Reset</button>
          </div>
        </div>
      </div>
    </Notebook>
  );
}

/* ------------------------------------------------------------------ 3.3 */

function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}

/** Zaslavsky's formula: the most regions D hidden units (hyperplanes) can make in Di dimensions. */
const maxRegions = (D: number, Di: number) => Array.from({ length: Di + 1 }, (_, j) => choose(D, j)).reduce((a, b) => a + b, 0);

function Regions() {
  const [D, setD] = useState(8);
  const [seed, setSeed] = useState(1);
  const ds = [...new Set(linspace(0, 3, 90).map((v) => Math.round(10 ** v)))];
  const lines = useMemo(() => {
    const r = rng(seed * 7919);
    return Array.from({ length: D }, () => {
      const angle = r() * Math.PI * 2;
      const [w1, w2] = [Math.cos(angle), Math.sin(angle)];
      const [p1, p2] = [r() * 2 - 1, r() * 2 - 1]; // each joint line passes through the middle square
      return [-(w1 * p1 + w2 * p2), w1, w2] as Unit2;
    });
  }, [D, seed]);
  const pattern = (a: number, b: number) => lines.reduce((key, u, j) => key | ((u[0] + u[1] * a + u[2] * b > 0 ? 1 : 0) << j), 0);
  const found = useMemo(() => {
    const seen = new Set<number>();
    const g = linspace(-3, 3, 360);
    for (const a of g) for (const b of g) seen.add(pattern(a, b));
    return seen.size;
  }, [lines]);
  const table = [1, 2, 5, 10, 50, 100, 1000];
  return (
    <Notebook
      id="3.3"
      title="Shallow network regions"
      intro="How many linear regions can a shallow network make? Each hidden unit's joint is a hyperplane (a line in 2D). D hyperplanes in Di input dimensions cut the space into at most Σⱼ₌₀^Dᵢ C(D, j) regions, Zaslavsky's formula."
      tryThis={[
        'Raise the number of hidden units in the random network and compare the regions found with the formula.',
        'In the chart, see how fast the count grows with more inputs: for 5 inputs and 1,000 units it is about 8 × 10¹².',
        'Press New network: random lines rarely all meet inside the square, so the count found there is a little below the maximum.',
      ]}
      takeaway="The number of regions grows like D to the power of the input dimension. Wide shallow networks can carve the input space very finely, but every extra region costs another hidden unit."
    >
      <div className="dl-cols">
        <div>
          <Plot
            x={[0, 3]}
            y={[0, 14]}
            height={240}
            xLabel="log₁₀ D (hidden units)"
            yLabel="log₁₀ max regions"
            ariaLabel="Maximum number of linear regions against hidden units, for one to five inputs"
            draw={(f) => {
              const lx = ds.map(Math.log10);
              f.line(lx, ds.map((d) => d * Math.log10(2)), f.c.muted, 1, [4, 4]);
              ([1, 2, 3, 4, 5] as const).forEach((di) =>
                f.line(lx, ds.map((d) => Math.log10(maxRegions(d, di))), f.c[(['s1', 's2', 's3', 's4', 's5'] as const)[di - 1]], 2),
              );
            }}
          />
          <div className="dl-legend">
            {[1, 2, 3, 4, 5].map((di) => (
              <span key={di}><i style={{ background: `var(--s${di})` }} />{di} input{di > 1 ? 's' : ''}</span>
            ))}
            <span><i style={{ background: 'var(--muted)' }} />2^D: every on/off pattern (the limit when D ≤ Dᵢ)</span>
          </div>
        </div>
        <div className="dl-scroll">
          <table className="dl-table">
            <thead>
              <tr>
                <th>D \ Dᵢ</th>
                {[1, 2, 3, 4, 5].map((di) => <th key={di}>{di}</th>)}
              </tr>
            </thead>
            <tbody>
              {table.map((d) => (
                <tr key={d}>
                  <th>{d}</th>
                  {[1, 2, 3, 4, 5].map((di) => <td key={di}>{big(maxRegions(d, di))}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="dl-caption">Maximum regions for D hidden units and Dᵢ inputs.</p>
        </div>
      </div>
      <div className="dl-cols">
        <div>
          <Plot
            x={[-1.5, 1.5]}
            y={[-1.5, 1.5]}
            height={260}
            xLabel="x₁"
            yLabel="x₂"
            ariaLabel="The linear regions of a random two-input network, each in its own colour"
            draw={(f) => f.heat((a, b) => patchColour(pattern(a, b)), 70)}
          />
        </div>
        <div className="dl-controls" style={{ flexDirection: 'column', alignItems: 'flex-start' }}>
          <Slider label="hidden units D" value={D} min={1} max={30} step={1} onChange={setD} show={(v) => String(v)} />
          <button className="btn small" onClick={() => setSeed((s) => s + 1)}>New network</button>
          <Readout
            items={[
              ['regions found (on a grid over −3 to 3)', found],
              ['maximum, 1 + D + D(D − 1)/2', big(maxRegions(D, 2))],
            ]}
          />
          <p className="dl-caption">
            Each colour is one on/off pattern of the hidden units, so one linear region. The view shows the middle; regions
            are counted over a wider square.
          </p>
        </div>
      </div>
    </Notebook>
  );
}

/* ------------------------------------------------------------------ 3.4 */

const NET_34: Net1D = {
  units: [
    [-2, 8],
    [1, -6],
    [-5, 10],
  ],
  out: [0.2, 1, 0.6, -1.2],
};

function runAct(net: Net1D, x: number, act: (z: number) => number) {
  return net.out[0] + net.units.reduce((s, [b, w], k) => s + net.out[k + 1] * act(b + w * x), 0);
}

function Activations() {
  const [which, setWhich] = useState<Activation>('relu');
  const a = ACTIVATIONS[which];
  const zs = linspace(-4, 4, 321);
  const xs = linspace(0, 1, 301);
  const y = xs.map((x) => runAct(NET_34, x, a.f));
  const yRelu = xs.map((x) => runAct(NET_34, x, ACTIVATIONS.relu.f));
  return (
    <Notebook
      id="3.4"
      title="Activation functions"
      intro="The ReLU is one choice of the non-linear function applied in each hidden unit. Others are smooth, or let a little signal through below zero. The choice shapes both the functions a network can make and how well gradients flow when training it."
      tryThis={[
        'Pick Sigmoid or Tanh: the output becomes smooth, and their slope (dashed) is near zero for large inputs. That is the vanishing-gradient problem.',
        'Pick Linear: the three units collapse into a single straight line. Without a non-linearity, depth adds nothing.',
        'Pick Heaviside: steps, and a slope of zero almost everywhere, so gradient descent gets no signal.',
      ]}
      takeaway="ReLU is cheap, keeps a slope of 1 when on, and gives piecewise-linear networks; GELU and Swish are smooth variants used in transformers."
    >
      <Chips options={(Object.keys(ACTIVATIONS) as Activation[]).map((id) => ({ id, label: ACTIVATIONS[id].name }))} value={which} onChange={setWhich} />
      <div className="dl-cols">
        <div>
          <Plot
            x={[-4, 4]}
            y={[-1.5, 3]}
            height={220}
            xLabel="z"
            ariaLabel={`${a.name} and its derivative`}
            draw={(f) => {
              f.hline(0, f.c.muted, [2, 3]);
              f.line(zs, zs.map(a.f), f.c.s1, 2.5);
              f.line(zs, zs.map(a.df), f.c.s2, 2, [5, 4]);
            }}
          />
          <div className="dl-legend">
            <span><i style={{ background: 'var(--s1)' }} />a(z)</span>
            <span><i style={{ background: 'var(--s2)' }} />its slope a′(z), dashed</span>
          </div>
        </div>
        <div>
          <Plot
            x={[0, 1]}
            y={autoRange([...y, ...yRelu])}
            height={220}
            xLabel="x"
            ariaLabel="A shallow network's output with this activation, beside the ReLU version"
            draw={(f) => {
              f.line(xs, yRelu, f.c.muted, 1.5, [5, 4]);
              f.line(xs, y, f.c.brand, 2.5);
            }}
          />
          <div className="dl-legend">
            <span><i style={{ background: 'var(--brand)' }} />The same three-unit network with {a.name}</span>
            <span><i style={{ background: 'var(--muted)' }} />with ReLU, dashed</span>
          </div>
        </div>
      </div>
    </Notebook>
  );
}

/* ------------------------------------------------------------------ 4.1 */

const NET2_41: Net1D = {
  units: [
    [0.75, 1],
    [0.4, 1],
    [0.1, 1],
  ],
  out: [-0.5, 3, -6, 6],
};

function Composing() {
  const [out, setOut] = useState([-1, 2, -4, 4]);
  const net1: Net1D = {
    units: [
      [0.5, 1],
      [0, 1],
      [-0.5, 1],
    ],
    out,
  };
  const xs = linspace(-1, 1, 401);
  const y1 = xs.map((x) => run1D(net1, x).y);
  const y2 = xs.map((x) => run1D(NET2_41, x).y);
  const yc = y1.map((v) => run1D(NET2_41, v).y);
  const p1 = pieces(-1, 1, 4001, (x) => {
    const r = run1D(net1, x);
    return { key: r.key, slope: r.dy };
  });
  const p2 = pieces(-1, 1, 4001, (x) => {
    const r = run1D(NET2_41, x);
    return { key: r.key, slope: r.dy };
  });
  const pc = pieces(-1, 1, 6001, (x) => {
    const a = run1D(net1, x);
    const b = run1D(NET2_41, a.y);
    return { key: a.key + b.key, slope: a.dy * b.dy };
  });
  const [lo, hi] = [Math.min(...y1), Math.max(...y1)];
  return (
    <Notebook
      id="4.1"
      title="Composing networks"
      intro="Feed the output of one shallow network into another. The second network is applied to every value the first one produces, so each of its pieces gets reused wherever the first network passes through that range: the joints multiply."
      tryThis={[
        'Make network 1 zig-zag more (bigger weights): its output sweeps the shaded band of network 2 more times, adding joints.',
        'Shrink the weights until network 1 is nearly flat: the composition becomes simple again.',
        'Compare the joint counts: the composition can have more than the two networks put together.',
      ]}
      takeaway="Composing two networks is a deep network with two hidden layers. Folding the input back and forth is why depth can make many more linear regions than the same number of units in one layer."
    >
      <div className="dl-cols">
        <div>
          <div className="small" style={{ marginBottom: 4 }}><b>Network 1</b>: y = f₁(x), {p1.count} pieces</div>
          <Plot
            x={[-1, 1]}
            y={autoRange(y1, 1)}
            height={180}
            xLabel="x"
            ariaLabel="Network 1"
            draw={(f) => {
              f.line(xs, y1, f.c.s1, 2.5);
              f.dots(p1.joints.map((j) => [j, run1D(net1, j).y]), f.c.ink, 3.5);
            }}
          />
        </div>
        <div>
          <div className="small" style={{ marginBottom: 4 }}><b>Network 2</b>: y′ = f₂(y), {p2.count} pieces; shaded where network 1 sends it</div>
          <Plot
            x={[-1, 1]}
            y={autoRange(y2, 1)}
            height={180}
            xLabel="y"
            ariaLabel="Network 2, with the range of network 1's output shaded"
            draw={(f) => {
              f.ctx.fillStyle = f.c.line;
              f.ctx.fillRect(f.x(Math.max(-1, lo)), 0, Math.max(0, f.x(Math.min(1, hi)) - f.x(Math.max(-1, lo))), f.h);
              f.line(xs, y2, f.c.s2, 2.5);
              f.dots(p2.joints.map((j) => [j, run1D(NET2_41, j).y]), f.c.ink, 3.5);
            }}
          />
        </div>
        <div>
          <div className="small" style={{ marginBottom: 4 }}><b>Composition</b>: f₂(f₁(x)), {pc.count} pieces</div>
          <Plot
            x={[-1, 1]}
            y={autoRange(yc, 1)}
            height={180}
            xLabel="x"
            ariaLabel="The composition of the two networks"
            draw={(f) => {
              f.line(xs, yc, f.c.brand, 2.5);
              f.dots(pc.joints.map((j) => [j, run1D(NET2_41, run1D(net1, j).y).y]), f.c.ink, 3.5);
            }}
          />
        </div>
      </div>
      <div className="dl-controls">
        <b className="small">Network 1’s output weights</b>
        <Slider label="φ₀" value={out[0]} min={-2} max={2} onChange={(v) => setOut((o) => o.map((p, j) => (j === 0 ? v : p)))} />
        {[1, 2, 3].map((k) => (
          <Slider key={k} label={`φ${'₁₂₃'[k - 1]}`} value={out[k]} min={-6} max={6} step={0.05} onChange={(v) => setOut((o) => o.map((p, j) => (j === k ? v : p)))} />
        ))}
        <button className="btn small" onClick={() => setOut([-1, 2, -4, 4])}>Reset</button>
      </div>
      <Readout
        items={[
          ['joints in network 1', p1.count - 1],
          ['joints in network 2', p2.count - 1],
          ['joints in the composition', pc.count - 1],
        ]}
      />
    </Notebook>
  );
}

/* ------------------------------------------------------------------ 4.2 */

/** One fold: two ReLU units, 2·relu(x) − 4·relu(x − 0.5), a tent on [0, 1]. Returns the value, slope and which side. */
const fold = (x: number) => {
  const right = x > 0.5;
  return { y: 2 * relu(x) - 4 * relu(x - 0.5), slope: right ? -2 : 2, bit: right ? '1' : '0' };
};

const CLIP_NET: Net1D = {
  units: [
    [0.3, -1.0],
    [-1.0, 2.0],
    [-0.5, 0.65],
  ],
  out: [-0.3, 2.0, -1.0, 7.0],
};

function Clipping() {
  const [k, setK] = useState(3);
  const [cut, setCut] = useState(0.2);
  const xs = linspace(0, 1, 1025);
  const layers = useMemo(() => {
    const out: number[][] = [];
    let cur = xs;
    for (let j = 0; j < 6; j++) {
      cur = cur.map((x) => fold(x).y);
      out.push(cur);
    }
    return out;
  }, []);
  const counts = useMemo(
    () =>
      [1, 2, 3, 4, 5, 6].map(
        (depth) =>
          pieces(0, 1, 8001, (x) => {
            let v = x;
            let slope = 1;
            let key = '';
            for (let j = 0; j < depth; j++) {
              const r = fold(v);
              v = r.y;
              slope *= r.slope;
              key += r.bit;
            }
            return { key, slope };
          }).count,
      ),
    [],
  );
  const yNet = xs.map((x) => run1D(CLIP_NET, x).y);
  const yClip = yNet.map((v) => relu(v - cut));
  const clipPieces = pieces(0, 1, 4001, (x) => {
    const r = run1D(CLIP_NET, x);
    const on = r.y - cut > 0;
    return { key: r.key + (on ? '1' : '0'), slope: on ? r.dy : 0 };
  });
  return (
    <Notebook
      id="4.2"
      title="Clipping functions"
      intro="A ReLU layer applied to a network's output clips it: everything below a threshold becomes flat, and new joints appear where the output crosses it. Two ReLUs together can fold the input in half, and repeating the fold doubles the number of pieces with every layer."
      tryThis={[
        'Move the threshold: each time the curve crosses it, the clipped output gains a joint.',
        'Raise the number of folding layers one at a time: 2, 4, 8, 16… pieces, with only two hidden units per layer.',
        'A shallow network would need 2^k − 1 hidden units to make the same 2^k pieces.',
      ]}
      takeaway="Each layer can reuse the pieces made by the layer before. That is why depth buys an exponential number of linear regions for a linear number of parameters."
    >
      <div className="dl-cols">
        <div>
          <div className="small" style={{ marginBottom: 4 }}><b>Clipping</b>: relu(y − threshold), {clipPieces.count} pieces</div>
          <Plot
            x={[0, 1]}
            y={autoRange([...yNet, 0])}
            height={200}
            xLabel="x"
            ariaLabel="A network's output and the same output clipped at a threshold"
            draw={(f) => {
              f.hline(cut, f.c.muted);
              f.line(xs, yNet, f.c.s1, 1.5, [5, 4]);
              f.line(xs, yClip, f.c.brand, 2.5);
            }}
          />
          <div className="dl-controls">
            <Slider label="threshold" value={cut} min={-0.5} max={1.2} onChange={setCut} />
          </div>
          <div className="dl-legend">
            <span><i style={{ background: 'var(--s1)' }} />network output y (from 3.1), dashed</span>
            <span><i style={{ background: 'var(--brand)' }} />after a ReLU layer</span>
          </div>
        </div>
        <div>
          <div className="dl-controls">
            <Slider label="folding layers k" value={k} min={1} max={6} step={1} onChange={setK} show={(v) => String(v)} />
          </div>
          <Readout
            items={[
              ['pieces after k layers', counts[k - 1]],
              ['2^k', 2 ** k],
              ['hidden units used', 2 * k],
              ['shallow units for the same', 2 ** k - 1],
            ]}
          />
          <p className="dl-caption">Each layer is 2·relu(x) − 4·relu(x − 0.5): up from 0 to 1, then back down. Feeding it its own output folds it again.</p>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 10 }}>
        {layers.slice(0, k).map((ys, j) => (
          <div key={j}>
            <div className="small" style={{ marginBottom: 4 }}>After layer {j + 1}: {counts[j]} pieces</div>
            <Plot
              x={[0, 1]}
              y={[-0.1, 1.1]}
              height={130}
              xLabel="x"
              ariaLabel={`The input folded ${j + 1} times`}
              draw={(f) => f.line(xs, ys, f.c[(['s1', 's2', 's3', 's4', 's5', 'brand'] as const)[j]], 2)}
            />
          </div>
        ))}
      </div>
    </Notebook>
  );
}

/* ------------------------------------------------------------------ 4.3 */

const deepParams = (K: number, L: number) => 3 * K + 1 + (L - 1) * K * (K + 1);

function DeepNetworks() {
  const [K, setK] = useState(4);
  const [L, setL] = useState(3);
  const [seed, setSeed] = useState(1);
  const P = deepParams(K, L);
  const H = Math.floor((P - 1) / 3);
  const deepMax = (K + 1) ** L;
  const random = useMemo(() => {
    const r = rng(seed * 104729 + K * 31 + L);
    // He initialisation: weights with variance 2 / fan-in keep the signal's size steady through ReLU layers.
    const layers = Array.from({ length: L }, (_, l) => {
      const fanIn = l === 0 ? 1 : K;
      return {
        W: Array.from({ length: K }, () => Array.from({ length: fanIn }, () => gauss(r) * Math.sqrt(2 / fanIn))),
        b: Array.from({ length: K }, () => gauss(r) * 0.5),
      };
    });
    const wOut = Array.from({ length: K }, () => gauss(r) * Math.sqrt(1 / K));
    const run = (x: number) => {
      let h = [x];
      let dh = [1];
      let key = '';
      for (const { W, b } of layers) {
        const z = W.map((row, i) => b[i] + row.reduce((s, w, j) => s + w * h[j], 0));
        const dz = W.map((row) => row.reduce((s, w, j) => s + w * dh[j], 0));
        h = z.map(relu);
        dh = dz.map((d, i) => (z[i] > 0 ? d : 0));
        key += z.map((v) => (v > 0 ? '1' : '0')).join('');
      }
      return { y: wOut.reduce((s, w, i) => s + w * h[i], 0), slope: wOut.reduce((s, w, i) => s + w * dh[i], 0), key };
    };
    const xs = linspace(-2, 2, 801);
    const ys = xs.map((x) => run(x).y);
    const p = pieces(-2, 2, 12001, (x) => run(x));
    return { xs, ys, joints: p.joints.map((j) => [j, run(j).y] as [number, number]), count: p.count };
  }, [K, L, seed]);
  const depths = Array.from({ length: 10 }, (_, i) => i + 1);
  return (
    <Notebook
      id="4.3"
      title="Deep networks"
      intro="A deep network stacks hidden layers. With one input, K units per layer and L layers, it can make up to (K + 1)^L linear regions, while its parameters grow only linearly with L. Compare with a shallow network given the same number of parameters."
      tryThis={[
        'Keep the width at 4 and raise the depth: the maximum regions multiply by 5 each layer; the shallow equivalent barely moves.',
        'Look at the random network: real networks at initialisation have far fewer regions than the maximum.',
        'Press New weights a few times at the same size and see how much the count varies.',
      ]}
      takeaway="Depth gives far more possible regions per parameter than width. Whether training uses them is another matter, which later chapters (initialisation, residual connections) take up."
    >
      <div className="dl-controls">
        <Slider label="width K (units per layer)" value={K} min={1} max={20} step={1} onChange={setK} show={(v) => String(v)} />
        <Slider label="depth L (hidden layers)" value={L} min={1} max={10} step={1} onChange={setL} show={(v) => String(v)} />
      </div>
      <Readout
        items={[
          ['parameters', big(P)],
          ['max regions, deep: (K + 1)^L', big(deepMax)],
          ['shallow units with the same parameters', big(H)],
          ['max regions, shallow: units + 1', big(H + 1)],
        ]}
      />
      <div className="dl-cols">
        <div>
          <Plot
            x={[0, 4]}
            y={[0, 14]}
            height={230}
            xLabel="log₁₀ parameters"
            yLabel="log₁₀ max regions"
            ariaLabel="Maximum regions against parameters, deep and shallow"
            draw={(f) => {
              const ps = linspace(0.6, 4, 60).map((v) => 10 ** v);
              f.line(ps.map(Math.log10), ps.map((p) => Math.log10(Math.floor((p - 1) / 3) + 1)), f.c.s2, 2);
              const pts = depths.map((l) => [Math.log10(deepParams(K, l)), l * Math.log10(K + 1)] as [number, number]);
              f.line(pts.map((p) => p[0]), pts.map((p) => p[1]), f.c.s1, 2);
              f.dots(pts, f.c.s1, 3);
              f.dots([[Math.log10(P), L * Math.log10(K + 1)]], f.c.ink, 6);
            }}
          />
          <div className="dl-legend">
            <span><i style={{ background: 'var(--s1)' }} />deep, width {K}, depth 1 to 10 (black: your choice)</span>
            <span><i style={{ background: 'var(--s2)' }} />shallow</span>
          </div>
        </div>
        <div>
          <Plot
            x={[-2, 2]}
            y={autoRange(random.ys, 0.5)}
            height={230}
            xLabel="x"
            ariaLabel="The output of a randomly initialised deep network, with its joints marked"
            draw={(f) => {
              f.line(random.xs, random.ys, f.c.brand, 2);
              f.dots(random.joints, f.c.ink, 2.5);
            }}
          />
          <div className="row">
            <span className="small">
              A random {L}-layer network of width {K}: <b>{random.count}</b> regions in −2 to 2, of up to {big(deepMax)}.
            </span>
            <button className="btn small" onClick={() => setSeed((s) => s + 1)}>New weights</button>
          </div>
        </div>
      </div>
    </Notebook>
  );
}

export const CHAPTERS: ChapterDef[] = [
  {
    n: 1,
    title: 'Introduction',
    blurb: 'The maths used throughout: linear functions, and the exponential and logarithm.',
    notebooks: [{ id: '1.1', title: 'Background mathematics', Component: BackgroundMaths }],
  },
  {
    n: 2,
    title: 'Supervised learning',
    blurb: 'A model, a loss, and training as a search for the parameters with the lowest loss.',
    notebooks: [{ id: '2.1', title: 'Supervised learning', Component: Supervised }],
  },
  {
    n: 3,
    title: 'Shallow neural networks',
    blurb: 'One hidden layer of ReLUs makes piecewise-linear functions. How many pieces, and what the activation changes.',
    notebooks: [
      { id: '3.1', title: 'Shallow networks I', Component: ShallowOne },
      { id: '3.2', title: 'Shallow networks II', Component: ShallowTwo },
      { id: '3.3', title: 'Shallow network regions', Component: Regions },
      { id: '3.4', title: 'Activation functions', Component: Activations },
    ],
  },
  {
    n: 4,
    title: 'Deep neural networks',
    blurb: 'Composing layers folds the input, so depth makes many more regions per parameter than width.',
    notebooks: [
      { id: '4.1', title: 'Composing networks', Component: Composing },
      { id: '4.2', title: 'Clipping functions', Component: Clipping },
      { id: '4.3', title: 'Deep networks', Component: DeepNetworks },
    ],
  },
];
