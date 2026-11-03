import { useMemo, useState } from 'react';
import { gauss, rng } from '../deep-learning/kit';

/**
 * FlashAttention: the N × N score matrix is what runs out of memory, so compute attention in tiles that fit in fast
 * on-chip memory, using an online softmax that is exactly the ordinary softmax, block by block.
 */

const LENGTHS = [1024, 4096, 16384, 32768, 131072];
const fmtBytes = (b: number) => (b >= 2 ** 30 ? `${(b / 2 ** 30).toFixed(b >= 2 ** 33 ? 0 : 1)} GiB` : `${(b / 2 ** 20).toFixed(0)} MiB`);

export default function Flash() {
  const [n, setN] = useState(32768);
  const [block, setBlock] = useState(4);
  const [seed, setSeed] = useState(11);
  const [spike, setSpike] = useState(false);
  const { scores, values } = useMemo(() => {
    const r = rng(seed);
    const s = Array.from({ length: 12 }, () => +(gauss(r) * 2).toFixed(2));
    if (spike) s[7] = 60; // large enough that exp() of it overflows a naive sum in 16-bit
    return { scores: s, values: Array.from({ length: 12 }, () => +(gauss(r) * 3).toFixed(2)) };
  }, [seed, spike]);

  // The ordinary way: subtract the max, exponentiate everything, normalise.
  const m0 = Math.max(...scores);
  const e = scores.map((s) => Math.exp(s - m0));
  const total = e.reduce((a, b) => a + b, 0);
  const weights = e.map((x) => x / total);
  const direct = weights.reduce((a, w, i) => a + w * values[i], 0);

  // The online way: one block at a time, keeping a running max m, running sum l and running output o.
  const steps: { from: number; to: number; blockMax: number; m: number; l: number; out: number }[] = [];
  let m = -Infinity;
  let l = 0;
  let o = 0;
  for (let start = 0; start < scores.length; start += block) {
    const s = scores.slice(start, start + block);
    const v = values.slice(start, start + block);
    const mNew = Math.max(m, ...s);
    const scale = Math.exp(m - mNew); // rescale what was summed before, now that the max may have grown
    l = l * scale + s.reduce((a, x) => a + Math.exp(x - mNew), 0);
    o = o * scale + s.reduce((a, x, i) => a + Math.exp(x - mNew) * v[i], 0);
    m = mNew;
    steps.push({ from: start + 1, to: Math.min(start + block, scores.length), blockMax: Math.max(...s), m, l, out: o / l });
  }
  const online = o / l;
  const onlineWeights = scores.map((s) => Math.exp(s - m) / l);
  const maxWeightDiff = Math.max(...onlineWeights.map((w, i) => Math.abs(w - weights[i])));

  return (
    <section className="tr-section">
      <h2>5. FlashAttention: the same answer, without the giant matrix</h2>
      <p>
        Attention compares every token with every other, so it builds an <b>N × N</b> table of scores. Kept in the GPU's main
        memory (HBM), that table is huge and slow to write and read back:
      </p>
      <div className="tr-controls">
        <label>
          Sequence length
          <select value={n} onChange={(e) => setN(+e.target.value)}>
            {LENGTHS.map((x) => (
              <option key={x} value={x}>
                {x.toLocaleString('en-GB')} tokens
              </option>
            ))}
          </select>
        </label>
        <span className="small">
          Score table, one head of one layer, 16-bit: <b>{fmtBytes(n * n * 2)}</b>; for 32 heads: <b>{fmtBytes(n * n * 2 * 32)}</b>
        </span>
      </div>
      <p>
        <b>FlashAttention</b> never builds the table. It splits the queries, keys and values into tiles small enough for the fast
        memory next to the compute cores (a few hundred kilobytes per core cluster on an H100, against 80 GB of HBM), computes each
        tile's scores there, and keeps only running totals. The trick that makes this possible is the <b>online softmax</b>: a
        softmax computed block by block, which comes out <i>exactly</i> the same as the ordinary one. It is not an approximation;
        it is the same maths in a better order.
      </p>
      <div className="tr-controls">
        <label>
          Block size <input type="range" min={1} max={12} value={block} onChange={(e) => setBlock(+e.target.value)} /> <b className="mono">{block}</b>
        </label>
        <label>
          <input type="checkbox" checked={spike} onChange={(e) => setSpike(e.target.checked)} /> one very large score (60)
        </label>
        <button className="btn small" onClick={() => setSeed((s) => s + 1)}>
          New scores
        </button>
      </div>
      <div className="tr-two">
        <div className="card">
          <b className="small">12 scores and their values</b>
          <div className="tr-scores mono small">
            {scores.map((s, i) => (
              <span key={i} className={Math.floor(i / block) % 2 ? 'b1' : 'b0'}>
                {s}
                <i>v {values[i]}</i>
              </span>
            ))}
          </div>
          <div className="table-wrap">
            <table className="t tr-steps">
              <thead>
                <tr>
                  <th>Block</th>
                  <th className="num">Block max</th>
                  <th className="num">Running max m</th>
                  <th className="num">Running sum l</th>
                  <th className="num">Output so far</th>
                </tr>
              </thead>
              <tbody>
                {steps.map((s) => (
                  <tr key={s.from}>
                    <td>
                      {s.from}–{s.to}
                    </td>
                    <td className="num">{s.blockMax}</td>
                    <td className="num">{s.m}</td>
                    <td className="num">{s.l.toFixed(4)}</td>
                    <td className="num">{s.out.toFixed(4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="card">
          <table className="t">
            <tbody>
              <tr>
                <td>Ordinary softmax, then weighted sum</td>
                <td className="num">
                  <b>{direct.toFixed(10)}</b>
                </td>
              </tr>
              <tr>
                <td>Online, block by block</td>
                <td className="num">
                  <b>{online.toFixed(10)}</b>
                </td>
              </tr>
              <tr>
                <td>Difference</td>
                <td className="num">{Math.abs(direct - online).toExponential(1)}</td>
              </tr>
              <tr>
                <td>Largest difference in any softmax weight</td>
                <td className="num">{maxWeightDiff.toExponential(1)}</td>
              </tr>
            </tbody>
          </table>
          <p className="small">
            When a new block raises the maximum, everything summed so far is multiplied by e<sup>(old max − new max)</sup>, so it
            is as if the new maximum had been used from the start. Subtracting the maximum also keeps the exponentials from
            overflowing: tick <i>one very large score</i> and both still agree.
          </p>
        </div>
      </div>
    </section>
  );
}
