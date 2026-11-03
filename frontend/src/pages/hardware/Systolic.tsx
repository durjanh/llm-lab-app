import { useEffect, useMemo, useState } from 'react';
import { rng } from '@/pages/deep-learning/kit';
import './systolic.css';

const N = 4;
const TICKS = 3 * N - 2; // the last multiply happens at tick 3N-3; ticks are counted from 1
const CELL = 64;
const SLOT = 26; // spacing of values still queued outside the grid
const GX = 200; // grid origin
const GY = 200;

function matrices(seed: number) {
  const r = rng(seed);
  const m = () => Array.from({ length: N }, () => Array.from({ length: N }, () => 1 + Math.floor(r() * 5)));
  return { A: m(), B: m() };
}

function multiply(A: number[][], B: number[][]): number[][] {
  return A.map((row, i) => B[0].map((_, j) => row.reduce((s, a, k) => s + a * B[k][j], 0)));
}

/**
 * An output-stationary systolic array: cell (i, j) keeps C[i][j]. Row i of A enters from the left and
 * column j of B from the top, each skewed by one tick per row or column, so at tick t cell (i, j) holds
 * A[i][k] and B[k][j] with k = t - i - j, multiplies them and adds to its sum. Values then move one cell on.
 */
export default function Systolic() {
  const [seed, setSeed] = useState(7);
  const [done, setDone] = useState(0); // ticks completed
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(700); // ms per tick
  const { A, B } = useMemo(() => matrices(seed), [seed]);
  const C = useMemo(() => multiply(A, B), [A, B]);

  useEffect(() => {
    if (!playing) return;
    if (done >= TICKS) {
      setPlaying(false);
      return;
    }
    const t = window.setTimeout(() => setDone((d) => Math.min(TICKS, d + 1)), speed);
    return () => window.clearTimeout(t);
  }, [playing, done, speed]);

  // Running sums after `done` ticks: every k with i + j + k < done has been multiplied in.
  const acc = A.map((row, i) => B[0].map((_, j) => row.reduce((s, a, k) => (i + j + k < done ? s + a * B[k][j] : s), 0)));
  const now = done - 1; // the tick just completed
  const kAt = (i: number, j: number) => now - i - j;
  const active = (i: number, j: number) => done > 0 && kAt(i, j) >= 0 && kAt(i, j) < N;
  const activeCount = A.flatMap((_, i) => B[0].map((__, j) => active(i, j))).filter(Boolean).length;
  const finished = done >= TICKS;
  const matches = finished && acc.every((row, i) => row.every((v, j) => v === C[i][j]));

  // Memory reads so far: the array reads each A and B value once, when it enters; a naive multiplier
  // reads both operands for every multiply-add.
  let systolicReads = 0;
  let macs = 0;
  for (let i = 0; i < N; i++) {
    for (let k = 0; k < N; k++) {
      if (i + k < done) systolicReads += 2; // A[i][k] enters row i at tick i+k; B[k][i] symmetric
      for (let j = 0; j < N; j++) if (i + j + k < done) macs += 1;
    }
  }
  const naiveReads = 2 * macs;

  // Where a value sits: column (or row) c = now - i - k; negative means still queued outside the grid.
  const pos = (c: number) => (c >= 0 ? GX + c * CELL : GX + c * SLOT);

  function reset(newSeed?: number) {
    setPlaying(false);
    setDone(0);
    if (newSeed !== undefined) setSeed(newSeed);
  }

  return (
    <section className="hw-section">
      <h2>Inside a TPU: the systolic array</h2>
      <p>
        A TPU multiplies matrices with a grid of tiny multiply-add cells. Numbers are read from memory once, then passed from
        cell to neighbouring cell on every clock tick, like a heartbeat ("systolic"). Here a 4×4 grid computes C = A × B: rows of
        A enter from the left, columns of B from the top, each shifted one tick so the right pairs meet. Every cell keeps its own
        running sum, which ends as one entry of C.
      </p>
      <div className="hw-controls">
        <button className="btn small" disabled={finished} onClick={() => setDone((d) => Math.min(TICKS, d + 1))}>
          Step
        </button>
        <button className="btn small primary" onClick={() => (finished ? (setDone(0), setPlaying(true)) : setPlaying((p) => !p))}>
          {playing ? 'Pause' : finished ? 'Play again' : 'Play'}
        </button>
        <button className="btn small" onClick={() => reset()}>
          Reset
        </button>
        <button className="btn small" onClick={() => reset(seed + 1)}>
          New numbers
        </button>
        <label>
          Speed
          <input type="range" min={150} max={1500} step={50} value={1650 - speed} onChange={(e) => setSpeed(1650 - +e.target.value)} />
        </label>
      </div>

      <div className="sy-wrap">
        <svg className="sy-svg" viewBox="0 0 480 480" role="img" aria-label={`Systolic array after tick ${done} of ${TICKS}`}>
          <text x={GX} y={14} className="sy-label">
            columns of B enter from the top ↓
          </text>
          <text x={8} y={GY - 10} className="sy-label">
            rows of A →
          </text>
          {/* cells */}
          {A.map((_, i) =>
            B[0].map((__, j) => (
              <g key={`c${i}${j}`} className={`sy-cell ${active(i, j) ? 'on' : ''} ${finished ? 'done' : ''}`}>
                <rect x={GX + j * CELL + 2} y={GY + i * CELL + 2} width={CELL - 4} height={CELL - 4} rx={8} />
                <text x={GX + j * CELL + CELL / 2} y={GY + i * CELL + CELL / 2 + 10} textAnchor="middle" className="sy-acc">
                  {acc[i][j]}
                </text>
              </g>
            )),
          )}
          {/* A values flowing right, along each row */}
          {A.map((row, i) =>
            row.map((v, k) => {
              const c = now - i - k;
              if (c >= N) return null; // passed out of the grid
              const inside = c >= 0;
              return (
                <g key={`a${i}${k}`} className={`sy-val sy-a ${inside ? 'in' : ''}`} style={{ transform: `translate(${pos(c) + (inside ? 12 : 4)}px, ${GY + i * CELL + (inside ? 22 : 38)}px)` }}>
                  <text textAnchor="middle">{v}</text>
                </g>
              );
            }),
          )}
          {/* B values flowing down, along each column */}
          {B.map((row, k) =>
            row.map((v, j) => {
              const r = now - j - k;
              if (r >= N) return null;
              const inside = r >= 0;
              return (
                <g key={`b${k}${j}`} className={`sy-val sy-b ${inside ? 'in' : ''}`} style={{ transform: `translate(${GX + j * CELL + (inside ? 50 : 32)}px, ${pos(r) + (inside ? 18 : 18)}px)` }}>
                  <text textAnchor="middle">{v}</text>
                </g>
              );
            }),
          )}
        </svg>

        <div className="sy-side">
          <div className="sy-readout">
            <div>
              <b className="mono">
                {done} / {TICKS}
              </b>
              <span>clock tick</span>
            </div>
            <div>
              <b className="mono">{activeCount}</b>
              <span>cells multiplying this tick</span>
            </div>
            <div>
              <b className="mono">{systolicReads}</b>
              <span>values read from memory (array)</span>
            </div>
            <div>
              <b className="mono">{naiveReads}</b>
              <span>reads if every multiply fetched its own operands</span>
            </div>
          </div>
          <div className="sy-mats">
            <Mat name="A" m={A} />
            <span className="sy-op">×</span>
            <Mat name="B" m={B} />
            <span className="sy-op">=</span>
            <Mat name="C (computed directly)" m={C} />
          </div>
          <p className={`small ${finished ? (matches ? 'sy-ok' : 'sy-bad') : 'muted'}`}>
            {finished
              ? matches
                ? `✓ After ${TICKS} ticks every cell holds its entry of A × B.`
                : '✕ The grid does not match A × B.'
              : `Step through: after ${TICKS} ticks the grid will equal A × B. Small numbers are values moving through; the big number is each cell's running sum.`}
          </p>
        </div>
      </div>

      <p className="small">
        <b>Why it saves memory traffic.</b> For a 4×4 product the array reads each of the 32 input values once ({2 * N * N}), then
        reuses every A value across its row and every B value down its column. A multiplier that fetched both operands for each of
        the 64 multiply-adds would read {2 * N * N * N}. The saving grows with size: a 256×256 grid reads {(2 * 256 * 256).toLocaleString('en-GB')}{' '}
        values instead of {(2 * 256 * 256 * 256).toLocaleString('en-GB')}, 256 times fewer. Reading memory, not multiplying, is what
        costs time and energy.
      </p>
      <p className="small muted">
        A TPU's matrix unit is a large version of this grid (128×128 cells in earlier generations, 256×256 in recent ones), fed by
        high-bandwidth memory. NVIDIA's tensor cores apply a similar idea at a smaller scale: each multiplies small matrix tiles in
        one step and reuses values held in registers and shared memory rather than re-reading them.
      </p>
    </section>
  );
}

function Mat({ name, m }: { name: string; m: number[][] }) {
  return (
    <div className="sy-mat">
      <span className="small muted">{name}</span>
      <table>
        <tbody>
          {m.map((row, i) => (
            <tr key={i}>
              {row.map((v, j) => (
                <td key={j}>{v}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
