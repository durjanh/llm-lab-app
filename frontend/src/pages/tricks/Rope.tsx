import { useMemo, useState } from 'react';
import { Plot } from '../deep-learning/Plot';
import { gauss, rng } from '../deep-learning/kit';

/**
 * RoPE: rotate each pair of a query's and a key's numbers by an angle of position × frequency. The dot product of two
 * rotated vectors then depends only on the difference of their positions, so attention sees relative position.
 */

const D = 8;
const THETA = Array.from({ length: D / 2 }, (_, i) => 10000 ** (-(2 * i) / D)); // 1, 0.1, 0.01, 0.001 radians per position
const SHOWN_PAIR = 1; // the pair drawn in the picture (θ = 0.1 rad per position)

function rotate(v: number[], pos: number): number[] {
  const out = [...v];
  THETA.forEach((t, i) => {
    const [x, y] = [v[2 * i], v[2 * i + 1]];
    const a = pos * t;
    out[2 * i] = x * Math.cos(a) - y * Math.sin(a);
    out[2 * i + 1] = x * Math.sin(a) + y * Math.cos(a);
  });
  return out;
}

/** The original transformer's sinusoidal positions, added to the vector instead of rotating it. */
const sinusoid = (pos: number) => THETA.flatMap((t) => [Math.sin(pos * t), Math.cos(pos * t)]);
const dot = (a: number[], b: number[]) => a.reduce((s, v, i) => s + v * b[i], 0);

export default function Rope() {
  const [seed, setSeed] = useState(3);
  const [m, setM] = useState(5);
  const [gap, setGap] = useState(4);
  const { q, k } = useMemo(() => {
    const r = rng(seed);
    return { q: Array.from({ length: D }, () => gauss(r)), k: Array.from({ length: D }, () => gauss(r)) };
  }, [seed]);
  const n = m + gap;
  const rope = (a: number, b: number) => dot(rotate(q, a), rotate(k, b));
  const added = (a: number, b: number) => dot(q.map((v, i) => v + sinusoid(a)[i]), k.map((v, i) => v + sinusoid(b)[i]));
  const xs = Array.from({ length: 61 }, (_, i) => i);
  const ropeLine = xs.map((p) => rope(p, p + gap));
  const addLine = xs.map((p) => added(p, p + gap));
  const all = [...ropeLine, ...addLine];
  const lo = Math.min(...all) - 0.5;
  const hi = Math.max(...all) + 0.5;

  // The picture: one pair of the query and key, rotated by its position.
  const angle = (pos: number) => pos * THETA[SHOWN_PAIR];
  const qp = [q[2 * SHOWN_PAIR], q[2 * SHOWN_PAIR + 1]];
  const kp = [k[2 * SHOWN_PAIR], k[2 * SHOWN_PAIR + 1]];
  const arrow = (v: number[], a: number) => {
    const len = Math.hypot(v[0], v[1]) || 1;
    const base = Math.atan2(v[1], v[0]) + a;
    const r = 70 * Math.min(1, len / 2) + 20;
    return [90 + r * Math.cos(base), 90 - r * Math.sin(base)];
  };
  const [qx, qy] = arrow(qp, angle(m));
  const [kx, ky] = arrow(kp, angle(n));

  return (
    <section className="tr-section">
      <h2>1. RoPE: position by rotation</h2>
      <p>
        Attention compares a query with a key by a dot product, which on its own knows nothing about where the two tokens are.
        The original transformer <b>added</b> a position pattern to each token. <b>Rotary position embedding (RoPE)</b>, used by
        Llama, Mistral, Qwen and most models since, instead <b>rotates</b> each pair of numbers in the query and key by an angle
        of <i>position × frequency</i>. Rotating both and taking the dot product leaves only the <b>difference</b> of the two
        angles, so the score depends on how far apart the tokens are, not where they sit.
      </p>
      <div className="tr-controls">
        <label>
          Query position <input type="range" min={0} max={50} value={m} onChange={(e) => setM(+e.target.value)} /> <b className="mono">{m}</b>
        </label>
        <label>
          Gap to the key <input type="range" min={-16} max={16} value={gap} onChange={(e) => setGap(+e.target.value)} /> <b className="mono">{gap}</b>
        </label>
        <button className="btn small" onClick={() => setSeed((s) => s + 1)}>
          New query and key
        </button>
      </div>
      <div className="tr-two">
        <div className="card">
          <svg viewBox="0 0 180 180" className="tr-rope-svg" role="img" aria-label="One pair of the query and key, each rotated by its position">
            <circle cx="90" cy="90" r="88" className="tr-axis" />
            <line x1="2" y1="90" x2="178" y2="90" className="tr-axis" />
            <line x1="90" y1="2" x2="90" y2="178" className="tr-axis" />
            <line x1="90" y1="90" x2={qx} y2={qy} className="tr-vec q" />
            <line x1="90" y1="90" x2={kx} y2={ky} className="tr-vec k" />
            <circle cx={qx} cy={qy} r="4" className="tr-dot q" />
            <circle cx={kx} cy={ky} r="4" className="tr-dot k" />
          </svg>
          <p className="small">
            <span className="tr-key q">query</span> at position {m}, <span className="tr-key k">key</span> at position {n}. This pair
            turns {THETA[SHOWN_PAIR]} radians per position, so the angle between them is the gap × {THETA[SHOWN_PAIR]} ={' '}
            {((gap * THETA[SHOWN_PAIR] * 180) / Math.PI).toFixed(1)}°, wherever they are.
          </p>
        </div>
        <div className="card">
          <table className="t">
            <tbody>
              <tr>
                <td>RoPE score, positions {m} and {n}</td>
                <td className="num">
                  <b>{rope(m, n).toFixed(4)}</b>
                </td>
              </tr>
              <tr>
                <td>RoPE score, positions 0 and {gap}</td>
                <td className="num">{rope(0, gap).toFixed(4)}</td>
              </tr>
              <tr>
                <td>Added positions, {m} and {n}</td>
                <td className="num">
                  <b>{added(m, n).toFixed(4)}</b>
                </td>
              </tr>
              <tr>
                <td>Added positions, 0 and {gap}</td>
                <td className="num">{added(0, gap).toFixed(4)}</td>
              </tr>
            </tbody>
          </table>
          <p className="small">
            Move the query along with the gap fixed: the RoPE score stays the same (to rounding), the added-position score does not.
            Change the gap: the RoPE score changes.
          </p>
        </div>
      </div>
      <div className="card">
        <Plot
          x={[0, 60]}
          y={[lo, hi]}
          height={200}
          xLabel="query position (key = query + gap)"
          yLabel="score"
          ariaLabel="Attention score against position for a fixed gap, RoPE and added positions"
          draw={(f) => {
            f.line(xs, addLine, f.c.s2, 2);
            f.line(xs, ropeLine, f.c.s1, 3);
            f.vline(m, f.c.muted);
          }}
        />
        <div className="tr-legend small">
          <span>
            <i style={{ background: 'var(--s1)' }} /> RoPE: flat, depends only on the gap
          </span>
          <span>
            <i style={{ background: 'var(--s2)' }} /> added positions: changes with where the pair sits
          </span>
        </div>
        <p className="tr-note">
          Eight dimensions in four pairs, turning 1, 0.1, 0.01 and 0.001 radians per position (base 10,000, as in the RoPE paper).
          Fast pairs tell near neighbours apart; slow pairs carry long distances. Stretching these frequencies is how models extend
          their context window after training.
        </p>
      </div>
    </section>
  );
}
