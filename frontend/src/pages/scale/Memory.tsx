import { useState } from 'react';

/**
 * How much GPU memory training needs, against inference, LoRA and QLoRA. Byte counts per parameter for mixed-precision
 * Adam training, plus activations under a stated assumption.
 */

export interface ModelShape {
  label: string;
  params: number; // billions
  layers: number;
  d: number;
}
export const SHAPES: ModelShape[] = [
  { label: '1B (Llama 3.2 1B)', params: 1.24, layers: 16, d: 2048 },
  { label: '8B (Llama 3.1 8B)', params: 8.03, layers: 32, d: 4096 },
  { label: '70B (Llama 3.1 70B)', params: 70.6, layers: 80, d: 8192 },
];
const GPU_GB = 80;

// LoRA rank 16 on the query and value projections, with Llama's grouped-query key/value width of 1024.
const loraParams = (m: ModelShape) => m.layers * 16 * ((m.d + m.d) + (m.d + 1024));

interface Part {
  label: string;
  gb: number;
  cls: string;
}

export default function Memory() {
  const [pick, setPick] = useState(1);
  const [tokens, setTokens] = useState(16384);
  const m = SHAPES[pick];
  const P = m.params * 1e9;
  const GB = 1e9;
  // Full activation checkpointing: each layer keeps only its 16-bit input; the rest is recomputed in the backward pass.
  const act = (2 * m.layers * tokens * m.d) / GB;
  const adapters = loraParams(m);
  const rows: { name: string; note: string; parts: Part[] }[] = [
    { name: 'Inference', note: 'weights only, 16-bit (KV cache left out)', parts: [{ label: 'weights', gb: (2 * P) / GB, cls: 'w' }] },
    {
      name: 'Full fine-tuning',
      note: 'mixed-precision Adam: 16 bytes per parameter',
      parts: [
        { label: 'weights (bf16, 2 B)', gb: (2 * P) / GB, cls: 'w' },
        { label: 'gradients (bf16, 2 B)', gb: (2 * P) / GB, cls: 'g' },
        { label: 'fp32 master weights (4 B)', gb: (4 * P) / GB, cls: 'o' },
        { label: 'Adam moments (2 × 4 B)', gb: (8 * P) / GB, cls: 'o2' },
        { label: 'activations', gb: act, cls: 'a' },
      ],
    },
    {
      name: 'LoRA',
      note: 'frozen 16-bit base; adapters trained at 16 bytes each',
      parts: [
        { label: 'frozen weights (bf16)', gb: (2 * P) / GB, cls: 'w' },
        { label: 'adapters, gradients and Adam', gb: (16 * adapters) / GB, cls: 'o' },
        { label: 'activations', gb: act, cls: 'a' },
      ],
    },
    {
      name: 'QLoRA',
      note: 'frozen 4-bit base (about 0.5 B per parameter)',
      parts: [
        { label: 'frozen weights (4-bit)', gb: (0.5 * P) / GB, cls: 'w' },
        { label: 'adapters, gradients and Adam', gb: (16 * adapters) / GB, cls: 'o' },
        { label: 'activations', gb: act, cls: 'a' },
      ],
    },
  ];
  const totals = rows.map((r) => r.parts.reduce((s, p) => s + p.gb, 0));
  const max = Math.max(...totals);

  return (
    <section className="sc-section">
      <h2>2. Memory: why training needs far more than inference</h2>
      <p>
        Running a model needs its weights. Training needs much more: for every parameter, mixed-precision training with the
        Adam optimiser keeps a 16-bit weight (2 bytes) and its 16-bit gradient (2), a 32-bit master copy of the weight (4), and
        Adam's two running averages (4 + 4): <b>about 16 bytes per parameter</b>, against 2 to run it. Then the activations,
        saved during the forward pass for the backward pass. LoRA shrinks the trained part to almost nothing; QLoRA also
        shrinks the frozen part.
      </p>
      <div className="sc-controls">
        <label>
          Model
          <select value={pick} onChange={(e) => setPick(+e.target.value)}>
            {SHAPES.map((s, i) => (
              <option key={s.label} value={i}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Tokens per batch
          <select value={tokens} onChange={(e) => setTokens(+e.target.value)}>
            <option value={4096}>4,096 (1 × 4,096)</option>
            <option value={16384}>16,384 (8 × 2,048)</option>
            <option value={65536}>65,536 (16 × 4,096)</option>
          </select>
        </label>
      </div>
      <div className="sc-mem">
        {rows.map((r, i) => (
          <div key={r.name} className="sc-mem-row">
            <div className="sc-mem-head">
              <b>{r.name}</b> <span className="sc-note">{r.note}</span>
            </div>
            <div className="sc-mem-bar" role="img" aria-label={`${r.name}: ${totals[i].toFixed(1)} GB`}>
              {r.parts.map((p) => (
                <span key={p.label} className={`sc-seg ${p.cls}`} style={{ width: `${(100 * p.gb) / max}%` }} title={`${p.label}: ${p.gb.toFixed(2)} GB`} />
              ))}
            </div>
            <div className="sc-mem-total">
              <b className="mono">{totals[i] >= 100 ? totals[i].toFixed(0) : totals[i].toFixed(1)} GB</b>
              <span className="sc-note">
                {Math.ceil(totals[i] / GPU_GB)} × 80 GB GPU{Math.ceil(totals[i] / GPU_GB) > 1 ? 's' : ''}
              </span>
            </div>
          </div>
        ))}
      </div>
      <div className="sc-legend small">
        <span><i className="sc-seg w" /> weights</span>
        <span><i className="sc-seg g" /> gradients</span>
        <span><i className="sc-seg o" /> optimiser state (master weights, or the adapters' training state)</span>
        <span><i className="sc-seg o2" /> Adam moments</span>
        <span><i className="sc-seg a" /> activations</span>
      </div>
      <p className="sc-note">
        Assumptions: activations with full checkpointing, where each layer keeps only its 16-bit input ({m.layers} layers ×{' '}
        {tokens.toLocaleString('en-GB')} tokens × {m.d.toLocaleString('en-GB')} × 2 bytes = {act.toFixed(1)} GB); without
        checkpointing they are an order of magnitude larger. LoRA: rank 16 on the query and value projections (
        {(adapters / 1e6).toFixed(1)} M parameters). GPU counts assume the memory can be split across GPUs (section 3), and
        leave out framework overhead. For data cleaning, scaling laws and the training pipeline as a whole, see{' '}
        <a href="/building">How LLMs are built</a>.
      </p>
    </section>
  );
}
