import { useState } from 'react';
import { gauss, rng } from '../deep-learning/kit';

/** LayerNorm and RMSNorm on a vector you can edit, and where the norm sits in a block (pre-norm vs post-norm). */

const EPS = 1e-5;
const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length;
const layerNorm = (v: number[]) => {
  const m = mean(v);
  const sd = Math.sqrt(mean(v.map((x) => (x - m) ** 2)) + EPS);
  return v.map((x) => (x - m) / sd);
};
const rmsNorm = (v: number[]) => {
  const rms = Math.sqrt(mean(v.map((x) => x * x)) + EPS);
  return v.map((x) => x / rms);
};

export default function Norms() {
  const [v, setV] = useState([2.0, -1.0, 0.5, 3.0, -2.5, 1.0]);
  const ln = layerNorm(v);
  const rms = rmsNorm(v);
  const big = Math.max(...[...v, ...ln, ...rms].map(Math.abs), 1);
  const bar = (x: number) => (
    <span className="tr-bar">
      <i className={x >= 0 ? 'pos' : 'neg'} style={{ width: `${(Math.abs(x) / big) * 50}%`, [x >= 0 ? 'left' : 'right']: '50%' }} />
      <span>{x.toFixed(2)}</span>
    </span>
  );

  return (
    <section className="tr-section">
      <h2>2. LayerNorm, RMSNorm, and where the norm goes</h2>
      <p>
        Every transformer block rescales each token's vector so the numbers stay in a healthy range as they pass through dozens
        of layers. <b>LayerNorm</b> subtracts the mean and divides by the standard deviation. <b>RMSNorm</b> skips the mean and
        divides by the root mean square: fewer operations, and in practice just as good, so Llama, Mistral and most recent models
        use it. (Both then multiply by learned weights, left at 1 here.)
      </p>
      <div className="tr-controls">
        <button className="btn small" onClick={() => setV(v.map((x) => +(x + 5).toFixed(2)))}>
          Add 5 to every number
        </button>
        <button className="btn small" onClick={() => setV(v.map((x) => +(x * 3).toFixed(2)))}>
          Multiply every number by 3
        </button>
        <button
          className="btn small"
          onClick={() => {
            const r = rng(Date.now() % 100000);
            setV(v.map(() => +(gauss(r) * 2).toFixed(2)));
          }}
        >
          Random numbers
        </button>
      </div>
      <div className="table-wrap">
        <table className="t tr-norms">
          <thead>
            <tr>
              <th>Input (edit it)</th>
              <th>LayerNorm</th>
              <th>RMSNorm</th>
            </tr>
          </thead>
          <tbody>
            {v.map((x, i) => (
              <tr key={i}>
                <td>
                  <input type="number" step="0.5" value={x} aria-label={`Input ${i + 1}`} onChange={(e) => setV(v.map((y, j) => (j === i ? +e.target.value : y)))} />
                </td>
                <td>{bar(ln[i])}</td>
                <td>{bar(rms[i])}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small">
        Mean of the input <b className="mono">{mean(v).toFixed(2)}</b>; LayerNorm output mean <b className="mono">{Math.abs(mean(ln)) < 1e-9 ? '0.00' : mean(ln).toFixed(2)}</b>,
        RMSNorm output mean <b className="mono">{mean(rms).toFixed(2)}</b>. Press <i>Add 5</i>: LayerNorm's output does not move
        (it removes any shift), RMSNorm's does. Press <i>Multiply by 3</i>: neither moves (both remove scale).
      </p>
      <div className="tr-two">
        <div className="card">
          <b>Post-norm (the 2017 original)</b>
          <pre className="tr-code">x = Norm(x + Attention(x)){'\n'}x = Norm(x + MLP(x))</pre>
          <p className="small">The norm sits on the main path, after each addition. Deep stacks of these are hard to train without a careful learning-rate warm-up.</p>
        </div>
        <div className="card">
          <b>Pre-norm (GPT-2 onwards, Llama, Mistral)</b>
          <pre className="tr-code">x = x + Attention(Norm(x)){'\n'}x = x + MLP(Norm(x))</pre>
          <p className="small">The norm only feeds each sub-layer; the main path is a clean running sum. Gradients flow straight back through it, so very deep models train stably.</p>
        </div>
      </div>
    </section>
  );
}
