import { useMemo, useState } from 'react';
import { gauss, rng, softmax } from '../deep-learning/kit';

/**
 * Mixture of Experts: a router scores every expert for each token and only the top k run. Simulated here with a seeded
 * random router over 1,000 random token vectors, so the load across experts is real arithmetic.
 */

const TOKENS = 1000;
const DIM = 16;

export default function Moe() {
  const [experts, setExperts] = useState(8);
  const [topK, setTopK] = useState(2);
  const [skew, setSkew] = useState(0);
  const [balance, setBalance] = useState(false);
  const [example, setExample] = useState(0);
  const k = Math.min(topK, experts);

  const sim = useMemo(() => {
    const r = rng(29);
    const router = Array.from({ length: experts }, () => Array.from({ length: DIM }, () => gauss(r) / Math.sqrt(DIM)));
    const tokens = Array.from({ length: TOKENS }, () => Array.from({ length: DIM }, () => gauss(r)));
    // A router that has drifted towards a few experts: those get a head start on every token.
    const bias = Array.from({ length: experts }, (_, e) => (e < 2 ? skew : 0));
    const logits = tokens.map((t) => router.map((w, e) => w.reduce((s, x, i) => s + x * t[i], 0) + bias[e]));
    const route = (adjust: number[]) => {
      const load = new Array(experts).fill(0);
      const picks = logits.map((row) => {
        const order = row.map((v, e) => [v + adjust[e], e]).sort((a, b) => b[0] - a[0]).slice(0, k).map((p) => p[1]);
        order.forEach((e) => load[e]++);
        return order;
      });
      return { load, picks };
    };
    // Bias-based balancing (as in DeepSeek-V3): nudge each expert's selection score down if it is over its fair
    // share and up if under, for a few rounds. Only the choice changes; the gate weights still come from the router.
    const adjust = new Array(experts).fill(0);
    if (balance) {
      for (let round = 0; round < 60; round++) {
        const { load } = route(adjust);
        const fair = (TOKENS * k) / experts;
        load.forEach((n, e) => (adjust[e] -= 0.05 * Math.sign(n - fair)));
      }
    }
    return { logits, ...route(adjust) };
  }, [experts, k, skew, balance]);

  const fair = (TOKENS * k) / experts;
  const maxLoad = Math.max(...sim.load);
  const token = sim.logits[example];
  const gate = softmax(token);
  const chosen = sim.picks[example];
  const chosenTotal = chosen.reduce((s, e) => s + gate[e], 0);

  return (
    <section className="tr-section">
      <h2>6. Mixture of Experts: a big model that runs like a small one</h2>
      <p>
        In a <b>Mixture of Experts</b> (MoE) layer, the single feed-forward network is replaced by many smaller ones, the{' '}
        <b>experts</b>, and a small <b>router</b> picks the best <i>k</i> of them for each token. The model holds all the experts'
        weights, but each token only runs through <i>k</i> of them: far more knowledge for the same compute per token.
      </p>
      <div className="tr-controls">
        <label>
          Experts
          <select value={experts} onChange={(e) => setExperts(+e.target.value)}>
            {[4, 8, 16, 32, 64].map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </select>
        </label>
        <label>
          Chosen per token (k)
          <select value={topK} onChange={(e) => setTopK(+e.target.value)}>
            {[1, 2, 4, 8].map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </select>
        </label>
        <label>
          Router favours experts 1 and 2 by <input type="range" min={0} max={3} step={0.25} value={skew} onChange={(e) => setSkew(+e.target.value)} /> <b className="mono">{skew}</b>
        </label>
        <label>
          <input type="checkbox" checked={balance} onChange={(e) => setBalance(e.target.checked)} /> balance the load
        </label>
      </div>
      <div className="tr-two">
        <div className="card">
          <b className="small">Tokens sent to each expert, out of {TOKENS.toLocaleString('en-GB')} tokens</b>
          <div className="tr-load">
            {sim.load.map((n, e) => (
              <div key={e} title={`Expert ${e + 1}: ${n} tokens`}>
                <i style={{ height: `${(n / Math.max(maxLoad, fair * 1.5)) * 100}%` }} className={n > fair * 1.5 ? 'hot' : ''} />
              </div>
            ))}
            <span className="tr-fair" style={{ bottom: `${(fair / Math.max(maxLoad, fair * 1.5)) * 100}%` }} />
          </div>
          <p className="small">
            Fair share {fair.toFixed(0)} tokens each (dashed line). Busiest expert: <b>{maxLoad}</b>, {(maxLoad / fair).toFixed(1)}×
            its share; quietest: {Math.min(...sim.load)}. Push the router towards experts 1 and 2 and they get overloaded while
            others sit idle: wasted capacity, and on real hardware the busiest expert sets the pace. Training adds a load-balancing
            loss, or (DeepSeek-V3) nudges each expert's selection score, which <i>balance the load</i> imitates.
          </p>
        </div>
        <div className="card">
          <b className="small">
            One token's routing{' '}
            <button className="btn small" onClick={() => setExample((x) => (x + 1) % TOKENS)}>
              Next token
            </button>
          </b>
          <div className="tr-gate">
            {gate.map((g, e) => (
              <div key={e} className={chosen.includes(e) ? 'on' : ''}>
                <span>E{e + 1}</span>
                <i style={{ width: `${g * 100}%` }} />
                <b className="mono">{(g * 100).toFixed(1)}%</b>
              </div>
            ))}
          </div>
          <p className="small">
            The router's softmax over all {experts} experts; the top {k} (highlighted) run, and their outputs are mixed using their
            weights rescaled to add up to 1 (here {chosen.map((e) => `E${e + 1} ${((gate[e] / chosenTotal) * 100).toFixed(0)}%`).join(', ')}).
            {balance && ' With balancing on, the choice uses the adjusted scores, so an expert with a smaller weight can be picked over a busier one; the mixing weights still come from the router.'}
          </p>
        </div>
      </div>
      <div className="table-wrap">
        <table className="t">
          <thead>
            <tr>
              <th>Model (published figures)</th>
              <th>Experts</th>
              <th className="num">Total parameters</th>
              <th className="num">Active per token</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Mixtral 8x7B</td>
              <td>8, top 2</td>
              <td className="num">46.7B</td>
              <td className="num">12.9B</td>
            </tr>
            <tr>
              <td>DeepSeek-V3</td>
              <td>256 routed (top 8) + 1 shared</td>
              <td className="num">671B</td>
              <td className="num">37B</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="tr-note">
        Memory has to hold the <b>total</b>; each token's compute and weight reading is set by the <b>active</b> parameters. So an
        MoE model generates about as fast as a dense model of its active size, but needs the memory of its full size (see Lab 26's
        bandwidth calculator).
      </p>
    </section>
  );
}
