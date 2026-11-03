import { useMemo, useRef, useState } from 'react';
import { Plot } from '../deep-learning/Plot';
import { gauss, rng, useAnimation } from '../deep-learning/kit';

/**
 * LoRA: keep the pretrained weight W frozen and learn a low-rank update B·A beside it. First the parameter counts for
 * real models, then a real training run in the browser: the change to learn has rank 2, so rank 1 cannot fit it.
 */

interface Shape {
  label: string;
  params: number; // whole model, billions
  layers: number;
  d: number; // hidden size
  kv: number; // width of the key and value projections (grouped-query attention)
}
// Published Llama 3.x shapes.
const MODELS: Shape[] = [
  { label: 'Llama 3.1 8B', params: 8.03, layers: 32, d: 4096, kv: 1024 },
  { label: 'Llama 3.1 70B', params: 70.6, layers: 80, d: 8192, kv: 1024 },
];

const fmtCount = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)} B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)} k` : String(n));

// --- The training run -------------------------------------------------------------------------
const D = 32;
const RANKS = [1, 2, 4];
const COLOURS = ['s2', 's1', 's3'] as const;

type Mat = Float64Array; // row-major
const mat = (rows: number, cols: number) => new Float64Array(rows * cols);

/** A random orthonormal set of k columns of length D (Gram–Schmidt), as a D×k matrix. */
function orthonormal(k: number, r: () => number): Mat {
  const q = mat(D, k);
  for (let j = 0; j < k; j++) {
    const v = Array.from({ length: D }, () => gauss(r));
    for (let p = 0; p < j; p++) {
      let dot = 0;
      for (let i = 0; i < D; i++) dot += v[i] * q[i * k + p];
      for (let i = 0; i < D; i++) v[i] -= dot * q[i * k + p];
    }
    const norm = Math.hypot(...v);
    for (let i = 0; i < D; i++) q[i * k + j] = v[i] / norm;
  }
  return q;
}

interface Run {
  r: number;
  A: Mat; // r×D, random start
  B: Mat; // D×r, zero start (so B·A starts at zero, as in LoRA)
  mA: Mat; vA: Mat; mB: Mat; vB: Mat;
  losses: number[];
}

function setup(seed: number) {
  const r = rng(seed);
  const U = orthonormal(2, r);
  const V = orthonormal(2, r);
  // ΔW = 3·u1·v1ᵀ + 2·u2·v2ᵀ: rank 2, singular values 3 and 2.
  const dW = mat(D, D);
  for (let i = 0; i < D; i++) for (let j = 0; j < D; j++) dW[i * D + j] = 3 * U[i * 2] * V[j * 2] + 2 * U[i * 2 + 1] * V[j * 2 + 1];
  const runs: Run[] = RANKS.map((k) => ({
    r: k,
    A: Float64Array.from({ length: k * D }, () => gauss(r) / Math.sqrt(D)),
    B: mat(D, k),
    mA: mat(k, D), vA: mat(k, D), mB: mat(D, k), vB: mat(D, k),
    losses: [],
  }));
  for (const run of runs) run.losses.push(errorOf(run, dW));
  return { dW, runs, inputs: rng(seed + 1), t: 0 };
}

/** ‖B·A − ΔW‖², the expected loss over random inputs x ~ N(0, I). */
function errorOf(run: Run, dW: Mat): number {
  let s = 0;
  for (let i = 0; i < D; i++) {
    for (let j = 0; j < D; j++) {
      let ba = 0;
      for (let p = 0; p < run.r; p++) ba += run.B[i * run.r + p] * run.A[p * D + j];
      s += (ba - dW[i * D + j]) ** 2;
    }
  }
  return s;
}

const BATCH = 32;
const LR = 0.02;

/** One Adam step on a fresh batch of random inputs: loss = mean ‖(B·A − ΔW)x‖². */
function step(run: Run, dW: Mat, r: () => number, t: number) {
  const k = run.r;
  // M = B·A − ΔW
  const M = mat(D, D);
  for (let i = 0; i < D; i++) for (let j = 0; j < D; j++) {
    let ba = 0;
    for (let p = 0; p < k; p++) ba += run.B[i * k + p] * run.A[p * D + j];
    M[i * D + j] = ba - dW[i * D + j];
  }
  // G = (2/n) · M · X · Xᵀ, the gradient with respect to B·A, from n random inputs.
  const X = Float64Array.from({ length: D * BATCH }, () => gauss(r));
  const MX = mat(D, BATCH);
  for (let i = 0; i < D; i++) for (let c = 0; c < BATCH; c++) {
    let s = 0;
    for (let j = 0; j < D; j++) s += M[i * D + j] * X[j * BATCH + c];
    MX[i * BATCH + c] = s;
  }
  const G = mat(D, D);
  for (let i = 0; i < D; i++) for (let j = 0; j < D; j++) {
    let s = 0;
    for (let c = 0; c < BATCH; c++) s += MX[i * BATCH + c] * X[j * BATCH + c];
    G[i * D + j] = (2 / BATCH) * s;
  }
  // dL/dB = G·Aᵀ, dL/dA = Bᵀ·G
  const gB = mat(D, k), gA = mat(k, D);
  for (let i = 0; i < D; i++) for (let p = 0; p < k; p++) {
    let s = 0;
    for (let j = 0; j < D; j++) s += G[i * D + j] * run.A[p * D + j];
    gB[i * k + p] = s;
  }
  for (let p = 0; p < k; p++) for (let j = 0; j < D; j++) {
    let s = 0;
    for (let i = 0; i < D; i++) s += run.B[i * k + p] * G[i * D + j];
    gA[p * D + j] = s;
  }
  const adam = (w: Mat, g: Mat, m: Mat, v: Mat) => {
    for (let i = 0; i < w.length; i++) {
      m[i] = 0.9 * m[i] + 0.1 * g[i];
      v[i] = 0.999 * v[i] + 0.001 * g[i] * g[i];
      w[i] -= (LR * (m[i] / (1 - 0.9 ** t))) / (Math.sqrt(v[i] / (1 - 0.999 ** t)) + 1e-8);
    }
  };
  adam(run.A, gA, run.mA, run.vA);
  adam(run.B, gB, run.mB, run.vB);
  run.losses.push(errorOf(run, dW));
}

const MAX_STEPS = 400;

export default function Lora() {
  const [model, setModel] = useState(0);
  const [rank, setRank] = useState(16);
  const [targets, setTargets] = useState<'qv' | 'qkvo'>('qv');
  const m = MODELS[model];
  const perLayer = (in_: number, out: number) => rank * (in_ + out); // B is out×r, A is r×in
  const shapes: [string, number, number][] = [
    ['q', m.d, m.d],
    ['k', m.d, m.kv],
    ['v', m.d, m.kv],
    ['o', m.d, m.d],
  ];
  const chosen = shapes.filter(([name]) => (targets === 'qv' ? name === 'q' || name === 'v' : true));
  const lora = m.layers * chosen.reduce((s, [, i, o]) => s + perLayer(i, o), 0);
  const covered = m.layers * chosen.reduce((s, [, i, o]) => s + i * o, 0);
  const full = m.params * 1e9;

  // The live training run, three ranks side by side.
  const [seed, setSeed] = useState(5);
  const state = useRef(setup(seed));
  const [running, setRunning] = useState(false);
  const [, tick] = useState(0);
  useAnimation(running, () => {
    const s = state.current;
    for (let n = 0; n < 4 && s.t < MAX_STEPS; n++) {
      s.t += 1;
      for (const run of s.runs) step(run, s.dW, s.inputs, s.t);
    }
    tick((x) => x + 1);
    if (s.t >= MAX_STEPS) {
      setRunning(false);
      return false;
    }
  });
  const reset = (next = seed) => {
    setRunning(false);
    state.current = setup(next);
    tick((x) => x + 1);
  };
  const s = state.current;
  const last = s.runs.map((run) => run.losses[run.losses.length - 1]);
  const steps = useMemo(() => Array.from({ length: MAX_STEPS + 1 }, (_, i) => i), []);

  return (
    <section className="sc-section">
      <h2>1. LoRA: fine-tune a sliver of the model</h2>
      <p>
        Full fine-tuning changes every weight. <b>LoRA</b> (low-rank adaptation) freezes the pretrained matrix <i>W</i> and
        learns a small update beside it: <i>W</i> + <i>B</i>·<i>A</i>, where <i>B</i> is d × r and <i>A</i> is r × d for a
        small rank r. A d × d matrix has d² weights; the update has only 2·d·r. The bet is that the change fine-tuning needs is
        low-rank: it moves the model in a few directions, not all of them.
      </p>

      <div className="sc-controls">
        <label>
          Model
          <select value={model} onChange={(e) => setModel(+e.target.value)}>
            {MODELS.map((x, i) => (
              <option key={x.label} value={i}>
                {x.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Rank r
          <select value={rank} onChange={(e) => setRank(+e.target.value)}>
            {[1, 2, 4, 8, 16, 32, 64, 128].map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
        <label>
          Adapters on
          <select value={targets} onChange={(e) => setTargets(e.target.value as 'qv' | 'qkvo')}>
            <option value="qv">query and value projections (the LoRA paper)</option>
            <option value="qkvo">all four attention projections</option>
          </select>
        </label>
      </div>

      <div className="sc-cards">
        <div className="card sc-stat">
          <span className="sc-big">{fmtCount(full)}</span>
          <span className="small muted">trained by full fine-tuning</span>
        </div>
        <div className="card sc-stat">
          <span className="sc-big">{fmtCount(lora)}</span>
          <span className="small muted">trained by LoRA ({((100 * lora) / full).toFixed(lora / full < 0.001 ? 3 : 2)}% of the model)</span>
        </div>
        <div className="card sc-stat">
          <span className="sc-big">{lora * 2 >= 1e9 ? `${((lora * 2) / 1e9).toFixed(2)} GB` : `${((lora * 2) / 1e6).toFixed(1)} MB`}</span>
          <span className="small muted">adapter file at 16-bit, against {(full * 2 / 1e9).toFixed(0)} GB for a full copy</span>
        </div>
      </div>
      <div className="table-wrap">
        <table className="t sc-table">
          <thead>
            <tr>
              <th>Projection, per layer</th>
              <th className="num">Shape</th>
              <th className="num">Weights in W</th>
              <th className="num">LoRA weights (r = {rank})</th>
            </tr>
          </thead>
          <tbody>
            {shapes.map(([name, i, o]) => {
              const on = chosen.some(([n]) => n === name);
              return (
                <tr key={name} className={on ? '' : 'sc-off'}>
                  <td>
                    W<sub>{name}</sub> {on ? '' : '(frozen, no adapter)'}
                  </td>
                  <td className="num">
                    {i.toLocaleString('en-GB')} × {o.toLocaleString('en-GB')}
                  </td>
                  <td className="num">{fmtCount(i * o)}</td>
                  <td className="num">{on ? fmtCount(perLayer(i, o)) : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="sc-note">
        Shapes from Llama 3.1 ({m.layers} layers, hidden size {m.d.toLocaleString('en-GB')}, keys and values {m.kv.toLocaleString('en-GB')}{' '}
        wide because of grouped-query attention). The adapted matrices hold {fmtCount(covered)} weights; LoRA trains{' '}
        {((100 * lora) / covered).toFixed(2)}% as many. Adding adapters to the feed-forward layers too is common and multiplies
        the count by about four.
      </p>

      <h3>Watch it learn: what rank does the change need?</h3>
      <p>
        A real run, in your browser. The update to learn, ΔW, is a 32 × 32 matrix of <b>rank 2</b> (singular values 3 and 2).
        Three LoRA adapters of rank 1, 2 and 4 start from B = 0 (so the model starts unchanged, as in LoRA) and train with Adam
        on random inputs. The loss is ‖B·A − ΔW‖², the expected error over inputs.
      </p>
      <div className="sc-controls">
        <button className="btn primary" onClick={() => (s.t >= MAX_STEPS ? (reset(), setRunning(true)) : setRunning(!running))}>
          {running ? 'Pause' : s.t >= MAX_STEPS ? 'Run again' : s.t > 0 ? 'Resume' : 'Train'}
        </button>
        <button className="btn" onClick={() => reset()}>
          Reset
        </button>
        <button className="btn" onClick={() => (setSeed(seed + 1), reset(seed + 1))}>
          New ΔW
        </button>
        <span className="small muted">
          step {s.t} of {MAX_STEPS}
        </span>
      </div>
      <Plot
        x={[0, MAX_STEPS]}
        y={[-4, 1.5]}
        height={240}
        xLabel="step"
        yLabel="log₁₀ loss"
        ariaLabel="Loss of LoRA rank 1, 2 and 4 during training"
        draw={(f) => {
          f.hline(Math.log10(4), f.c.muted);
          f.text('rank-1 floor = 2² = 4', MAX_STEPS * 0.62, Math.log10(4) + 0.18, f.c.muted);
          s.runs.forEach((run, i) => {
            f.line(steps.slice(0, run.losses.length), run.losses.map((l) => Math.log10(Math.max(l, 1e-4))), f.c[COLOURS[i]], 2.5);
          });
        }}
      />
      <div className="sc-legend small">
        {s.runs.map((run, i) => (
          <span key={run.r}>
            <i style={{ background: `var(--${COLOURS[i]})` }} /> rank {run.r}: loss <b className="mono">{last[i] < 1e-3 ? last[i].toExponential(1) : last[i].toFixed(3)}</b>
          </span>
        ))}
      </div>
      <p className="small">
        <b>What to notice.</b> Rank 1 can only capture the larger direction, so it stops at the error of the smaller one: 2² =
        4, the dashed line (the best rank-1 approximation leaves exactly that, by the Eckart–Young theorem). Rank 2 matches the
        change and goes to almost zero; rank 4 has more room than it needs and does just as well. In practice r = 8 to 64 is
        typical, and the right rank is found by trying.
      </p>
      <div className="card sc-aside small">
        <b>Two tricks that make LoRA cheap in practice.</b> <b>QLoRA</b> stores the frozen base model in 4-bit and trains the
        adapters in 16-bit, so a 70B model can be fine-tuned on one or two large GPUs. And after training, the adapter can be{' '}
        <b>merged</b>: W′ = W + B·A is just another matrix of the same shape, so the fine-tuned model runs exactly as fast as
        the original. Or keep adapters separate and swap them per customer on one shared base model.
      </div>
    </section>
  );
}
