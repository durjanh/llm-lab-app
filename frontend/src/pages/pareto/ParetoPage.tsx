import { useMemo, useRef, useState, type PointerEvent } from 'react';
import { Link } from 'react-router';
import { CodeBlock } from '@/components/CodeBlock';
import { highlight } from '@/components/highlight';
import { SAMPLE } from './data';
import {
  bestWithin,
  dominates,
  frontier,
  frontier2d,
  logUnit,
  parseCsv,
  project,
  qualityRange,
  toCsv,
  type ModelPoint,
  type View,
} from './pareto';
import './pareto.css';

const SERIES = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--brand)', 'var(--ink2)'];
const START_VIEW: View = { yaw: -38, pitch: 22 };

const money = (c: number) => (c >= 1 ? `$${c.toFixed(2)}` : `$${Number(c.toPrecision(2))}`);
const time = (m: number) => (m < 1 ? `${Math.round(m * 60)} s` : `${m >= 10 ? Math.round(m) : m.toFixed(1)} min`);

interface Scales {
  cost: [number, number];
  minutes: [number, number];
  quality: [number, number];
}

function scalesFor(points: ModelPoint[]): Scales {
  const span = (k: 'cost' | 'minutes'): [number, number] => {
    const v = points.map((p) => p[k]);
    return [10 ** Math.floor(Math.log10(Math.min(...v))), 10 ** Math.ceil(Math.log10(Math.max(...v)))];
  };
  const q = points.map((p) => p.quality);
  return {
    cost: span('cost'),
    minutes: span('minutes'),
    quality: qualityRange(q),
  };
}

/** Cube coordinates: x is cheapness, y is speed, z is quality, each in [-1, 1], so the best corner is (1, 1, 1). */
function cube(p: ModelPoint, s: Scales): [number, number, number] {
  const [q0, q1] = s.quality;
  return [-logUnit(p.cost, ...s.cost), -logUnit(p.minutes, ...s.minutes), ((p.quality - q0) / (q1 - q0)) * 2 - 1];
}

const decades = ([lo, hi]: [number, number]) => {
  const out: number[] = [];
  for (let e = Math.round(Math.log10(lo)); e <= Math.round(Math.log10(hi)); e++) out.push(10 ** e);
  return out;
};

function Marker({
  x,
  y,
  r,
  open,
  fill,
  ring,
}: {
  x: number;
  y: number;
  r: number;
  open: boolean;
  fill: string;
  ring: boolean;
}) {
  const cls = ring ? 'pf-pt ring' : 'pf-pt';
  return open ? (
    <path className={cls} d={`M${x} ${y - r}L${x + r} ${y}L${x} ${y + r}L${x - r} ${y}Z`} style={{ fill }} />
  ) : (
    <circle className={cls} cx={x} cy={y} r={r} style={{ fill }} />
  );
}

/** The three measures as a cube you turn by dragging; frontier points are larger and joined in quality order. */
function Cube3D({
  points,
  colour,
  onFrontier,
  openFrontier,
  selected,
  onSelect,
}: {
  points: ModelPoint[];
  colour: (p: ModelPoint) => string;
  onFrontier: Set<ModelPoint>;
  openFrontier: ModelPoint[];
  selected: ModelPoint | null;
  onSelect: (p: ModelPoint) => void;
}) {
  const [view, setView] = useState<View>(START_VIEW);
  const drag = useRef<{ x: number; y: number; view: View } | null>(null);
  const s = useMemo(() => scalesFor(points), [points]);
  const W = 640;
  const H = 470;
  const K = 165;
  const at = (x: number, y: number, z: number) => {
    const p = project(x, y, z, view);
    return { x: W / 2 + p.sx * K, y: H / 2 + 10 - p.sy * K, depth: p.depth };
  };
  const line = (a: number[], b: number[], cls: string, key: string) => {
    const p = at(a[0], a[1], a[2]);
    const q = at(b[0], b[1], b[2]);
    return <line key={key} className={cls} x1={p.x} y1={p.y} x2={q.x} y2={q.y} />;
  };
  const edges: [number[], number[]][] = [];
  for (const a of [-1, 1])
    for (const b of [-1, 1]) {
      edges.push(
        [
          [-1, a, b],
          [1, a, b],
        ],
        [
          [a, -1, b],
          [a, 1, b],
        ],
        [
          [a, b, -1],
          [a, b, 1],
        ],
      );
    }
  const drawn = points
    .map((p) => {
      const c = cube(p, s);
      return { p, c, ...at(c[0], c[1], c[2]) };
    })
    .sort((a, b) => b.depth - a.depth);
  const pathOf = (list: ModelPoint[]) =>
    [...list]
      .sort((a, b) => a.quality - b.quality)
      .map((p) => {
        const c = cube(p, s);
        const q = at(c[0], c[1], c[2]);
        return `${q.x.toFixed(1)},${q.y.toFixed(1)}`;
      })
      .join(' ');
  const best = at(1, 1, 1);

  const down = (e: PointerEvent<SVGSVGElement>) => {
    drag.current = { x: e.clientX, y: e.clientY, view };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const move = (e: PointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (!d) return;
    setView({
      yaw: d.view.yaw + (e.clientX - d.x) * 0.4,
      pitch: Math.max(-5, Math.min(80, d.view.pitch + (e.clientY - d.y) * 0.4)),
    });
  };
  const up = () => (drag.current = null);

  return (
    <div className="card pf-cube">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="pf-svg pf-drag"
        role="img"
        aria-labelledby="pf-cube-t pf-cube-d"
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
      >
        <title id="pf-cube-t">Quality against cost and time, in three dimensions</title>
        <desc id="pf-cube-d">
          Each model is a point. Up is higher quality, one way along the floor is cheaper and the other is faster. The
          Pareto frontier is drawn larger and joined by a line. The table below lists the same points.
        </desc>
        {edges.map(([a, b], i) => line(a, b, 'pf-edge', `e${i}`))}
        {line([1, 1, -1], [1, 1, 1], 'pf-ideal', 'ideal-z')}
        {line([-1, 1, 1], [1, 1, 1], 'pf-ideal', 'ideal-x')}
        {line([1, -1, 1], [1, 1, 1], 'pf-ideal', 'ideal-y')}
        {decades(s.cost).map((c) => {
          const p = at(-logUnit(c, ...s.cost), -1, -1);
          return (
            <text key={`c${c}`} x={p.x} y={p.y + 16} className="pf-tick" textAnchor="middle">
              {money(c)}
            </text>
          );
        })}
        {/* The slowest tick sits on the corner where the cost ticks start, so it is left out. */}
        {decades(s.minutes)
          .slice(0, -1)
          .map((m) => {
            const p = at(-1, -logUnit(m, ...s.minutes), -1);
            return (
              <text key={`m${m}`} x={p.x - 6} y={p.y + 14} className="pf-tick" textAnchor="end">
                {time(m)}
              </text>
            );
          })}
        {[0, 0.5, 1].map((f) => {
          const q = s.quality[0] + f * (s.quality[1] - s.quality[0]);
          const p = at(-1, -1, f * 2 - 1);
          return (
            <text key={`q${q}`} x={p.x - 8} y={p.y + 4} className="pf-tick" textAnchor="end">
              {q}
            </text>
          );
        })}
        <text x={at(-1, -1, 1).x} y={at(-1, -1, 1).y - 10} className="pf-axis" textAnchor="middle">
          quality ↑
        </text>
        {openFrontier.length > 1 && <polyline className="pf-line open" points={pathOf(openFrontier)} />}
        {onFrontier.size > 1 && <polyline className="pf-line" points={pathOf([...onFrontier])} />}
        {drawn.map(({ p, x, y }) => (
          <g
            key={p.name}
            className={selected === p ? 'pf-hit on' : 'pf-hit'}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => onSelect(p)}
          >
            <Marker
              x={x}
              y={y}
              r={onFrontier.has(p) ? 7 : 4.5}
              open={p.open}
              fill={colour(p)}
              ring={onFrontier.has(p)}
            />
            <title>
              {p.name}: quality {p.quality}, {money(p.cost)} and {time(p.minutes)} a task
            </title>
          </g>
        ))}
        <path
          className="pf-star"
          transform={`translate(${best.x} ${best.y})`}
          d="M0-9L2.6-2.8 9-2.8 3.9 1.1 5.6 7.5 0 3.7-5.6 7.5-3.9 1.1-9-2.8-2.6-2.8Z"
        />
        <text x={best.x + 12} y={best.y - 8} className="pf-axis">
          best corner
        </text>
      </svg>
      <div className="row pf-controls">
        <label>
          Turn{' '}
          <input
            type="range"
            min={-180}
            max={180}
            value={Math.round(((view.yaw + 540) % 360) - 180)}
            onChange={(e) => setView((v) => ({ ...v, yaw: Number(e.target.value) }))}
          />
        </label>
        <label>
          Tilt{' '}
          <input
            type="range"
            min={-5}
            max={80}
            value={Math.round(view.pitch)}
            onChange={(e) => setView((v) => ({ ...v, pitch: Number(e.target.value) }))}
          />
        </label>
        <button type="button" className="btn small" onClick={() => setView(START_VIEW)}>
          Reset view
        </button>
        <button type="button" className="btn small" onClick={() => setView({ yaw: 0, pitch: 0 })}>
          Quality against cost
        </button>
        <button type="button" className="btn small" onClick={() => setView({ yaw: 90, pitch: 0 })}>
          Quality against time
        </button>
      </div>
      <p className="small muted">
        Up is quality. Along the front edge, cost per task falls to the right; along the side edge, time per task falls
        towards the back. Drag the chart to turn it, and select a point for its numbers.
      </p>
    </div>
  );
}

/** Quality against one measure on a log scale, with that pair's own frontier as a staircase. */
function Flat({
  points,
  axis,
  colour,
  onFrontier,
}: {
  points: ModelPoint[];
  axis: 'cost' | 'minutes';
  colour: (p: ModelPoint) => string;
  onFrontier: Set<ModelPoint>;
}) {
  const s = scalesFor(points);
  const W = 320;
  const H = 230;
  const L = 34;
  const B = 28;
  const x = (v: number) => L + ((logUnit(v, ...s[axis]) + 1) / 2) * (W - L - 30);
  const y = (q: number) => H - B - ((q - s.quality[0]) / (s.quality[1] - s.quality[0])) * (H - B - 10);
  const flat = frontier2d(points, axis);
  const steps = flat.flatMap((p, i) => {
    const pt = `${x(p[axis]).toFixed(1)},${y(p.quality).toFixed(1)}`;
    return i === 0 ? [pt] : [`${x(p[axis]).toFixed(1)},${y(flat[i - 1].quality).toFixed(1)}`, pt];
  });
  const only3d = [...onFrontier].filter((p) => !flat.includes(p)).length;
  const label = axis === 'cost' ? 'cost per task' : 'time per task';
  return (
    <figure className="card pf-flat">
      <svg viewBox={`0 0 ${W} ${H}`} className="pf-svg" role="img" aria-label={`Quality against ${label}`}>
        <line className="pf-edge" x1={L} y1={H - B} x2={W - 10} y2={H - B} />
        <line className="pf-edge" x1={L} y1={10} x2={L} y2={H - B} />
        {decades(s[axis]).map((v) => (
          <text key={v} x={x(v)} y={H - 10} className="pf-tick" textAnchor="middle">
            {axis === 'cost' ? money(v) : time(v)}
          </text>
        ))}
        {[s.quality[0], (s.quality[0] + s.quality[1]) / 2, s.quality[1]].map((q) => (
          <text key={q} x={L - 5} y={y(q) + 4} className="pf-tick" textAnchor="end">
            {q}
          </text>
        ))}
        <polyline className="pf-line flat" points={steps.join(' ')} />
        {points.map((p) => (
          <Marker
            key={p.name}
            x={x(p[axis])}
            y={y(p.quality)}
            r={onFrontier.has(p) ? 5.5 : 3.5}
            open={p.open}
            fill={colour(p)}
            ring={onFrontier.has(p)}
          />
        ))}
      </svg>
      <figcaption className="small">
        Quality against {label}, cheapest or fastest on the left. The staircase is the frontier on these two measures:{' '}
        {flat.length} models. {only3d} more are on the three-measure frontier but hidden here, because what makes them
        worth having is the measure this view leaves out.
      </figcaption>
    </figure>
  );
}

function FrontierTable({ rows, empty }: { rows: ModelPoint[]; empty: string }) {
  if (!rows.length) return <p className="small muted">{empty}</p>;
  return (
    <div className="table-wrap">
      <table className="t">
        <thead>
          <tr>
            <th>Model</th>
            <th>Provider</th>
            <th>Quality</th>
            <th>Cost a task</th>
            <th>Time a task</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.name}>
              <td>
                {p.name}
                {p.open && <span className="pf-open"> open</span>}
              </td>
              <td>{p.provider}</td>
              <td>{p.quality}</td>
              <td>{money(p.cost)}</td>
              <td>{time(p.minutes)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const SNIPPET = highlight(`# The same frontier in pandas: keep the rows nothing beats on all three measures.
import pandas as pd

df = pd.read_csv("models.csv")  # name, provider, open, quality, cost, minutes

def dominated(row, df):
    no_worse = (df.quality >= row.quality) & (df.cost <= row.cost) & (df.minutes <= row.minutes)
    better = (df.quality > row.quality) | (df.cost < row.cost) | (df.minutes < row.minutes)
    return (no_worse & better).any()

frontier = df[[not dominated(r, df) for r in df.itertuples()]]
print(frontier.sort_values("quality", ascending=False))`);

/**
 * Quality, cost and time as one choice: the models no other model beats on all three, shown in three dimensions and
 * flattened to two, on an invented field of models or on data the reader pastes in.
 */
export default function ParetoPage() {
  const [points, setPoints] = useState<ModelPoint[]>(SAMPLE);
  const [source, setSource] = useState<'sample' | 'pasted'>('sample');
  const [csv, setCsv] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [selected, setSelected] = useState<ModelPoint | null>(null);
  const [openOnly, setOpenOnly] = useState(false);

  const providers = useMemo(() => [...new Set(points.map((p) => p.provider))], [points]);
  const colour = (p: ModelPoint) => SERIES[providers.indexOf(p.provider) % SERIES.length];
  const all = useMemo(() => frontier(points), [points]);
  const open = useMemo(() => frontier(points.filter((p) => p.open)), [points]);
  const onFrontier = useMemo(() => new Set(all), [all]);

  const s = scalesFor(points);
  const [costCap, setCostCap] = useState(0.6);
  const [timeCap, setTimeCap] = useState(0.6);
  const fromSlider = (f: number, [lo, hi]: [number, number]) =>
    10 ** (Math.log10(lo) + f * (Math.log10(hi) - Math.log10(lo)));
  const maxCost = fromSlider(costCap, s.cost);
  const maxMinutes = fromSlider(timeCap, s.minutes);
  const pick = bestWithin(points, { maxCost, maxMinutes, openOnly });

  const usePasted = () => {
    const r = parseCsv(csv);
    setErrors(r.errors);
    if (r.models.length) {
      setPoints(r.models);
      setSource('pasted');
      setSelected(null);
    }
  };

  return (
    <main className="page-pareto">
      <p className="kicker">Cost and operations</p>
      <h1>Quality, cost and time: the Pareto frontier of models</h1>
      <p className="lede">
        No model is best on everything. A stronger one costs more and takes longer; a cheap one is quick and makes more
        mistakes. The useful question is which models are worth considering at all: those that no other model beats on
        quality, cost and time at once. Together they form the Pareto frontier, and everything else is a model you would
        never pick on these three measures alone.
      </p>
      <p className="note small">
        The models below are invented, and so are their numbers. Real scores change every few weeks and belong to
        whoever measured them, so paste real data into <a href="#your-data">your own data</a> to see today's frontier.
      </p>

      <h2>The frontier in three dimensions</h2>
      <p>
        Each point is one model at one effort setting. Up is quality, and the floor has cost and time per task, both on
        a log scale. The star marks the corner nobody reaches: the best quality for nothing, instantly. Frontier models
        are drawn larger and joined in order of quality; diamonds have open weights, and the dashed line is the frontier
        among those alone.
      </p>
      <div className="pf-layout">
        <Cube3D
          points={points}
          colour={colour}
          onFrontier={onFrontier}
          openFrontier={open}
          selected={selected}
          onSelect={setSelected}
        />
        <aside className="card pf-side">
          <h3>Providers</h3>
          <ul className="pf-legend">
            {providers.map((p) => (
              <li key={p}>
                <span className="pf-swatch" style={{ background: SERIES[providers.indexOf(p) % SERIES.length] }} />
                {p}
              </li>
            ))}
          </ul>
          <h3>Selected</h3>
          {selected ? (
            <>
              <p>
                <b>{selected.name}</b>
                <br />
                <span className="small muted">
                  {selected.provider}
                  {selected.open ? ', open weights' : ''}
                </span>
              </p>
              <p className="small">
                Quality {selected.quality}, {money(selected.cost)} and {time(selected.minutes)} a task.
              </p>
              <p className="small">
                {onFrontier.has(selected)
                  ? 'On the frontier: no model is at least as good on all three and better on one.'
                  : `Off the frontier: beaten on all three by ${points
                      .filter((q) => dominates(q, selected))
                      .slice(0, 2)
                      .map((q) => q.name)
                      .join(' and ')}.`}
              </p>
            </>
          ) : (
            <p className="small muted">Select a point on the chart.</p>
          )}
          <p className="small">
            {all.length} of {points.length} models are on the frontier; {open.length} on the open-weight frontier.
          </p>
        </aside>
      </div>

      <h2>Why a flat chart hides part of the frontier</h2>
      <p>
        Most comparisons plot quality against one measure. Each view below has its own, smaller frontier. A model that
        is neither the cheapest nor the strongest can still be the right choice because it answers fastest, and that
        only shows when all three measures are kept.
      </p>
      <div className="pf-flats">
        <Flat points={points} axis="cost" colour={colour} onFrontier={onFrontier} />
        <Flat points={points} axis="minutes" colour={colour} onFrontier={onFrontier} />
      </div>

      <h2>The frontier models</h2>
      <h3>All models ({all.length})</h3>
      <FrontierTable rows={all} empty="No models loaded." />
      <h3>Open-weight models only ({open.length})</h3>
      <FrontierTable rows={open} empty="None of these models has open weights." />

      <h2>Pick a model for a budget and a deadline</h2>
      <p>
        The frontier says which models are worth considering; your limits pick one. Set what one task may cost and how
        long it may take, and the page takes the best quality that fits. Look at what moving each limit changes: often
        relaxing the deadline buys more quality than doubling the budget, because higher effort settings mostly cost
        time.
      </p>
      <div className="card pf-pick">
        <label>
          At most {money(maxCost)} a task
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={costCap}
            onChange={(e) => setCostCap(Number(e.target.value))}
          />
        </label>
        <label>
          At most {time(maxMinutes)} a task
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={timeCap}
            onChange={(e) => setTimeCap(Number(e.target.value))}
          />
        </label>
        <label className="pf-check">
          <input type="checkbox" checked={openOnly} onChange={(e) => setOpenOnly(e.target.checked)} /> Open weights only
          (for example, to run it on your own hardware)
        </label>
        <p className="pf-result" aria-live="polite">
          {pick ? (
            <>
              <b>{pick.name}</b>: quality {pick.quality}, {money(pick.cost)} and {time(pick.minutes)} a task.
            </>
          ) : (
            'Nothing fits. Raise the budget or the deadline.'
          )}
        </p>
      </div>

      <h2>Reading it honestly</h2>
      <ul>
        <li>
          <b>Effort settings are separate points.</b> One model at low, high and maximum effort traces its own line up
          and to the left: more thinking buys quality with diminishing returns, and the cost and the wait grow faster.{' '}
          <Link to="/effort-and-cost">Model, effort and cost</Link> shows why.
        </li>
        <li>
          <b>A quality index is an average over someone else's tasks.</b> A model on the frontier of a general index may
          not be on the frontier for your task. Measure on your own cases with <Link to="/evals">Evals</Link>; read
          benchmark claims with <Link to="/benchmarks">Benchmarks</Link> in mind.
        </li>
        <li>
          <b>Cost per task is not price per token.</b> A model that thinks for longer or writes more can cost more a
          task at a lower token price. Caching and batching change it again: see{' '}
          <Link to="/prompt-caching">Prompt caching</Link>.
        </li>
        <li>
          <b>Time includes the queue.</b> Measured time depends on the provider's load and region, and it moves from
          week to week. <Link to="/live">Live Claude</Link> and <Link to="/observability">Monitoring</Link> measure your
          own.
        </li>
        <li>
          <b>You rarely need one model.</b> A cheap model for easy requests and a strong one for hard ones can sit off
          the frontier of single models: <Link to="/routing">Routing</Link> works through when a cascade pays.
        </li>
        <li>
          <b>Log scales flatter the cheap end.</b> One step on the cost axis is ten times the price. Read the numbers,
          not the distances.
        </li>
      </ul>

      <h2 id="your-data">Your own data</h2>
      <p>
        Paste CSV with a header row: <code>name</code>, <code>quality</code>, <code>cost</code> (US dollars a task) and{' '}
        <code>minutes</code> (a task) are needed; <code>provider</code> and <code>open</code> (yes or no) are optional.
        Measure them yourself, or export them from a benchmark site whose terms allow it. Nothing leaves your browser.
      </p>
      <textarea
        className="pf-csv"
        rows={8}
        value={csv}
        placeholder={'name,provider,open,quality,cost,minutes\nMy model (High),Me,no,51,0.42,2.5'}
        onChange={(e) => setCsv(e.target.value)}
        aria-label="CSV of models"
      />
      <div className="row pf-controls">
        <button type="button" className="btn small primary" onClick={usePasted} disabled={!csv.trim()}>
          Use this data
        </button>
        <button
          type="button"
          className="btn small"
          onClick={() => {
            setPoints(SAMPLE);
            setSource('sample');
            setErrors([]);
            setSelected(null);
          }}
          disabled={source === 'sample'}
        >
          Back to the invented models
        </button>
        <button type="button" className="btn small" onClick={() => setCsv(toCsv(points))}>
          Copy the current models into the box
        </button>
      </div>
      {errors.length > 0 && (
        <ul className="pf-errors small">
          {errors.slice(0, 10).map((e) => (
            <li key={e}>{e}</li>
          ))}
          {errors.length > 10 && <li>and {errors.length - 10} more.</li>}
        </ul>
      )}
      <p className="small muted">
        Showing {source === 'sample' ? 'the invented models' : 'your pasted data'}: {points.length} models.
      </p>

      <h2>The same calculation in Python</h2>
      <CodeBlock html={SNIPPET} />
    </main>
  );
}
