import { useState } from 'react';
import { Plot } from '../deep-learning/Plot';

/**
 * Why generating text is limited by memory speed. Every new token needs every weight read once, so for one user
 * tokens per second can be no higher than memory bandwidth divided by the model's size in bytes. Reading the
 * prompt, and serving many users at once, is limited by compute instead.
 */

interface Chip {
  id: string;
  name: string;
  kind: string;
  bandwidthGBs: number; // memory bandwidth, GB/s
  memoryGB: number; // memory that can hold weights, per chip
  tflops: number; // peak dense 16-bit (or the chip's main AI format) TFLOPS
  note: string;
  cluster: boolean; // data-centre chips are linked to hold big models; a laptop or phone is not
}

// Vendor-published peak figures, rounded. Real systems reach a fraction of these.
const CHIPS: Chip[] = [
  { id: 'cpu', name: 'Desktop CPU', kind: 'CPU', bandwidthGBs: 90, memoryGB: 64, tflops: 2, note: 'dual-channel DDR5', cluster: false },
  { id: 'npu', name: 'Phone NPU', kind: 'NPU', bandwidthGBs: 77, memoryGB: 12, tflops: 45, note: 'LPDDR5X shared memory; INT8 TOPS', cluster: false },
  { id: 'm4', name: 'Apple M4 Max', kind: 'GPU', bandwidthGBs: 546, memoryGB: 128, tflops: 18, note: 'unified memory', cluster: false },
  { id: 'tpu', name: 'Google TPU v5e', kind: 'TPU', bandwidthGBs: 819, memoryGB: 16, tflops: 197, note: 'HBM2, BF16', cluster: true },
  { id: 'h100', name: 'NVIDIA H100 SXM', kind: 'GPU', bandwidthGBs: 3350, memoryGB: 80, tflops: 989, note: 'HBM3, dense BF16', cluster: true },
  { id: 'b200', name: 'NVIDIA B200', kind: 'GPU', bandwidthGBs: 8000, memoryGB: 192, tflops: 2250, note: 'HBM3e, dense BF16', cluster: true },
  { id: 'lpu', name: 'Groq LPU', kind: 'LPU', bandwidthGBs: 80000, memoryGB: 0.23, tflops: 188, note: 'on-chip SRAM, FP16', cluster: true },
];

const MODELS = [
  { label: '1B (on-device class)', params: 1 },
  { label: '8B (small open model)', params: 8 },
  { label: '70B (large open model)', params: 70 },
  { label: '405B (frontier-size open model)', params: 405 },
];
const PRECISIONS = [
  { label: '16-bit (FP16 / BF16)', bytes: 2 },
  { label: '8-bit (FP8 / INT8)', bytes: 1 },
  { label: '4-bit (INT4)', bytes: 0.5 },
];

const fmt = (v: number) => (v >= 1e5 ? `${(v / 1000).toFixed(0)}k` : v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v >= 10 ? v.toFixed(0) : v.toFixed(1));

export default function Bandwidth() {
  const [params, setParams] = useState(70);
  const [bytes, setBytes] = useState(2);
  const [chipId, setChipId] = useState('h100');
  const weightsGB = params * bytes; // billions of parameters × bytes each = GB

  const rows = CHIPS.map((c) => {
    const chips = Math.max(1, Math.ceil(weightsGB / c.memoryGB));
    const fits = c.cluster || chips === 1;
    // One user's next token needs every weight read, in layer order. With layers split across chips (pipeline
    // parallel) each chip reads its share in turn, so the bound is one chip's memory speed over the whole model.
    // Tensor parallelism, where every chip reads its slice of each layer at once, would raise it; this table leaves it out.
    const decode = fits ? c.bandwidthGBs / weightsGB : 0;
    // A prompt's tokens go through together, so its maths can be split across every chip.
    const prefill = fits ? (chips * c.tflops * 1e12) / (2 * params * 1e9) : 0;
    const ridge = (c.tflops * 1e12 * bytes) / (2 * c.bandwidthGBs * 1e9); // users at which compute becomes the limit
    return { ...c, chips, fits, decode, prefill, ridge };
  });
  const chip = rows.find((r) => r.id === chipId && r.fits) ?? rows.find((r) => r.id === 'h100')!;
  const maxDecode = Math.max(...rows.map((r) => r.decode), 1);

  // Throughput against batch size for the chosen chip: memory-bound until the ridge, then compute-bound.
  const batches = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024];
  const total = (b: number) => Math.min(b * chip.decode, chip.prefill);

  return (
    <section className="hw-section">
      <h2>Why generating text is limited by memory speed (and why LPUs are fast)</h2>
      <p>
        To produce each new token, the chip must read <b>every weight of the model once</b>. The sums for that token are quick;
        fetching billions of numbers from memory is the slow part. So for one user, tokens per second can be no higher than{' '}
        <b>memory bandwidth ÷ model size in bytes</b>. Reading your prompt is different: all its tokens go through together, so
        that part is limited by compute.
      </p>
      <div className="hw-controls">
        <label>
          Model
          <select value={params} onChange={(e) => setParams(+e.target.value)}>
            {MODELS.map((m) => (
              <option key={m.params} value={m.params}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Weights stored as
          <select value={bytes} onChange={(e) => setBytes(+e.target.value)}>
            {PRECISIONS.map((p) => (
              <option key={p.bytes} value={p.bytes}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <span className="small">
          Weights: <b>{weightsGB >= 1 ? `${weightsGB.toFixed(weightsGB < 10 ? 1 : 0)} GB` : `${(weightsGB * 1000).toFixed(0)} MB`}</b>
        </span>
      </div>

      <div className="table-wrap">
        <table className="t hw-bw">
          <thead>
            <tr>
              <th>Chip</th>
              <th className="num">Memory speed</th>
              <th className="num">Chips to hold the weights</th>
              <th>Fastest generation for one user</th>
              <th className="num">Prompt reading</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={r.id === chip.id ? 'hw-picked' : ''} onClick={() => r.fits && setChipId(r.id)}>
                <td>
                  <b>{r.name}</b> <span className="hw-note">{r.kind} · {r.note}</span>
                </td>
                <td className="num">{r.bandwidthGBs >= 1000 ? `${r.bandwidthGBs / 1000} TB/s` : `${r.bandwidthGBs} GB/s`}</td>
                <td className="num">
                  {r.fits ? r.chips.toLocaleString('en-GB') : <span className="hw-bad">does not fit</span>}
                  {r.fits && r.chips > 1 && <span className="hw-note"> ({r.memoryGB < 1 ? `${r.memoryGB * 1000} MB` : `${r.memoryGB} GB`} each)</span>}
                  {!r.fits && <span className="hw-note"> ({r.memoryGB} GB)</span>}
                </td>
                <td>
                  {r.fits ? (
                    <div className="hw-bar">
                      <i style={{ width: `${Math.max(1, (Math.log10(r.decode + 1) / Math.log10(maxDecode + 1)) * 100)}%` }} />
                      <span>{fmt(r.decode)} tokens/s</span>
                    </div>
                  ) : (
                    <span className="hw-note">try 4-bit or a smaller model</span>
                  )}
                </td>
                <td className="num">{r.fits ? `${fmt(r.prefill)} tokens/s` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="hw-note">
        Upper bounds from vendor peak figures. Generation: one chip's memory speed ÷ the model's size, since a user's next
        token needs every weight, layer after layer. That holds when the layers are split across chips. Splitting each layer
        across chips instead (tensor parallelism) lets every chip read its slice at once, so their combined speed raises the
        limit, minus the time spent combining results between chips. Prompt reading: peak compute across all the chips, at 2 operations per
        parameter per token. Real systems reach perhaps 50–80% of bandwidth and less of compute; the KV cache and activations
        are left out. Bars use a log scale. Click a row to choose it below.
      </p>

      <div className="hw-takeaways">
        <div className="card">
          <b>What the table shows</b>
          <ul className="small">
            <li>
              <b>Halving the bytes doubles the speed.</b> Switch 16-bit to 4-bit: generation gets four times faster on every chip,
              because there is a quarter as much to read. That is the main reason quantised models are quick.
            </li>
            <li>
              <b>The LPU's trick is memory, not maths.</b> On-chip SRAM is about 24 times faster than an H100's HBM, so one user
              gets about 24 times the tokens per second. But it holds only 230 MB per chip, so a {params}B model at this precision
              needs about {rows.find((r) => r.id === 'lpu')!.chips.toLocaleString('en-GB')} chips working together.
            </li>
            <li>
              <b>Prompts are cheap, outputs are dear.</b> Reading the prompt is far faster than generating, which is why
              providers charge several times more per output token than per input token.
            </li>
          </ul>
        </div>
        <div className="card">
          <b>Serving many users at once: {chip.name}</b>
          <Plot
            x={[0, Math.log2(1024)]}
            y={[0, Math.log10(Math.max(...batches.map(total)) * 2)]}
            height={210}
            xLabel="users at once (log₂)"
            yLabel="total tokens/s (log₁₀)"
            ariaLabel={`Total tokens per second against the number of users on ${chip.name}`}
            draw={(f) => {
              const xs = batches.map((b) => Math.log2(b));
              f.line(xs, batches.map((b) => Math.log10(b * chip.decode)), f.c.muted, 1.5, [4, 4]);
              f.line(xs, batches.map(() => Math.log10(chip.prefill)), f.c.muted, 1.5, [4, 4]);
              f.line(xs, batches.map((b) => Math.log10(total(b))), f.c.brand, 3);
              if (chip.ridge >= 1 && chip.ridge <= 1024) f.vline(Math.log2(chip.ridge), f.c.s2);
            }}
          />
          <p className="small">
            One user cannot keep the chip's compute busy: it waits on memory. But the weights read for one user's token can be used
            for many users' tokens in the same pass, so total throughput rises with the number of users until compute runs out,
            at about <b>{chip.ridge >= 1 ? `${fmt(chip.ridge)} users` : 'one user'}</b> here (the orange line). This is why
            GPU serving batches requests, and why per-user speed and total throughput are different numbers.
          </p>
        </div>
      </div>
    </section>
  );
}
