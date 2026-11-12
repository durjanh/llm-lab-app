import { useMemo, useState } from 'react';
import { rng } from '../deep-learning/kit';

/**
 * Continuous batching: a GPU generates one token for every request in its batch per step. With static batching a batch
 * starts together and every slot waits for the longest reply before the next batch starts. With continuous batching a
 * slot is refilled the moment its request finishes. Simulated with seeded random reply lengths.
 */

interface Cell {
  req: number;
}
interface Run {
  grid: (Cell | null)[][]; // [slot][step]
  steps: number;
  busy: number;
  finish: number[]; // step each request finishes
}

function lengths(n: number, varied: boolean, seed: number): number[] {
  const r = rng(seed);
  return Array.from({ length: n }, () => (varied ? 4 + Math.floor(r() ** 2 * 44) : 18 + Math.floor(r() * 8)));
}

function staticRun(lens: number[], slots: number): Run {
  const grid: (Cell | null)[][] = Array.from({ length: slots }, () => []);
  const finish: number[] = [];
  let t = 0;
  for (let b = 0; b < lens.length; b += slots) {
    const batch = lens.slice(b, b + slots);
    const longest = Math.max(...batch);
    for (let s = 0; s < slots; s++) {
      for (let k = 0; k < longest; k++) grid[s][t + k] = k < (batch[s] ?? 0) ? { req: b + s } : null;
      if (batch[s] !== undefined) finish[b + s] = t + batch[s];
    }
    t += longest;
  }
  return { grid, steps: t, busy: lens.reduce((a, b) => a + b, 0), finish };
}

function continuousRun(lens: number[], slots: number): Run {
  const grid: (Cell | null)[][] = Array.from({ length: slots }, () => []);
  const freeAt = Array(slots).fill(0);
  const finish: number[] = [];
  lens.forEach((len, req) => {
    const s = freeAt.indexOf(Math.min(...freeAt)); // the slot that frees up first takes the next request
    for (let k = 0; k < len; k++) grid[s][freeAt[s] + k] = { req };
    finish[req] = freeAt[s] + len;
    freeAt[s] += len;
  });
  const steps = Math.max(...freeAt);
  for (const row of grid) for (let k = 0; k < steps; k++) row[k] ??= null;
  return { grid, steps, busy: lens.reduce((a, b) => a + b, 0), finish };
}

function Timeline({ run, slots, width, label }: { run: Run; slots: number; width: number; label: string }) {
  const cw = Math.max(1, Math.floor(width / Math.max(run.steps, 1)));
  const ch = 14;
  return (
    <svg className="tr-batch" viewBox={`0 0 ${run.steps * cw} ${slots * (ch + 3)}`} role="img" aria-label={label}>
      {run.grid.map((row, s) =>
        row.map((cell, k) =>
          cell ? (
            <rect
              key={`${s}-${k}`}
              x={k * cw}
              y={s * (ch + 3)}
              width={cw}
              height={ch}
              fill={`hsl(${(cell.req * 47) % 360} 60% 55%)`}
            />
          ) : (
            <rect key={`${s}-${k}`} x={k * cw} y={s * (ch + 3)} width={cw} height={ch} className="idle" />
          ),
        ),
      )}
    </svg>
  );
}

export default function Batching() {
  const [slots, setSlots] = useState(4);
  const [requests, setRequests] = useState(16);
  const [varied, setVaried] = useState(true);
  const [seed, setSeed] = useState(3);
  const lens = useMemo(() => lengths(requests, varied, seed), [requests, varied, seed]);
  const st = useMemo(() => staticRun(lens, slots), [lens, slots]);
  const ct = useMemo(() => continuousRun(lens, slots), [lens, slots]);
  const util = (r: Run) => Math.round((100 * r.busy) / (r.steps * slots));
  const avg = (r: Run) => Math.round(r.finish.reduce((a, b) => a + b, 0) / r.finish.length);

  return (
    <section className="tr-section">
      <h2>8. Continuous batching: refill a slot the moment it frees</h2>
      <p>
        A GPU is fastest when it generates the next token for many requests in one step. <b>Static batching</b> starts a
        batch together and keeps it until the <i>longest</i> reply is done, so slots whose reply ended early sit idle
        (grey). <b>Continuous batching</b> (also called in-flight or iteration-level batching) swaps a finished request
        out and the next one in at every step. It raises throughput and cuts waiting; it does not make one request’s
        tokens come faster.
      </p>
      <div className="tr-controls">
        <label>
          Batch slots <input type="range" min={2} max={8} value={slots} onChange={(e) => setSlots(+e.target.value)} />{' '}
          <b className="mono">{slots}</b>
        </label>
        <label>
          Requests{' '}
          <input
            type="range"
            min={8}
            max={32}
            step={4}
            value={requests}
            onChange={(e) => setRequests(+e.target.value)}
          />{' '}
          <b className="mono">{requests}</b>
        </label>
        <label>
          <input type="checkbox" checked={varied} onChange={(e) => setVaried(e.target.checked)} /> Reply lengths vary
          (as real ones do)
        </label>
        <button className="btn small" onClick={() => setSeed((s) => s + 1)}>
          New requests
        </button>
      </div>
      <div className="card">
        <div className="tr-batch-row">
          <b>Static</b>
          <span className="small muted">
            {st.steps} steps · {util(st)}% of slots busy · a request is done after {avg(st)} steps on average
          </span>
        </div>
        <Timeline run={st} slots={slots} width={680} label="Static batching timeline" />
        <div className="tr-batch-row">
          <b>Continuous</b>
          <span className="small muted">
            {ct.steps} steps · {util(ct)}% of slots busy · a request is done after {avg(ct)} steps on average
          </span>
        </div>
        <Timeline run={ct} slots={slots} width={680} label="Continuous batching timeline" />
        <p className="tr-note">
          Each row is a batch slot, each column one generation step, each colour one request. Same requests, same GPU:
          continuous batching finishes them all in{' '}
          <b>{Math.round((100 * (st.steps - ct.steps)) / st.steps)}% fewer steps</b> here. The gap grows when reply
          lengths vary more. Real servers (vLLM, TGI, TensorRT-LLM) also admit new requests while others are mid-reply.
        </p>
      </div>
    </section>
  );
}
