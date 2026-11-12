import { useMemo, useState } from 'react';
import { rng } from '../deep-learning/kit';

/**
 * PagedAttention: a server does not know how long a reply will be. Reserving one contiguous KV-cache region per request
 * for the longest possible reply wastes most of it. Paging allocates small fixed blocks as tokens arrive, like virtual
 * memory, so only the last block of each request is partly empty. Simulated with seeded random lengths.
 */

const GPU_TOKENS = 32_768; // KV-cache room, in tokens, for this demo

export default function Paged() {
  const [maxLen, setMaxLen] = useState(2048);
  const [block, setBlock] = useState(16);
  const [seed, setSeed] = useState(5);
  const lens = useMemo(() => {
    const r = rng(seed);
    return Array.from({ length: 64 }, () => 60 + Math.floor(r() ** 1.6 * (maxLen - 60)));
  }, [seed, maxLen]);

  // Contiguous: every request reserves maxLen tokens. Paged: ceil(len / block) blocks.
  const fitContiguous = Math.floor(GPU_TOKENS / maxLen);
  let used = 0;
  let fitPaged = 0;
  for (const len of lens) {
    const need = Math.ceil(len / block) * block;
    if (used + need > GPU_TOKENS) break;
    used += need;
    fitPaged++;
  }
  const shown = lens.slice(0, 6);
  const wasteContig = Math.round(100 * (1 - shown.reduce((a, b) => a + b, 0) / (shown.length * maxLen)));
  const wastePaged = Math.round(
    100 * (1 - shown.reduce((a, b) => a + b, 0) / shown.reduce((a, b) => a + Math.ceil(b / block) * block, 0)),
  );

  return (
    <section className="tr-section">
      <h2>9. PagedAttention: KV-cache memory in pages</h2>
      <p>
        Every request’s KV cache grows a token at a time, and the server cannot know how long the reply will be.
        Reserving one contiguous region for the longest possible reply leaves most of it empty. <b>PagedAttention</b>,
        from vLLM, borrows the idea of virtual memory: the cache is split into small fixed-size blocks, handed out as
        tokens arrive and found through a block table, so only each request’s last block is partly empty. More requests
        fit on the same GPU, which means bigger batches and more throughput.
      </p>
      <div className="tr-controls">
        <label>
          Longest reply allowed{' '}
          <select value={maxLen} onChange={(e) => setMaxLen(+e.target.value)}>
            {[1024, 2048, 4096].map((n) => (
              <option key={n} value={n}>
                {n.toLocaleString('en-GB')} tokens
              </option>
            ))}
          </select>
        </label>
        <label>
          Block size{' '}
          <select value={block} onChange={(e) => setBlock(+e.target.value)}>
            {[8, 16, 32, 128].map((n) => (
              <option key={n} value={n}>
                {n} tokens
              </option>
            ))}
          </select>
        </label>
        <button className="btn small" onClick={() => setSeed((s) => s + 1)}>
          New requests
        </button>
      </div>
      <div className="tr-two">
        <div className="card">
          <b>Reserved per request</b>
          {shown.map((len, i) => (
            <div key={i} className="tr-page-row">
              <span className="tr-page-bar" title={`${len} used of ${maxLen} reserved`}>
                <i className="used" style={{ width: `${(100 * len) / maxLen}%` }} />
              </span>
              <span className="small mono">{len}</span>
            </div>
          ))}
          <p className="tr-note">
            Dark: tokens used. Light: reserved but empty. {wasteContig}% of this memory is wasted.
          </p>
        </div>
        <div className="card">
          <b>Paged ({block}-token blocks)</b>
          {shown.map((len, i) => {
            const blocks = Math.ceil(len / block);
            const shownBlocks = Math.min(blocks, 64);
            return (
              <div key={i} className="tr-page-row">
                <span className="tr-blocks">
                  {Array.from({ length: shownBlocks }, (_, b) => (
                    <i key={b} className={b === blocks - 1 && len % block ? 'part' : 'full'} />
                  ))}
                  {blocks > 64 && <span className="small muted"> +{blocks - 64}</span>}
                </span>
                <span className="small mono">{blocks}</span>
              </div>
            );
          })}
          <p className="tr-note">
            Each square is one block; only the last one per request can be partly empty. {wastePaged}% wasted.
          </p>
        </div>
      </div>
      <div className="table-wrap">
        <table className="t">
          <tbody>
            <tr>
              <td>Requests that fit in {GPU_TOKENS.toLocaleString('en-GB')} tokens of KV cache, reserving</td>
              <td className="num">
                <b>{fitContiguous}</b>
              </td>
            </tr>
            <tr>
              <td>The same, paged</td>
              <td className="num">
                <b>{fitPaged}</b>
                {fitPaged >= lens.length ? '+' : ''}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}
