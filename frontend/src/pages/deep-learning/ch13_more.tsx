/* Chapter 13, continued: neighbourhood sampling on a larger graph, and graph attention. */
import { useMemo, useState, type ReactNode } from 'react';
import type { NotebookDef } from './chapters';
import { fmt, gauss, mean, rng, softmax, sum } from './kit';
import { Chips, Notebook, Readout, Slider } from './Notebook';
import { Plot } from './Plot';

/* ---------- small helpers ---------- */

type Edge = [number, number];

function neighbourLists(n: number, edges: Edge[]): number[][] {
  const out = Array.from({ length: n }, () => [] as number[]);
  for (const [a, b] of edges) {
    out[a].push(b);
    out[b].push(a);
  }
  return out;
}

/** Hop distance from `start` to every node (Infinity where unreachable), by breadth-first search. */
function hops(nbrs: number[][], start: number): number[] {
  const d = nbrs.map(() => Infinity);
  d[start] = 0;
  const queue = [start];
  for (let q = 0; q < queue.length; q++) {
    const v = queue[q];
    for (const u of nbrs[v]) {
      if (d[u] === Infinity) {
        d[u] = d[v] + 1;
        queue.push(u);
      }
    }
  }
  return d;
}

/** Up to k items picked from xs without replacement. */
function pick(xs: number[], k: number, rand: () => number): number[] {
  if (xs.length <= k) return [...xs];
  const pool = [...xs];
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(rand() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, k);
}

/** A brand-coloured fill whose strength runs from 0 (surface) to 1. */
const tint = (t: number) =>
  `color-mix(in srgb, var(--brand) ${Math.round(Math.max(0, Math.min(1, t)) * 80)}%, var(--surface))`;

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

/* ---------- 13.3 Neighbourhood sampling ---------- */

const COLS = 16;
const ROWS = 7;
const GAP = 37;

interface BigGraph {
  pos: [number, number][];
  edges: Edge[];
  nbrs: number[][];
}

/** A grid-like graph with random local links and some long-range shortcuts, so neighbourhoods grow fast. */
function makeBigGraph(seed: number): BigGraph {
  const rand = rng(seed);
  const n = COLS * ROWS;
  const pos = Array.from({ length: n }, (_, v): [number, number] => [
    22 + (v % COLS) * GAP + (rand() - 0.5) * 16,
    22 + Math.floor(v / COLS) * GAP + (rand() - 0.5) * 16,
  ]);
  const seen = new Set<string>();
  const edges: Edge[] = [];
  const add = (a: number, b: number) => {
    const key = a < b ? `${a}-${b}` : `${b}-${a}`;
    if (a === b || seen.has(key)) return;
    seen.add(key);
    edges.push([a, b]);
  };
  for (let v = 0; v < n; v++) {
    const c = v % COLS;
    const r = Math.floor(v / COLS);
    if (c + 1 < COLS && rand() < 0.7) add(v, v + 1);
    if (r + 1 < ROWS && rand() < 0.7) add(v, v + COLS);
    if (c + 1 < COLS && r + 1 < ROWS && rand() < 0.25) add(v, v + COLS + 1);
    if (c > 0 && r + 1 < ROWS && rand() < 0.25) add(v, v + COLS - 1);
  }
  for (let i = 0; i < 24; i++) add(Math.floor(rand() * n), Math.floor(rand() * n));
  let nbrs = neighbourLists(n, edges);
  for (let v = 0; v < n; v++) if (!nbrs[v].length) add(v, v % COLS < COLS - 1 ? v + 1 : v - 1);
  nbrs = neighbourLists(n, edges);
  // Join any piece cut off from node 0 to its nearest node in the main part.
  for (let guard = 0; guard < n; guard++) {
    const d = hops(nbrs, 0);
    const lost = d.findIndex((x) => x === Infinity);
    if (lost < 0) break;
    let best = 0;
    let bestDist = Infinity;
    d.forEach((x, u) => {
      const dist = Math.hypot(pos[u][0] - pos[lost][0], pos[u][1] - pos[lost][1]);
      if (x < Infinity && dist < bestDist) [best, bestDist] = [u, dist];
    });
    add(lost, best);
    nbrs = neighbourLists(n, edges);
  }
  return { pos, edges, nbrs };
}

/**
 * The nodes needed at each depth when every node needed at one depth draws k of its neighbours for the depth
 * below. sets[l] holds the nodes whose embeddings must be computed l layers below the output.
 */
function sampleField(g: BigGraph, target: number, depth: number, k: number, rand: () => number) {
  const sets: Set<number>[] = [new Set([target])];
  const used: Edge[] = [];
  for (let l = 1; l <= depth; l++) {
    const next = new Set(sets[l - 1]);
    for (const v of sets[l - 1]) {
      for (const u of pick(g.nbrs[v], k, rand)) {
        next.add(u);
        used.push([v, u]);
      }
    }
    sets.push(next);
  }
  return { sets, used };
}

const MAX_DEPTH = 4;

function NeighbourhoodSampling() {
  const [seed, setSeed] = useState(4);
  const [target, setTarget] = useState(3 * COLS + 7);
  const [depth, setDepth] = useState(3);
  const [k, setK] = useState(2);
  const [draw, setDraw] = useState(1);
  const [mode, setMode] = useState<'full' | 'sampled'>('sampled');
  const g = useMemo(() => makeBigGraph(seed), [seed]);
  const n = g.pos.length;
  const dist = useMemo(() => hops(g.nbrs, target), [g, target]);
  const sample = useMemo(
    () => sampleField(g, target, depth, k, rng(draw * 7919 + target)),
    [g, target, depth, k, draw],
  );

  const fullAt = (l: number) => dist.filter((d) => d <= l).length;
  const bound = (l: number) => (1 + k) ** l;
  const average = useMemo(() => {
    const totals = new Array<number>(MAX_DEPTH + 1).fill(0);
    const draws = 60;
    for (let t = 0; t < draws; t++) {
      const s = sampleField(g, target, MAX_DEPTH, k, rng(1000 + t));
      s.sets.forEach((set, l) => (totals[l] += set.size));
    }
    return totals.map((v) => v / draws);
  }, [g, target, k]);

  // When each node first enters the computation, counted from the output layer.
  const sampledLevel = new Map<number, number>();
  sample.sets.forEach((set, l) => set.forEach((v) => !sampledLevel.has(v) && sampledLevel.set(v, l)));
  const level = (v: number) => (mode === 'full' ? (dist[v] <= depth ? dist[v] : -1) : (sampledLevel.get(v) ?? -1));
  const usedKeys = new Set(sample.used.map(([a, b]) => (a < b ? `${a}-${b}` : `${b}-${a}`)));
  const active = (a: number, b: number) =>
    mode === 'full'
      ? Math.min(dist[a], dist[b]) < depth && Math.abs(dist[a] - dist[b]) <= 1
      : usedKeys.has(a < b ? `${a}-${b}` : `${b}-${a}`);
  const messagesFull = g.edges.filter(([a, b]) => Math.min(dist[a], dist[b]) < depth && dist[a] !== dist[b]).length;
  const fullCount = fullAt(depth);
  const sampledCount = sample.sets[depth].size;
  const ls = Array.from({ length: MAX_DEPTH + 1 }, (_, l) => l);

  return (
    <Notebook
      id="13.3"
      title="Neighbourhood sampling"
      intro={
        <>
          To train on one huge graph we update a batch of nodes at a time. A node&apos;s embedding after K layers
          depends on every node within K hops, and on a well-connected graph that K-hop neighbourhood soon covers most
          of the graph. Neighbourhood sampling bounds the work: working back from the output, each node needed at one
          layer draws only k of its neighbours for the layer below.
        </>
      }
      tryThis={[
        'Choose the full neighbourhood and set the layers to 4: most of the graph is needed to update one node.',
        'Switch to sampled with k = 2: at most (1 + k)ᴷ = 81 nodes, and in practice fewer, because samples overlap.',
        'Press New sample: a different set of neighbours each time, which also acts a little like dropout.',
        'Click any node to make it the batch node. Nodes on a shortcut reach far across the graph in one hop.',
      ]}
      takeaway={
        <>
          The full receptive field grows with the number of K-hop neighbours, which can be the whole graph. With
          sampling it grows by at most a factor of 1 + k per layer, whatever the degrees are, so the cost of a batch is
          fixed in advance.
        </>
      }
    >
      <div className="dl-controls">
        <Chips
          options={[
            { id: 'full', label: 'Full K-hop neighbourhood' },
            { id: 'sampled', label: 'Sampled' },
          ]}
          value={mode}
          onChange={setMode}
        />
        <Slider label="Layers K" value={depth} min={1} max={MAX_DEPTH} step={1} onChange={setDepth} show={String} />
        <Slider label="Neighbours sampled k" value={k} min={1} max={8} step={1} onChange={setK} show={String} />
        <button className="btn small" onClick={() => setDraw((d) => d + 1)}>
          New sample
        </button>
        <button className="btn small" onClick={() => setSeed((s) => s + 1)}>
          New graph
        </button>
      </div>
      <svg
        viewBox="0 0 600 262"
        style={{ width: '100%', maxWidth: 760, display: 'block' }}
        role="img"
        aria-label="A graph of 112 nodes with the receptive field of the batch node shaded"
      >
        {g.edges.map(([a, b], i) => {
          const on = active(a, b);
          return (
            <line
              key={i}
              x1={g.pos[a][0]}
              y1={g.pos[a][1]}
              x2={g.pos[b][0]}
              y2={g.pos[b][1]}
              style={{
                stroke: on ? 'var(--brand)' : 'var(--line2)',
                strokeWidth: on ? 2.2 : 1,
                opacity: on ? 0.9 : 0.7,
              }}
            />
          );
        })}
        {g.pos.map(([x, y], v) => {
          const l = level(v);
          return (
            <circle
              key={v}
              cx={x}
              cy={y}
              r={v === target ? 8 : 6}
              onClick={() => setTarget(v)}
              style={{
                cursor: 'pointer',
                fill: l < 0 ? 'var(--surface)' : tint(1 - l / (depth + 1)),
                stroke: v === target ? 'var(--ink)' : l < 0 ? 'var(--line2)' : 'var(--brand)',
                strokeWidth: v === target ? 2.5 : 1.2,
              }}
            >
              <title>{`node ${v}: ${dist[v]} hop${dist[v] === 1 ? '' : 's'} away, ${g.nbrs[v].length} neighbours`}</title>
            </circle>
          );
        })}
      </svg>
      <p className="dl-caption">
        The ringed node is the batch node. Darker nodes are needed closer to the output; highlighted edges carry the
        messages that are computed. Click a node to make it the batch node.
      </p>
      <Readout
        items={[
          ['nodes needed, full', `${fullCount} (${Math.round((fullCount / n) * 100)}% of ${n})`],
          ['nodes needed, this sample', `${sampledCount} (${Math.round((sampledCount / n) * 100)}%)`],
          ['bound (1 + k)ᴷ', bound(depth)],
          ['messages, full', messagesFull],
          ['messages, sampled (k per node per layer)', sample.used.length],
          ['batch node degree', g.nbrs[target].length],
        ]}
      />
      <div className="dl-cols">
        <div className="dl-scroll">
          <table className="dl-table">
            <thead>
              <tr>
                <th>layers back</th>
                <th>full</th>
                <th>this sample</th>
                <th>bound (1 + k)ˡ</th>
              </tr>
            </thead>
            <tbody>
              {ls.slice(0, depth + 1).map((l) => (
                <tr key={l}>
                  <td>{l}</td>
                  <td>{fullAt(l)}</td>
                  <td>{sample.sets[l].size}</td>
                  <td>{bound(l)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="dl-caption">
            Cumulative counts: every node whose embedding must be computed at that depth or above.
          </p>
        </div>
        <div>
          <Plot
            x={[0, MAX_DEPTH]}
            y={[0, n]}
            height={200}
            xLabel="layers"
            yLabel="nodes in the receptive field"
            ariaLabel="Receptive field size against the number of layers, with and without sampling"
            draw={(f) => {
              f.line(ls, ls.map(fullAt), f.c.s1);
              f.dots(
                ls.map((l) => [l, fullAt(l)] as [number, number]),
                f.c.s1,
              );
              f.line(ls, average, f.c.s2);
              f.dots(
                ls.map((l) => [l, average[l]] as [number, number]),
                f.c.s2,
              );
              f.line(
                ls,
                ls.map((l) => Math.min(n, bound(l))),
                f.c.muted,
                1.5,
                [5, 4],
              );
              f.hline(n, f.c.muted, [2, 3]);
            }}
          />
          <Legend
            items={[
              ['s1', 'full K-hop neighbourhood'],
              ['s2', `sampled, k = ${k} (mean of 60 draws)`],
              ['muted', 'bound (1 + k)ᴷ, capped at the graph size'],
            ]}
          />
        </div>
      </div>
    </Notebook>
  );
}

/* ---------- 13.4 Graph attention ---------- */

const A_POS: [number, number][] = [
  [40, 45],
  [40, 155],
  [115, 100],
  [190, 35],
  [190, 165],
  [265, 100],
  [115, 182],
];
const A_EDGES: Edge[] = [
  [0, 1],
  [0, 2],
  [1, 2],
  [2, 3],
  [2, 4],
  [3, 4],
  [3, 5],
  [4, 5],
  [1, 6],
  [6, 4],
];
const A_X = [
  [1.0, 0.2],
  [0.9, 0.0],
  [0.5, 0.5],
  [0.1, 1.0],
  [0.3, 0.8],
  [0.0, 1.2],
  [0.8, 0.4],
];
const A_NBRS = neighbourLists(A_POS.length, A_EDGES);

type Act = 'leaky' | 'relu' | 'none';
const ACT: Record<Act, (z: number) => number> = {
  leaky: (z) => (z > 0 ? z : 0.2 * z),
  relu: (z) => Math.max(0, z),
  none: (z) => z,
};

const cellStyle = (v: number, max: number) => ({
  background: Number.isFinite(v) && v !== 0 ? tint((Math.abs(v) / max) * 0.8) : undefined,
});

function Grid({
  title,
  m,
  rows,
  cols,
  digits = 2,
  bar,
}: {
  title: ReactNode;
  m: number[][];
  rows: string[];
  cols: string[];
  digits?: number;
  bar?: number;
}) {
  const max = Math.max(1e-9, ...m.flat().filter(Number.isFinite).map(Math.abs));
  return (
    <div className="dl-scroll">
      <div className="small" style={{ fontWeight: 600, marginBottom: 4 }}>
        {title}
      </div>
      <table className="dl-table">
        <thead>
          <tr>
            <th />
            {cols.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {m.map((r, i) => (
            <tr key={i} style={{ outline: bar === i ? '2px solid var(--brand)' : undefined, outlineOffset: -2 }}>
              <th>{rows[i]}</th>
              {r.map((v, j) => (
                <td key={j} style={cellStyle(v, max)}>
                  {v === -Infinity ? '−∞' : Number.isNaN(v) ? '·' : v.toFixed(digits)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function GraphAttention() {
  const [seed, setSeed] = useState(2);
  const [phi, setPhi] = useState([2, -2, 0.5, 0.5]);
  const [act, setAct] = useState<Act>('leaky');
  const [node, setNode] = useState(2);
  const lin = useMemo(() => {
    const rand = rng(seed);
    const omega = [0, 1].map(() => [0, 1].map(() => gauss(rand)));
    const beta = [0, 1].map(() => gauss(rand) * 0.2);
    return { omega, beta };
  }, [seed]);
  // H′ = β1ᵀ + ΩH, one row per node here.
  const Hp = A_X.map((x) => lin.omega.map((row, i) => lin.beta[i] + row[0] * x[0] + row[1] * x[1]));
  const near = (v: number) => [v, ...A_NBRS[v]];
  const raw = (m: number, v: number) => phi[0] * Hp[m][0] + phi[1] * Hp[m][1] + phi[2] * Hp[v][0] + phi[3] * Hp[v][1];
  const S = Hp.map((_, v) => Hp.map((__, m) => (near(v).includes(m) ? ACT[act](raw(m, v)) : -Infinity)));
  const att = S.map((row) => {
    const idx = row.map((s, m) => (s === -Infinity ? -1 : m)).filter((m) => m >= 0);
    const w = softmax(idx.map((m) => row[m]));
    const out = row.map(() => 0);
    idx.forEach((m, i) => (out[m] = w[i]));
    return out;
  });
  const out = att.map((row) => [0, 1].map((j) => Math.max(0, sum(row.map((a, m) => a * Hp[m][j])))));
  const gcn = (v: number) => 1 / (A_NBRS[v].length + 1);
  const row = att[node];
  const entropy = -sum(row.map((p) => (p > 1e-12 ? p * Math.log(p) : 0)));
  const labels = A_POS.map((_, v) => String(v));
  const setPhiAt = (i: number) => (v: number) => setPhi((p) => p.map((x, j) => (j === i ? v : x)));
  const maxW = Math.max(...row);

  return (
    <Notebook
      id="13.4"
      title="Graph attention"
      intro={
        <>
          A graph convolutional network weights each neighbour by a fixed number set by the graph. A graph attention
          layer computes the weights from the data. Each node is transformed, h′ = β + Ωh. A learned vector φ scores
          every pair as s = a[φᵀ[h′ₘ; h′ₙ]], and a softmax over node n and its neighbours (the mask A + I) turns the
          scores into weights. The new embedding is the weighted sum of the h′, passed through a ReLU.
        </>
      }
      tryThis={[
        'Click each node. The edge widths and the node shading show how much the clicked node attends to each neighbour and to itself.',
        'Set all four φ entries to 0: every weight becomes 1/(degree + 1), the same as mean aggregation with a self-loop.',
        'Choose no activation and move φ₃ or φ₄: nothing changes, because they add the same amount to every score of a node and softmax ignores a constant.',
        'Turn φ₁ up and φ₂ down: nodes attend to neighbours with a large first feature, whichever side of the graph they are on.',
      ]}
      takeaway={
        <>
          Graph attention is self-attention with a mask: each node only looks at itself and its neighbours, and the
          weights depend on what the nodes contain. In training, φ, Ω and β are learned by gradient descent along with
          the rest of the network.
        </>
      }
    >
      <div className="dl-controls">
        <Slider label="φ₁ (neighbour, f1)" value={phi[0]} min={-4} max={4} step={0.1} onChange={setPhiAt(0)} />
        <Slider label="φ₂ (neighbour, f2)" value={phi[1]} min={-4} max={4} step={0.1} onChange={setPhiAt(1)} />
        <Slider label="φ₃ (self, f1)" value={phi[2]} min={-4} max={4} step={0.1} onChange={setPhiAt(2)} />
        <Slider label="φ₄ (self, f2)" value={phi[3]} min={-4} max={4} step={0.1} onChange={setPhiAt(3)} />
      </div>
      <div className="dl-controls">
        <span className="small muted">Activation a[·] on the scores</span>
        <Chips
          options={[
            { id: 'leaky', label: 'Leaky ReLU (0.2)' },
            { id: 'relu', label: 'ReLU' },
            { id: 'none', label: 'None' },
          ]}
          value={act}
          onChange={setAct}
        />
        <button className="btn small" onClick={() => setPhi([0, 0, 0, 0])}>
          φ = 0
        </button>
        <button className="btn small" onClick={() => setSeed((s) => s + 1)}>
          New Ω and β
        </button>
      </div>
      <div className="dl-cols">
        <div>
          <svg
            viewBox="0 0 300 200"
            style={{ width: '100%', maxWidth: 380, display: 'block' }}
            role="img"
            aria-label="Graph with attention weights"
          >
            {A_EDGES.map(([a, b], i) => {
              const other = a === node ? b : b === node ? a : -1;
              const w = other >= 0 ? row[other] : 0;
              return (
                <line
                  key={i}
                  x1={A_POS[a][0]}
                  y1={A_POS[a][1]}
                  x2={A_POS[b][0]}
                  y2={A_POS[b][1]}
                  style={{
                    stroke: other >= 0 ? 'var(--brand)' : 'var(--line2)',
                    strokeWidth: other >= 0 ? 1 + 12 * w : 1.5,
                  }}
                />
              );
            })}
            {A_EDGES.map(([a, b], i) => {
              const other = a === node ? b : b === node ? a : -1;
              if (other < 0) return null;
              const mx = (A_POS[a][0] + A_POS[b][0]) / 2;
              const my = (A_POS[a][1] + A_POS[b][1]) / 2;
              return (
                <text
                  key={i}
                  x={mx}
                  y={my - 6}
                  textAnchor="middle"
                  style={{ fill: 'var(--ink)', fontSize: 10, fontWeight: 600 }}
                >
                  {row[other].toFixed(2)}
                </text>
              );
            })}
            {A_POS.map(([x, y], v) => (
              <g key={v} onClick={() => setNode(v)} style={{ cursor: 'pointer' }}>
                <circle
                  cx={x}
                  cy={y}
                  r={15}
                  style={{
                    fill: row[v] > 0 ? tint(row[v] / Math.max(maxW, 1e-9)) : 'var(--surface)',
                    stroke: v === node ? 'var(--ink)' : 'var(--ink2)',
                    strokeWidth: v === node ? 3.5 : 1.5,
                  }}
                />
                <text x={x} y={y + 4} textAnchor="middle" style={{ fill: 'var(--ink)', fontSize: 12, fontWeight: 600 }}>
                  {v}
                </text>
              </g>
            ))}
            <text
              x={A_POS[node][0]}
              y={A_POS[node][1] + 28}
              textAnchor="middle"
              style={{ fill: 'var(--ink2)', fontSize: 10 }}
            >
              self {row[node].toFixed(2)}
            </text>
          </svg>
          <p className="dl-caption">Node {node} is selected. Click another node to see its weights.</p>
        </div>
        <div className="dl-scroll">
          <div className="small" style={{ fontWeight: 600, marginBottom: 4 }}>
            Node {node}: where its attention goes
          </div>
          <table className="dl-table">
            <thead>
              <tr>
                <th>m</th>
                <th>h′ₘ</th>
                <th>φᵀ[h′ₘ; h′ₙ]</th>
                <th>s after a[·]</th>
                <th>attention</th>
                <th>GCN mean</th>
              </tr>
            </thead>
            <tbody>
              {near(node).map((m) => (
                <tr key={m}>
                  <th>{m === node ? `${m} (self)` : m}</th>
                  <td>
                    {Hp[m][0].toFixed(2)}, {Hp[m][1].toFixed(2)}
                  </td>
                  <td>{raw(m, node).toFixed(2)}</td>
                  <td>{S[node][m].toFixed(2)}</td>
                  <td style={cellStyle(row[m], 1)}>{row[m].toFixed(3)}</td>
                  <td>{gcn(node).toFixed(3)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Readout
            items={[
              ['weights sum to', sum(row).toFixed(3)],
              [`entropy (uniform = ln ${near(node).length} = ${Math.log(near(node).length).toFixed(3)})`, fmt(entropy)],
              ['new embedding of this node', out[node].map((v) => v.toFixed(2)).join(', ')],
            ]}
          />
        </div>
      </div>
      <div className="dl-cols">
        <Grid title="H: input features" m={A_X} rows={labels} cols={['f1', 'f2']} />
        <Grid title="H′ = β + Ωh: transformed" m={Hp} rows={labels} cols={['f1', 'f2']} />
        <Grid title="Scores S, masked to A + I" m={S} rows={labels} cols={labels} bar={node} digits={1} />
        <Grid
          title="Softmask: attention (each row sums to 1)"
          m={att.map((r) => r.map((v) => (v === 0 ? NaN : v)))}
          rows={labels}
          cols={labels}
          bar={node}
        />
      </div>
      <p className="dl-caption">
        Row n is the node attending; column m is the node it looks at. The book stores nodes as columns, so its softmax
        runs down each column; the sums are the same.
      </p>
      <Readout
        items={[
          ['Ω', lin.omega.map((r) => `[${r.map((v) => v.toFixed(2)).join(', ')}]`).join(' ')],
          ['β', lin.beta.map((v) => v.toFixed(2)).join(', ')],
          ['average weight on self', fmt(mean(att.map((r, v) => r[v])))],
        ]}
      />
    </Notebook>
  );
}

export const NOTEBOOKS_13: NotebookDef[] = [
  { id: '13.3', title: 'Neighbourhood sampling', Component: NeighbourhoodSampling },
  { id: '13.4', title: 'Graph attention', Component: GraphAttention },
];
