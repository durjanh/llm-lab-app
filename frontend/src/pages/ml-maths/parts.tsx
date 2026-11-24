import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import {
  FUNCTIONS,
  MATRIX_PRESETS,
  SURFACES,
  angleDeg,
  apply2,
  chainGraph,
  cosine,
  descend,
  det2,
  dot,
  layer,
  norm,
  secantSlope,
  surfaceById,
  surfaceGrid,
  type Mat2,
  type Optimiser,
  type Vec2,
} from './mlmaths';

/* The Maths for ML page's interactive parts. Every number shown comes from mlmaths.ts. */

const f2 = (x: number) => (Math.abs(x) < 0.005 ? '0.00' : x.toFixed(2));

/** Turns a pointer position into the SVG's own coordinates, whatever size it is drawn at. */
function svgPoint(svg: SVGSVGElement, e: ReactPointerEvent): Vec2 {
  const ctm = svg.getScreenCTM();
  if (!ctm) return [0, 0];
  const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
  return [p.x, p.y];
}

/* ---------- Week 1: vectors ---------- */

const VS = 40; // pixels per unit on the vector plane
const VC = 150; // the origin, in pixels

/** Two vectors to drag: their lengths, dot product, angle and cosine similarity. */
export function Vectors() {
  const svg = useRef<SVGSVGElement>(null);
  const [a, setA] = useState<Vec2>([2.5, 1]);
  const [b, setB] = useState<Vec2>([1, 2.5]);
  const [dragging, setDragging] = useState<'a' | 'b' | null>(null);

  function move(e: ReactPointerEvent) {
    if (!dragging || !svg.current) return;
    const [px, py] = svgPoint(svg.current, e);
    const v: Vec2 = [
      Math.max(-3.5, Math.min(3.5, Math.round(((px - VC) / VS) * 4) / 4)),
      Math.max(-3.5, Math.min(3.5, Math.round(((VC - py) / VS) * 4) / 4)),
    ];
    if (dragging === 'a') setA(v);
    else setB(v);
  }
  const end = (v: Vec2) => [VC + v[0] * VS, VC - v[1] * VS];
  const cos = cosine(a, b);

  return (
    <div className="grid2 mm-pair">
      <svg
        ref={svg}
        viewBox="0 0 300 300"
        className="mm-plane"
        role="img"
        aria-label="Two vectors from the origin; drag their tips"
        onPointerMove={move}
        onPointerUp={() => setDragging(null)}
        onPointerLeave={() => setDragging(null)}
      >
        <Axes size={300} centre={VC} unit={VS} />
        {(
          [
            ['a', a, 'mm-va'],
            ['b', b, 'mm-vb'],
          ] as const
        ).map(([id, v, cls]) => {
          const [x, y] = end(v);
          return (
            <g key={id} className={cls}>
              <line x1={VC} y1={VC} x2={x} y2={y} className="mm-vec" />
              <circle
                cx={x}
                cy={y}
                r={11}
                className="mm-handle"
                onPointerDown={(e) => {
                  (e.target as Element).setPointerCapture(e.pointerId);
                  setDragging(id);
                }}
              />
              <text x={x + 12} y={y - 10} className="mm-label">
                {id}
              </text>
            </g>
          );
        })}
      </svg>
      <div>
        <table className="t mm-tight">
          <tbody>
            <tr>
              <td>a</td>
              <td className="num mono">
                [{f2(a[0])}, {f2(a[1])}]
              </td>
              <td className="muted small">length {f2(norm(a))}</td>
            </tr>
            <tr>
              <td>b</td>
              <td className="num mono">
                [{f2(b[0])}, {f2(b[1])}]
              </td>
              <td className="muted small">length {f2(norm(b))}</td>
            </tr>
            <tr>
              <td>a · b</td>
              <td className="num mono">{f2(dot(a, b))}</td>
              <td className="muted small">
                {f2(a[0])}×{f2(b[0])} + {f2(a[1])}×{f2(b[1])}
              </td>
            </tr>
            <tr>
              <td>angle</td>
              <td className="num mono">{angleDeg(a, b).toFixed(0)}°</td>
              <td />
            </tr>
            <tr>
              <td>cosine similarity</td>
              <td className="num mono">{f2(cos)}</td>
              <td className="muted small">a · b ÷ (|a| |b|)</td>
            </tr>
          </tbody>
        </table>
        <p className="small">
          {cos > 0.9
            ? 'They point almost the same way. Two embeddings like this would be close in meaning.'
            : cos > 0.2
              ? 'Partly aligned. The dot product is positive but well short of the lengths multiplied.'
              : cos > -0.2
                ? 'Near right angles: the dot product is close to zero, so they share almost nothing.'
                : 'They point in opposite directions, so the dot product is negative.'}
        </p>
      </div>
    </div>
  );
}

function Axes({ size, centre, unit }: { size: number; centre: number; unit: number }) {
  const ticks = [];
  for (let i = -Math.floor(centre / unit); i <= Math.floor((size - centre) / unit); i++) {
    if (i === 0) continue;
    ticks.push(
      <line key={`x${i}`} x1={centre + i * unit} y1={0} x2={centre + i * unit} y2={size} className="mm-grid" />,
      <line key={`y${i}`} x1={0} y1={centre - i * unit} x2={size} y2={centre - i * unit} className="mm-grid" />,
    );
  }
  return (
    <g>
      {ticks}
      <line x1={0} y1={centre} x2={size} y2={centre} className="mm-axis" />
      <line x1={centre} y1={0} x2={centre} y2={size} className="mm-axis" />
    </g>
  );
}

/* ---------- Week 1: matrices as transformations ---------- */

/** An invented little shape, so a flip or a shear is easy to see. */
const SHAPE: Vec2[] = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0.5, 1.6],
  [0, 1],
];

/** A 2×2 matrix with four sliders; the grid, the unit square and a small shape move with it. */
export function MatrixPlay() {
  const [m, setM] = useState<Mat2>([
    [1, 0.5],
    [0, 1],
  ]);
  const [note, setNote] = useState('Pick a preset, or move the four numbers.');
  const S = 34;
  const C = 160;
  const px = (v: Vec2) => {
    const [x, y] = apply2(m, v);
    return `${C + x * S},${C - y * S}`;
  };
  const lines = [];
  for (let i = -4; i <= 4; i++) {
    const a1 = apply2(m, [i, -4]),
      a2 = apply2(m, [i, 4]);
    const b1 = apply2(m, [-4, i]),
      b2 = apply2(m, [4, i]);
    lines.push(
      <line key={`v${i}`} x1={C + a1[0] * S} y1={C - a1[1] * S} x2={C + a2[0] * S} y2={C - a2[1] * S} />,
      <line key={`h${i}`} x1={C + b1[0] * S} y1={C - b1[1] * S} x2={C + b2[0] * S} y2={C - b2[1] * S} />,
    );
  }
  const d = det2(m);
  const set = (r: 0 | 1, c: 0 | 1, v: number) => {
    const n: Mat2 = [[...m[0]], [...m[1]]] as Mat2;
    n[r][c] = v;
    setM(n);
    setNote('Your own matrix.');
  };

  return (
    <div className="grid2 mm-pair">
      <svg viewBox="0 0 320 320" className="mm-plane" role="img" aria-label="A grid transformed by the matrix">
        <defs>
          <clipPath id="mm-clip">
            <rect width="320" height="320" />
          </clipPath>
        </defs>
        <g clipPath="url(#mm-clip)">
          <g className="mm-grid">{lines.map((l) => l)}</g>
          <line x1={0} y1={C} x2={320} y2={C} className="mm-axis" />
          <line x1={C} y1={0} x2={C} y2={320} className="mm-axis" />
          <polygon
            points={[
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 1],
            ]
              .map((v) => px(v as Vec2))
              .join(' ')}
            className="mm-unit"
          />
          <polygon points={SHAPE.map(px).join(' ')} className="mm-shape" />
          <line x1={C} y1={C} x2={C + m[0][0] * S} y2={C - m[1][0] * S} className="mm-vec mm-va" />
          <line x1={C} y1={C} x2={C + m[0][1] * S} y2={C - m[1][1] * S} className="mm-vec mm-vb" />
        </g>
      </svg>
      <div>
        <div className="chips">
          {MATRIX_PRESETS.map((p) => (
            <button
              key={p.name}
              type="button"
              className="chip-btn"
              onClick={() => {
                setM([[...p.m[0]], [...p.m[1]]] as Mat2);
                setNote(p.note);
              }}
            >
              {p.name}
            </button>
          ))}
        </div>
        <div className="mm-matrix">
          {([0, 1] as const).map((r) =>
            ([0, 1] as const).map((c) => (
              <label key={`${r}${c}`}>
                <span className="mono">
                  {['a', 'b', 'c', 'd'][r * 2 + c]} = {m[r][c].toFixed(2)}
                </span>
                <input
                  type="range"
                  min={-2}
                  max={2}
                  step={0.05}
                  value={m[r][c]}
                  onChange={(e) => set(r, c, +e.target.value)}
                />
              </label>
            )),
          )}
        </div>
        <p className="small">
          The first column <span className="mm-ka">(a, c)</span> is where the arrow along x lands; the second{' '}
          <span className="mm-kb">(b, d)</span> is where the arrow along y lands. Every other point follows from those
          two.
        </p>
        <p>
          Determinant ad − bc = <b className="mono">{d.toFixed(2)}</b>:{' '}
          {Math.abs(d) < 0.01
            ? 'zero. The plane is flattened onto a line and cannot be recovered, so the matrix has no inverse.'
            : d < 0
              ? `areas grow by ${Math.abs(d).toFixed(2)} and the shape is mirrored.`
              : `the shaded square's area becomes ${d.toFixed(2)}.`}
        </p>
        <p className="small muted">{note}</p>
      </div>
    </div>
  );
}

/* ---------- Week 1: a layer is a matrix-vector product ---------- */

/** A 2×3 weight matrix, a bias and three inputs: the two sums a layer computes, then the ReLU. */
export function LayerDemo() {
  const [x, setX] = useState([1, 0.5, -1]);
  const w = [
    [0.8, -0.4, 0.3],
    [-0.2, 0.9, 0.6],
  ];
  const b = [0.1, -0.3];
  const { pre, out } = layer(w, x, b);
  return (
    <div className="card">
      <div className="row">
        {x.map((v, i) => (
          <label key={i}>
            x{i + 1} = <span className="mono">{v.toFixed(1)}</span>{' '}
            <input
              type="range"
              min={-2}
              max={2}
              step={0.1}
              value={v}
              onChange={(e) => setX(x.map((o, j) => (j === i ? +e.target.value : o)))}
            />
          </label>
        ))}
      </div>
      <div className="table-wrap">
        <table className="t">
          <thead>
            <tr>
              <th>Unit</th>
              <th>Weights (a row of W)</th>
              <th>Weighted sum + bias</th>
              <th className="num">Before ReLU</th>
              <th className="num">After ReLU</th>
            </tr>
          </thead>
          <tbody>
            {w.map((row, i) => (
              <tr key={i}>
                <td>h{i + 1}</td>
                <td className="mono">[{row.join(', ')}]</td>
                <td className="mono small">
                  {row.map((wi, j) => `${wi}×${x[j].toFixed(1)}`).join(' + ')} + {b[i]}
                </td>
                <td className="num mono">{pre[i].toFixed(2)}</td>
                <td className={`num mono ${out[i] === 0 ? 'muted' : ''}`}>{out[i].toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small">
        Each output is one row of W dotted with the input, plus a bias. A negative sum is cut to zero by the ReLU, so
        that unit is silent for this input. A network is this step repeated, with the outputs of one layer as the inputs
        of the next.
      </p>
    </div>
  );
}

/* ---------- Week 1: derivatives as slope ---------- */

const DW = 360,
  DH = 240;

/** A point on a curve, the secant through a second point h away, and the tangent it approaches. */
export function Derivative() {
  const [fid, setFid] = useState('cubic');
  const [x0, setX0] = useState(0.6);
  const [h, setH] = useState(1);
  const fn = FUNCTIONS.find((f) => f.id === fid)!;
  const xs = Array.from({ length: 121 }, (_, i) => -3 + i * 0.05);
  const ys = xs.map(fn.f);
  const lo = Math.min(...ys),
    hi = Math.max(...ys);
  const X = (x: number) => ((x + 3) / 6) * DW;
  const Y = (y: number) => DH - 10 - ((y - lo) / (hi - lo || 1)) * (DH - 20);
  const slope = fn.df(x0);
  const sec = secantSlope(fn.f, x0, h);
  const line = (m: number, cls: string) => (
    <line x1={X(-3)} y1={Y(fn.f(x0) + m * (-3 - x0))} x2={X(3)} y2={Y(fn.f(x0) + m * (3 - x0))} className={cls} />
  );
  return (
    <div className="grid2 mm-pair">
      <svg viewBox={`0 0 ${DW} ${DH}`} className="mm-plot" role="img" aria-label="A curve with its tangent and secant">
        <defs>
          <clipPath id="mm-dclip">
            <rect width={DW} height={DH} />
          </clipPath>
        </defs>
        <g clipPath="url(#mm-dclip)">
          <polyline points={xs.map((x, i) => `${X(x)},${Y(ys[i])}`).join(' ')} className="mm-curve" />
          {line(sec, 'mm-secant')}
          {line(slope, 'mm-tangent')}
          <circle cx={X(x0)} cy={Y(fn.f(x0))} r={5} className="mm-dot" />
          <circle cx={X(x0 + h)} cy={Y(fn.f(x0 + h))} r={4} className="mm-dot2" />
        </g>
      </svg>
      <div>
        <div className="chips">
          {FUNCTIONS.map((f) => (
            <button
              key={f.id}
              type="button"
              className={`chip-btn ${f.id === fid ? 'on' : ''}`}
              onClick={() => setFid(f.id)}
            >
              {f.name}
            </button>
          ))}
        </div>
        <p>
          <label>
            x = <span className="mono">{x0.toFixed(2)}</span>{' '}
            <input type="range" min={-2.5} max={2.5} step={0.05} value={x0} onChange={(e) => setX0(+e.target.value)} />
          </label>
          <br />
          <label>
            h = <span className="mono">{h.toFixed(3)}</span>{' '}
            <input
              type="range"
              min={-3}
              max={0}
              step={0.05}
              value={Math.log10(h)}
              onChange={(e) => setH(10 ** +e.target.value)}
            />
          </label>
        </p>
        <table className="t mm-tight">
          <tbody>
            <tr>
              <td>
                <span className="mm-key mm-secant-key" /> secant slope (f(x+h) − f(x)) ÷ h
              </td>
              <td className="num mono">{sec.toFixed(4)}</td>
            </tr>
            <tr>
              <td>
                <span className="mm-key mm-tangent-key" /> derivative f′(x)
              </td>
              <td className="num mono">{slope.toFixed(4)}</td>
            </tr>
          </tbody>
        </table>
        <p className="small">
          Shrink h and the secant swings onto the tangent: the derivative is the slope you get in that limit. Its sign
          says which way is downhill, and its size how fast the function changes there.
        </p>
      </div>
    </div>
  );
}

/* ---------- Week 2: loss surfaces, gradients and descent ---------- */

const SW = 300;
const R = 3;
const toPx = (v: number) => ((v + R) / (2 * R)) * SW;
const toPy = (v: number) => SW - ((v + R) / (2 * R)) * SW;

/** A loss surface drawn as shaded bands: darker is lower. */
function SurfaceShade({ id }: { id: string }) {
  const cells = useMemo(() => {
    const s = surfaceById(id);
    const grid = surfaceGrid(s, 40, R);
    const vs = grid.map((g) => g.v);
    const lo = Math.min(...vs),
      hi = Math.max(...vs);
    // Banded on a square-root scale so the floor of a valley still shows detail.
    return grid.map((g) => ({ ...g, band: Math.floor(Math.sqrt((g.v - lo) / (hi - lo || 1)) * 9) }));
  }, [id]);
  const cell = SW / 40;
  return (
    <g>
      {cells.map((c, i) => (
        <rect
          key={i}
          x={toPx(c.x) - cell / 2}
          y={toPy(c.y) - cell / 2}
          width={cell + 0.5}
          height={cell + 0.5}
          className="mm-band"
          style={{ opacity: 0.9 - c.band * 0.09 }}
        />
      ))}
    </g>
  );
}

/** Click a point on the surface to see its partial derivatives and the gradient arrow. */
export function GradientField() {
  const svg = useRef<SVGSVGElement>(null);
  const [id, setId] = useState('ravine');
  const [p, setP] = useState<Vec2>([-1.5, 0.8]);
  const s = surfaceById(id);
  const [gx, gy] = s.grad(p[0], p[1]);
  const len = Math.hypot(gx, gy) || 1;
  const arrow = 40;
  return (
    <div className="grid2 mm-pair">
      <svg
        ref={svg}
        viewBox={`0 0 ${SW} ${SW}`}
        className="mm-plane mm-click"
        role="img"
        aria-label="A loss surface; click to place a point"
        onPointerDown={(e) => {
          if (!svg.current) return;
          const [x, y] = svgPoint(svg.current, e);
          setP([(x / SW) * 2 * R - R, ((SW - y) / SW) * 2 * R - R]);
        }}
      >
        <defs>
          <marker id="mm-arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M0 0L10 5L0 10z" className="mm-arrowhead" />
          </marker>
        </defs>
        <SurfaceShade id={id} />
        <circle cx={toPx(p[0])} cy={toPy(p[1])} r={5} className="mm-dot" />
        <line
          x1={toPx(p[0])}
          y1={toPy(p[1])}
          x2={toPx(p[0]) - (gx / len) * arrow}
          y2={toPy(p[1]) + (gy / len) * arrow}
          className="mm-down"
          markerEnd="url(#mm-arr)"
        />
      </svg>
      <div>
        <div className="chips">
          {SURFACES.map((x) => (
            <button
              key={x.id}
              type="button"
              className={`chip-btn ${x.id === id ? 'on' : ''}`}
              onClick={() => setId(x.id)}
            >
              {x.name}
            </button>
          ))}
        </div>
        <table className="t mm-tight">
          <tbody>
            <tr>
              <td>point (x, y)</td>
              <td className="num mono">
                ({f2(p[0])}, {f2(p[1])})
              </td>
            </tr>
            <tr>
              <td>loss</td>
              <td className="num mono">{f2(s.f(p[0], p[1]))}</td>
            </tr>
            <tr>
              <td>∂L/∂x (hold y, nudge x)</td>
              <td className="num mono">{f2(gx)}</td>
            </tr>
            <tr>
              <td>∂L/∂y (hold x, nudge y)</td>
              <td className="num mono">{f2(gy)}</td>
            </tr>
            <tr>
              <td>gradient length</td>
              <td className="num mono">{f2(Math.hypot(gx, gy))}</td>
            </tr>
          </tbody>
        </table>
        <p className="small">
          The gradient is the two partial derivatives side by side. It points uphill, so the arrow drawn is its
          negative: the steepest way down from here. On the ravine it points mostly across the valley, not along it.
        </p>
      </div>
    </div>
  );
}

const OPTS: { id: Optimiser; name: string; cls: string }[] = [
  { id: 'gd', name: 'Gradient descent', cls: 'mm-p1' },
  { id: 'momentum', name: 'Momentum', cls: 'mm-p2' },
  { id: 'adam', name: 'Adam', cls: 'mm-p3' },
];

/** Three optimisers on one surface from one start, with a shared learning rate and step count. */
export function Descent() {
  const svg = useRef<SVGSVGElement>(null);
  const [id, setId] = useState('ravine');
  const s = surfaceById(id);
  const [start, setStart] = useState<Vec2>(s.start);
  const [logLr, setLogLr] = useState(-1.3);
  const [steps, setSteps] = useState(60);
  const [shown, setShown] = useState<Record<Optimiser, boolean>>({ gd: true, momentum: true, adam: true });
  const lr = 10 ** logLr;
  const runs = OPTS.map((o) => ({ ...o, r: descend(s, o.id, lr, steps, start) }));

  return (
    <>
      <div className="row">
        <div className="chips">
          {SURFACES.map((x) => (
            <button
              key={x.id}
              type="button"
              className={`chip-btn ${x.id === id ? 'on' : ''}`}
              onClick={() => {
                setId(x.id);
                setStart(x.start);
              }}
            >
              {x.name}
            </button>
          ))}
        </div>
      </div>
      <p className="small muted">{s.lesson}</p>
      <div className="grid2 mm-pair">
        <svg
          ref={svg}
          viewBox={`0 0 ${SW} ${SW}`}
          className="mm-plane mm-click"
          role="img"
          aria-label="Optimiser paths on the loss surface; click to choose the start"
          onPointerDown={(e) => {
            if (!svg.current) return;
            const [x, y] = svgPoint(svg.current, e);
            setStart([(x / SW) * 2 * R - R, ((SW - y) / SW) * 2 * R - R]);
          }}
        >
          <SurfaceShade id={id} />
          {runs
            .filter((o) => shown[o.id])
            .map((o) => (
              <polyline
                key={o.id}
                points={o.r.path
                  .map(([x, y]) => `${toPx(Math.max(-R, Math.min(R, x)))},${toPy(Math.max(-R, Math.min(R, y)))}`)
                  .join(' ')}
                className={`mm-path ${o.cls}`}
              />
            ))}
          <circle cx={toPx(start[0])} cy={toPy(start[1])} r={5} className="mm-dot" />
        </svg>
        <div>
          <label>
            learning rate <span className="mono">{lr.toFixed(lr < 0.01 ? 4 : 3)}</span>{' '}
            <input
              type="range"
              min={-3}
              max={0}
              step={0.05}
              value={logLr}
              onChange={(e) => setLogLr(+e.target.value)}
            />
          </label>
          <br />
          <label>
            steps <span className="mono">{steps}</span>{' '}
            <input type="range" min={5} max={300} step={5} value={steps} onChange={(e) => setSteps(+e.target.value)} />
          </label>
          <div className="table-wrap">
            <table className="t mm-tight">
              <thead>
                <tr>
                  <th>Optimiser</th>
                  <th className="num">Final loss</th>
                  <th>Outcome</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((o) => (
                  <tr key={o.id}>
                    <td>
                      <label>
                        <input
                          type="checkbox"
                          checked={shown[o.id]}
                          onChange={(e) => setShown({ ...shown, [o.id]: e.target.checked })}
                        />{' '}
                        <span className={`mm-key ${o.cls}`} /> {o.name}
                      </label>
                    </td>
                    <td className="num mono">{o.r.diverged ? '—' : f2(o.r.losses[o.r.losses.length - 1])}</td>
                    <td className={`small ${o.r.diverged ? 'mm-bad' : ''}`}>
                      {o.r.diverged
                        ? `diverged after ${o.r.path.length - 1} steps`
                        : o.r.settledAt !== null
                          ? `settled at step ${o.r.settledAt}`
                          : 'still moving'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="small">
            Click the surface to choose a start. Things to try: on the ravine, raise the learning rate until plain
            descent bounces out while Adam stays calm; on the two valleys, start on the right and see which optimiser
            rolls over the hump; on the saddle, watch how long plain descent dawdles near the middle.
          </p>
        </div>
      </div>
    </>
  );
}

/* ---------- Week 2: the chain rule on a small graph ---------- */

/** L = (w·x + b)²: values flow forward, gradients flow back, each node multiplying by its local derivative. */
export function ChainRule() {
  const [w, setW] = useState(1.5);
  const [x, setX] = useState(2);
  const [b, setB] = useState(-1);
  const g = chainGraph(w, x, b);
  const node = (cx: number, cy: number, title: string, value: number, grad: number) => (
    <g className="mm-node">
      <rect x={cx - 52} y={cy - 26} width={104} height={52} rx={8} />
      <text x={cx} y={cy - 8} textAnchor="middle" className="mm-nt">
        {title}
      </text>
      <text x={cx} y={cy + 8} textAnchor="middle" className="mm-nv">
        = {value.toFixed(2)}
      </text>
      <text x={cx} y={cy + 21} textAnchor="middle" className="mm-ng">
        ∂L/∂· = {grad.toFixed(2)}
      </text>
    </g>
  );
  return (
    <div className="card">
      <div className="row">
        {(
          [
            ['w', w, setW],
            ['x', x, setX],
            ['b', b, setB],
          ] as const
        ).map(([n, v, set]) => (
          <label key={n}>
            {n} = <span className="mono">{v.toFixed(1)}</span>{' '}
            <input type="range" min={-3} max={3} step={0.1} value={v} onChange={(e) => set(+e.target.value)} />
          </label>
        ))}
      </div>
      <div className="mm-scroll">
        <svg
          viewBox="0 0 640 200"
          className="mm-graph"
          role="img"
          aria-label="A computation graph for L = (w x + b) squared"
        >
          <defs>
            <marker id="mm-garr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">
              <path d="M0 0L10 5L0 10z" className="mm-arrowhead" />
            </marker>
          </defs>
          <line x1={112} y1={50} x2={218} y2={88} className="mm-edge" markerEnd="url(#mm-garr)" />
          <line x1={112} y1={150} x2={218} y2={112} className="mm-edge" markerEnd="url(#mm-garr)" />
          <line x1={332} y1={100} x2={398} y2={100} className="mm-edge" markerEnd="url(#mm-garr)" />
          <line x1={330} y1={170} x2={398} y2={112} className="mm-edge" markerEnd="url(#mm-garr)" />
          <line x1={512} y1={100} x2={530} y2={100} className="mm-edge" markerEnd="url(#mm-garr)" />
          {node(60, 50, 'w', w, g.dL_dw)}
          {node(60, 150, 'x', x, g.dL_dx)}
          {node(275, 100, 'q = w·x', g.q, g.dL_dq)}
          {node(275, 175, 'b', b, g.dL_db)}
          {node(455, 100, 'r = q + b', g.r, g.dL_dr)}
          {node(588, 100, 'L = r²', g.L, 1)}
        </svg>
      </div>
      <p className="small">
        Read the values left to right: that is the forward pass. Read the gradients right to left: L = r² gives ∂L/∂r =
        2r = {g.dL_dr.toFixed(2)}; the sum passes it on unchanged; the product multiplies it by the other input, so
        ∂L/∂w = {g.dL_dr.toFixed(2)} × x = {g.dL_dw.toFixed(2)}. Backpropagation is exactly this, done for millions of
        weights at once.
      </p>
    </div>
  );
}
