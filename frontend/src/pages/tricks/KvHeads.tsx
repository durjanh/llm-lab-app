import { useState } from 'react';

/** Multi-head, multi-query and grouped-query attention: how many key/value heads, and what that does to the KV cache. */

const MODELS = [
  { id: 'llama8b', name: 'Llama 3.1 8B', layers: 32, qHeads: 32, kvHeads: 8, headDim: 128 },
  { id: 'llama70b', name: 'Llama 3.1 70B', layers: 80, qHeads: 64, kvHeads: 8, headDim: 128 },
  { id: 'mistral7b', name: 'Mistral 7B', layers: 32, qHeads: 32, kvHeads: 8, headDim: 128 },
  { id: 'gpt2', name: 'GPT-2 small', layers: 12, qHeads: 12, kvHeads: 12, headDim: 64 },
];
const CONTEXTS = [1024, 8192, 32768, 131072];

const bytes = (b: number) =>
  b >= 2 ** 30 ? `${(b / 2 ** 30).toFixed(1)} GiB` : b >= 2 ** 20 ? `${(b / 2 ** 20).toFixed(1)} MiB` : `${(b / 2 ** 10).toFixed(0)} KiB`;

export default function KvHeads() {
  const [modelId, setModelId] = useState('llama8b');
  const model = MODELS.find((m) => m.id === modelId)!;
  const options = Array.from({ length: model.qHeads }, (_, i) => i + 1).filter((d) => model.qHeads % d === 0);
  const [kv, setKv] = useState(model.kvHeads);
  const [ctx, setCtx] = useState(131072);
  const kvHeads = options.includes(kv) ? kv : model.kvHeads;
  const perToken = 2 * model.layers * kvHeads * model.headDim * 2; // K and V, every layer, 16-bit
  const mha = 2 * model.layers * model.qHeads * model.headDim * 2;
  const kind = kvHeads === model.qHeads ? 'multi-head (MHA)' : kvHeads === 1 ? 'multi-query (MQA)' : 'grouped-query (GQA)';
  const group = model.qHeads / kvHeads;

  // The picture: query heads coloured by the key/value head they share.
  const qs = model.qHeads;
  const w = 640;
  const qx = (i: number) => 10 + (i + 0.5) * ((w - 20) / qs);
  const kx = (j: number) => 10 + (j + 0.5) * ((w - 20) / kvHeads);
  const colours = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--brand)'];

  return (
    <section className="tr-section">
      <h2>3. Multi-head, multi-query and grouped-query attention</h2>
      <p>
        While generating, a model keeps every earlier token's keys and values in a <b>KV cache</b>, so it does not recompute them.
        With one key/value head per query head (<b>multi-head</b>), that cache is huge at long contexts. <b>Multi-query</b>{' '}
        attention shares one key/value head across all query heads; <b>grouped-query</b> attention (GQA) shares one per group, a
        middle ground that keeps quality close to multi-head. Most current models use GQA.
      </p>
      <div className="tr-controls">
        <label>
          Model shape
          <select
            value={modelId}
            onChange={(e) => {
              setModelId(e.target.value);
              setKv(MODELS.find((m) => m.id === e.target.value)!.kvHeads);
            }}
          >
            {MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Key/value heads
          <select value={kvHeads} onChange={(e) => setKv(+e.target.value)}>
            {options.map((d) => (
              <option key={d} value={d}>
                {d}
                {d === model.kvHeads ? ' (as published)' : ''}
              </option>
            ))}
          </select>
        </label>
        <label>
          Context
          <select value={ctx} onChange={(e) => setCtx(+e.target.value)}>
            {CONTEXTS.map((c) => (
              <option key={c} value={c}>
                {c.toLocaleString('en-GB')} tokens
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="card">
        <svg viewBox={`0 0 ${w} 120`} className="tr-heads" role="img" aria-label={`${qs} query heads sharing ${kvHeads} key/value heads`}>
          {Array.from({ length: qs }, (_, i) => {
            const j = Math.floor(i / group);
            return <line key={`l${i}`} x1={qx(i)} y1={30} x2={kx(j)} y2={88} className="tr-link" style={{ stroke: colours[j % colours.length] }} />;
          })}
          {Array.from({ length: qs }, (_, i) => (
            <rect key={`q${i}`} x={qx(i) - Math.min(8, (w - 20) / qs / 2 - 1)} y={14} width={Math.min(16, (w - 20) / qs - 2)} height={16} rx={2}
              style={{ fill: colours[Math.floor(i / group) % colours.length] }} className="tr-head" />
          ))}
          {Array.from({ length: kvHeads }, (_, j) => (
            <rect key={`k${j}`} x={kx(j) - Math.min(14, (w - 20) / kvHeads / 2 - 2)} y={88} width={Math.min(28, (w - 20) / kvHeads - 4)} height={20} rx={3}
              style={{ fill: colours[j % colours.length] }} className="tr-head" />
          ))}
          <text x={10} y={10} className="tr-svg-label">{qs} query heads</text>
          <text x={10} y={119} className="tr-svg-label">{kvHeads} key/value heads: {kind}</text>
        </svg>
        <div className="table-wrap">
          <table className="t">
            <tbody>
              <tr>
                <td>KV cache per token</td>
                <td className="num">
                  <b>{bytes(perToken)}</b> <span className="tr-note">2 (K, V) × {model.layers} layers × {kvHeads} heads × {model.headDim} × 2 bytes</span>
                </td>
              </tr>
              <tr>
                <td>KV cache for {ctx.toLocaleString('en-GB')} tokens</td>
                <td className="num">
                  <b>{bytes(perToken * ctx)}</b>
                </td>
              </tr>
              <tr>
                <td>The same with full multi-head attention</td>
                <td className="num">
                  {bytes(mha * ctx)} {kvHeads < model.qHeads && <span className="tr-note">({(mha / perToken).toFixed(0)}× more)</span>}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="tr-note">
          Shapes from the published model configurations (16-bit cache, one sequence). An 80 GB GPU that holds an 8B model's 16 GB
          of weights has the rest for cache: that is what limits how many users and how long a context it can serve. DeepSeek's
          models go further with multi-head latent attention, which stores a compressed version of the keys and values.
        </p>
      </div>
    </section>
  );
}
