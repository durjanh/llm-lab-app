import { useState } from 'react';

/** Sliding-window attention: each token attends only to the last W tokens, plus optional global tokens. */

const N = 16;

export default function SlidingWindow() {
  const [window, setWindow] = useState(4);
  const [globals, setGlobals] = useState(0);
  const [layers, setLayers] = useState(32);
  const [realWindow, setRealWindow] = useState(4096);
  const allowed = (i: number, j: number) => j <= i && (i - j < window || j < globals);
  const full = (N * (N + 1)) / 2;
  let used = 0;
  for (let i = 0; i < N; i++) for (let j = 0; j <= i; j++) if (allowed(i, j)) used++;
  const reach = layers * (realWindow - 1) + 1;

  return (
    <section className="tr-section">
      <h2>4. Sliding-window attention</h2>
      <p>
        Full causal attention lets every token look at every earlier token, so the work grows with the square of the length.{' '}
        <b>Sliding-window</b> attention lets each token look only at the last <i>W</i> tokens, so work and KV cache grow only with
        the length. Information still travels further: each layer passes it on another <i>W</i> tokens. Some designs add a few{' '}
        <b>global</b> tokens that every token can see, and models such as Gemma 2 alternate sliding-window layers with full ones.
      </p>
      <div className="tr-controls">
        <label>
          Window W <input type="range" min={1} max={N} value={window} onChange={(e) => setWindow(+e.target.value)} /> <b className="mono">{window}</b>
        </label>
        <label>
          Global tokens <input type="range" min={0} max={2} value={globals} onChange={(e) => setGlobals(+e.target.value)} /> <b className="mono">{globals}</b>
        </label>
      </div>
      <div className="tr-two">
        <div className="card">
          <div className="tr-mask" style={{ gridTemplateColumns: `repeat(${N}, 1fr)` }} role="img" aria-label={`Attention mask, ${N} tokens, window ${window}`}>
            {Array.from({ length: N * N }, (_, k) => {
              const i = Math.floor(k / N);
              const j = k % N;
              const on = allowed(i, j);
              const causal = j <= i;
              return <span key={k} className={on ? (j < globals && i - j >= window ? 'g' : 'on') : causal ? 'cut' : ''} />;
            })}
          </div>
          <p className="tr-note">Rows: the token doing the looking. Columns: the tokens it can see. Faint cells are what full causal attention would add.</p>
        </div>
        <div className="card">
          <table className="t">
            <tbody>
              <tr>
                <td>Scores computed, {N} tokens</td>
                <td className="num">
                  <b>{used}</b> of {full} ({Math.round((100 * used) / full)}%)
                </td>
              </tr>
              <tr>
                <td>At 32,768 tokens, window 4,096</td>
                <td className="num">about {Math.round((100 * (4096 * 32768 - (4096 * 4095) / 2)) / ((32768 * 32769) / 2))}% of full attention</td>
              </tr>
            </tbody>
          </table>
          <p className="small">
            <b>How far information can reach.</b> With a real window of{' '}
            <select value={realWindow} onChange={(e) => setRealWindow(+e.target.value)}>
              {[1024, 4096, 8192].map((w) => (
                <option key={w} value={w}>
                  {w.toLocaleString('en-GB')}
                </option>
              ))}
            </select>{' '}
            tokens and{' '}
            <input type="range" min={1} max={64} value={layers} onChange={(e) => setLayers(+e.target.value)} aria-label="Layers" /> {layers} layers, a token
            can be influenced by text up to <b>{reach.toLocaleString('en-GB')}</b> tokens back: each layer hands information on
            another window. (Mistral 7B's first version: a 4,096 window and 32 layers, about 131,000 tokens.)
          </p>
        </div>
      </div>
    </section>
  );
}
