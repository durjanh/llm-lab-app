import { useState } from 'react';

/**
 * Splitting a training run across GPUs: data parallel, ZeRO / FSDP, tensor parallel and pipeline parallel, with a memory
 * and communication calculator, a picture of the split, and a pipeline timeline with its bubble.
 */

interface Big {
  label: string;
  params: number; // billions
  layers: number;
  d: number;
}
const MODELS: Big[] = [
  { label: '8B (Llama 3.1 8B)', params: 8.03, layers: 32, d: 4096 },
  { label: '70B (Llama 3.1 70B)', params: 70.6, layers: 80, d: 8192 },
  { label: '405B (Llama 3.1 405B)', params: 405, layers: 126, d: 16384 },
];
const GPU_GB = 80;
const MICRO_TOKENS = 4096; // one sequence of 4,096 tokens per micro-batch
const STAGE_COLOURS = ['s1', 's2', 's3', 's4', 's5', 'brand'];

const gb = (bytes: number) => bytes / 1e9;
const fmt = (g: number) => (g >= 100 ? g.toFixed(0) : g >= 10 ? g.toFixed(1) : g.toFixed(2));

export default function Parallel() {
  const [pick, setPick] = useState(1);
  const [dp, setDp] = useState(8);
  const [tp, setTp] = useState(8);
  const [pp, setPp] = useState(4);
  const [zero, setZero] = useState(1);
  const [micro, setMicro] = useState(8);
  const m = MODELS[pick];
  const gpus = dp * tp * pp;
  const P = m.params * 1e9;
  const Pg = P / (tp * pp); // parameters held by one GPU before ZeRO sharding
  const weights = (2 * Pg) / (zero >= 3 ? dp : 1);
  const grads = (2 * Pg) / (zero >= 2 ? dp : 1);
  const optim = (12 * Pg) / (zero >= 1 ? dp : 1);
  // Activations with full checkpointing, split by tensor parallelism (sequence parallel), for the micro-batches a
  // stage holds at once in a one-forward-one-backward schedule (at most the number of stages).
  const inFlight = Math.min(micro, pp);
  const acts = (2 * (m.layers / pp) * MICRO_TOKENS * m.d * inFlight) / tp;
  const total = weights + grads + optim + acts;
  const fits = gb(total) <= GPU_GB;

  // Communication per training step, per GPU, roughly.
  const dpBytes = dp > 1 ? (zero >= 3 ? 3 : 2) * 2 * Pg * ((dp - 1) / dp) : 0; // ring all-reduce of 16-bit gradients (+ parameter all-gathers for ZeRO-3)
  const tpBytes = tp > 1 ? 4 * (m.layers / pp) * micro * MICRO_TOKENS * m.d * 2 * (2 * (tp - 1) / tp) : 0; // 4 all-reduces of activations per layer
  const ppBytes = pp > 1 ? 2 * micro * MICRO_TOKENS * m.d * 2 / tp : 0; // activations forward, their gradients back, at each stage boundary
  const bubble = (pp - 1) / (micro + pp - 1);

  const opt = (vals: number[], value: number, set: (v: number) => void, label: string) => (
    <label>
      {label}
      <select value={value} onChange={(e) => set(+e.target.value)}>
        {vals.map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <section className="sc-section">
      <h2>3. Splitting the work across GPUs</h2>
      <p>
        A 70B model needs over a terabyte of memory to train, against 80 GB on one GPU, and months of compute on one GPU. So big
        runs split the work four ways at once:
      </p>
      <div className="sc-cards sc-four">
        <div className="card">
          <b>Data parallel</b>
          <p className="small">
            Every GPU holds a full copy of the model and trains on different examples; after each step their gradients are
            averaged (an all-reduce) so the copies stay identical. Easy, but every GPU needs the whole model.
          </p>
        </div>
        <div className="card">
          <b>ZeRO / FSDP</b>
          <p className="small">
            Data parallel without the copies: stage 1 shards the optimiser state across the data-parallel GPUs, stage 2 also
            the gradients, stage 3 also the weights, gathered layer by layer when needed. PyTorch FSDP is stage 3.
          </p>
        </div>
        <div className="card">
          <b>Tensor parallel</b>
          <p className="small">
            Split each layer's matrices across GPUs, which each do part of every multiplication and combine results twice per
            layer. Needs very fast links, so it stays inside one server (NVLink), usually 8 GPUs.
          </p>
        </div>
        <div className="card">
          <b>Pipeline parallel</b>
          <p className="small">
            Split the layers into stages on different GPUs; activations pass from stage to stage. Little communication, but
            stages wait for each other: the pipeline bubble, below.
          </p>
        </div>
      </div>

      <h3>Plan a run</h3>
      <div className="sc-controls">
        <label>
          Model
          <select value={pick} onChange={(e) => setPick(+e.target.value)}>
            {MODELS.map((x, i) => (
              <option key={x.label} value={i}>
                {x.label}
              </option>
            ))}
          </select>
        </label>
        {opt([1, 2, 4, 8, 16, 32, 64], dp, setDp, 'Data parallel')}
        {opt([1, 2, 4, 8], tp, setTp, 'Tensor parallel')}
        {opt([1, 2, 4, 8, 16], pp, setPp, 'Pipeline stages')}
        <label>
          ZeRO stage
          <select value={zero} onChange={(e) => setZero(+e.target.value)}>
            <option value={0}>0 (none)</option>
            <option value={1}>1 (optimiser state)</option>
            <option value={2}>2 (+ gradients)</option>
            <option value={3}>3 (+ weights, as FSDP)</option>
          </select>
        </label>
        {opt([1, 2, 4, 8, 16, 32], micro, setMicro, 'Micro-batches per step')}
      </div>

      <div className="sc-plan">
        <div className="card">
          <div className="sc-plan-head">
            <b>{gpus.toLocaleString('en-GB')} GPUs</b> <span className="sc-note">= {dp} data × {tp} tensor × {pp} pipeline</span>
          </div>
          <table className="t sc-table">
            <tbody>
              <tr>
                <td>Weights (bf16)</td>
                <td className="num">{fmt(gb(weights))} GB</td>
              </tr>
              <tr>
                <td>Gradients (bf16)</td>
                <td className="num">{fmt(gb(grads))} GB</td>
              </tr>
              <tr>
                <td>Optimiser state (fp32 master + Adam)</td>
                <td className="num">{fmt(gb(optim))} GB</td>
              </tr>
              <tr>
                <td>Activations ({inFlight} micro-batch{inFlight > 1 ? 'es' : ''} in flight)</td>
                <td className="num">{fmt(gb(acts))} GB</td>
              </tr>
              <tr className="sc-total">
                <td>
                  <b>Per GPU</b>
                </td>
                <td className={`num ${fits ? 'sc-good' : 'sc-bad'}`}>
                  <b>{fmt(gb(total))} GB</b> {fits ? '✓ fits in 80 GB' : '✕ over 80 GB'}
                </td>
              </tr>
            </tbody>
          </table>
          <div className="sc-membar" aria-hidden="true">
            <span style={{ width: `${Math.min(100, (100 * gb(total)) / GPU_GB)}%` }} className={fits ? 'ok' : 'over'} />
          </div>
        </div>
        <div className="card">
          <b>Communication per step, per GPU (rough)</b>
          <table className="t sc-table">
            <tbody>
              <tr>
                <td>Data parallel: average gradients{zero >= 3 ? ', gather weights' : ''}</td>
                <td className="num">{dp > 1 ? `${fmt(gb(dpBytes))} GB` : 'none'}</td>
              </tr>
              <tr>
                <td>Tensor parallel: combine partial results, 4 times per layer</td>
                <td className="num">{tp > 1 ? `${fmt(gb(tpBytes))} GB` : 'none'}</td>
              </tr>
              <tr>
                <td>Pipeline: pass activations to the next stage</td>
                <td className="num">{pp > 1 ? `${fmt(gb(ppBytes))} GB` : 'none'}</td>
              </tr>
            </tbody>
          </table>
          <p className="sc-note">
            Tensor parallel moves the most data, every layer, so it needs NVLink inside one server (8 GPUs at most here).
            Pipeline parallel moves little, so it can cross servers. Data parallel happens once per step and can overlap with
            the backward pass.
          </p>
        </div>
      </div>
      <SplitDiagram dp={dp} tp={tp} pp={pp} layers={m.layers} zero={zero} />
      <p className="sc-note">
        Simplifications: weights, gradients and optimiser state divide evenly; activations are with full checkpointing,{' '}
        {MICRO_TOKENS.toLocaleString('en-GB')} tokens per micro-batch, split by tensor parallelism (sequence parallel) and
        kept for at most one micro-batch per stage (a one-forward-one-backward schedule); communication volumes are the ring
        all-reduce estimates, ignoring overlap. Framework buffers and fragmentation are left out.
      </p>

      <h3>The pipeline bubble</h3>
      <p>
        With pipeline stages, the last stage cannot start until the first has finished, and in the backward pass the first
        waits for the last. Splitting each batch into more micro-batches shrinks the idle time: the bubble is{' '}
        <b>(p − 1) / (m + p − 1)</b> of the time for p stages and m micro-batches. Here, p = {pp} and m = {micro}:{' '}
        <b>{(100 * bubble).toFixed(1)}%</b> idle.
      </p>
      <Timeline p={pp} m={micro} />
    </section>
  );
}

function SplitDiagram({ dp, tp, pp, layers, zero }: { dp: number; tp: number; pp: number; layers: number; zero: number }) {
  const shown = Math.min(dp, 2);
  const per = Math.ceil(layers / pp);
  return (
    <div className="sc-split" aria-label={`${dp} data-parallel copies, each split into ${pp} pipeline stages of ${tp} GPUs`}>
      {Array.from({ length: shown }, (_, r) => (
        <div key={r} className="sc-replica">
          <div className="sc-note">
            Data-parallel copy {r + 1}
            {zero >= 1 ? `, its ${['', 'optimiser state', 'optimiser state and gradients', 'whole state'][zero]} sharded across the ${dp} copies` : ''}
          </div>
          <div className="sc-stages">
            {Array.from({ length: pp }, (_, s) => (
              <div key={s} className="sc-stage" style={{ borderColor: `var(--${STAGE_COLOURS[s % STAGE_COLOURS.length]})` }}>
                <div className="sc-stage-head">
                  Stage {s + 1}: layers {s * per + 1}–{Math.min(layers, (s + 1) * per)}
                </div>
                <div className="sc-gpus">
                  {Array.from({ length: tp }, (_, g) => (
                    <span key={g} className="sc-gpu" title={`GPU with 1/${tp} of each matrix in layers ${s * per + 1}–${Math.min(layers, (s + 1) * per)}`}>
                      {tp > 1 ? `1/${tp}` : 'all'}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
      {dp > shown && <div className="sc-note">…and {dp - shown} more identical copies, each on its own {tp * pp} GPUs.</div>}
    </div>
  );
}

/** A GPipe-style schedule: all forwards, then all backwards. Idle cells are the bubble. */
function Timeline({ p, m }: { p: number; m: number }) {
  const T = 2 * (m + p - 1);
  const cells: { s: number; t: number; kind: 'F' | 'B'; j: number }[] = [];
  for (let s = 0; s < p; s++) {
    for (let j = 0; j < m; j++) {
      cells.push({ s, t: s + j, kind: 'F', j });
      cells.push({ s, t: m + p - 1 + (p - 1 - s) + j, kind: 'B', j });
    }
  }
  const idle = p * T - cells.length;
  const W = 100 / T;
  return (
    <div className="sc-timeline">
      {Array.from({ length: p }, (_, s) => (
        <div key={s} className="sc-tl-row">
          <span className="sc-tl-label">Stage {s + 1}</span>
          <div className="sc-tl-track">
            {cells
              .filter((c) => c.s === s)
              .map((c) => (
                <span key={`${c.kind}${c.j}`} className={`sc-tl-cell ${c.kind}`} style={{ left: `${c.t * W}%`, width: `${W}%` }} title={`${c.kind === 'F' ? 'Forward' : 'Backward'} of micro-batch ${c.j + 1}`}>
                  {T <= 40 ? c.j + 1 : ''}
                </span>
              ))}
          </div>
        </div>
      ))}
      <div className="sc-legend small">
        <span><i className="sc-tl-key F" /> forward pass of a micro-batch</span>
        <span><i className="sc-tl-key B" /> backward pass</span>
        <span><i className="sc-tl-key idle" /> idle (the bubble)</span>
        <span className="mono">
          idle slots {idle} of {p * T} = {((100 * idle) / (p * T)).toFixed(1)}%
        </span>
      </div>
    </div>
  );
}
