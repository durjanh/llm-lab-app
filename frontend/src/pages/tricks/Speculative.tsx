import { useMemo, useState } from 'react';
import { Plot } from '../deep-learning/Plot';
import { rng } from '../deep-learning/kit';

/**
 * Speculative decoding: a small draft model guesses k tokens, the big model checks all k in one pass and keeps the
 * longest correct run. The expected tokens per big-model pass is (1 − α^(k+1)) / (1 − α) for acceptance rate α.
 */

const expectedTokens = (a: number, k: number) => (a >= 1 ? k + 1 : (1 - a ** (k + 1)) / (1 - a));
// Time per pass: k draft steps at cost c each (relative to one big-model step), then one big-model pass.
const speedUp = (a: number, k: number, c: number) => expectedTokens(a, k) / (k * c + 1);

type Chip = { kind: 'ok' | 'fix' | 'bonus'; pass: number };

// The acceptance rule that keeps the big model's distribution exactly: accept a draft token x with probability
// min(1, p(x) / q(x)); if rejected, sample from max(0, p − q), renormalised.
const P = [0.4, 0.25, 0.15, 0.12, 0.08]; // the big model's next-token probabilities
const Q = [0.2, 0.4, 0.2, 0.1, 0.1]; // the draft model's
function check(samples: number, seed: number) {
  const r = rng(seed);
  const pick = (dist: number[]) => {
    let u = r();
    for (let i = 0; i < dist.length; i++) if ((u -= dist[i]) <= 0) return i;
    return dist.length - 1;
  };
  const residual = P.map((p, i) => Math.max(0, p - Q[i]));
  const rs = residual.reduce((a, b) => a + b, 0);
  const counts = new Array(P.length).fill(0);
  let accepted = 0;
  for (let n = 0; n < samples; n++) {
    const x = pick(Q);
    if (r() < Math.min(1, P[x] / Q[x])) {
      counts[x]++;
      accepted++;
    } else counts[pick(residual.map((v) => v / rs))]++;
  }
  return { freq: counts.map((c) => c / samples), acceptance: accepted / samples };
}

export default function Speculative() {
  const [alpha, setAlpha] = useState(0.8);
  const [k, setK] = useState(4);
  const [cost, setCost] = useState(0.05);
  const [chips, setChips] = useState<Chip[]>([]);
  const [passes, setPasses] = useState(0);
  const [seed, setSeed] = useState(1);
  const dist = useMemo(() => check(40000, 5), []);

  function run(n: number) {
    const r = rng(seed * 7919 + passes);
    const next = [...chips];
    for (let p = 0; p < n; p++) {
      let accepted = 0;
      while (accepted < k && r() < alpha) accepted++;
      for (let i = 0; i < accepted; i++) next.push({ kind: 'ok', pass: passes + p + 1 });
      next.push({ kind: accepted === k ? 'bonus' : 'fix', pass: passes + p + 1 }); // the big model always adds one token
    }
    setChips(next);
    setPasses(passes + n);
  }

  const ks = Array.from({ length: 10 }, (_, i) => i + 1);
  const alphas = [0.6, 0.8, 0.9];
  const colours = ['var(--s2)', 'var(--s1)', 'var(--s3)'];

  return (
    <section className="tr-section">
      <h2>7. Speculative decoding: guess cheaply, check in one go</h2>
      <p>
        Generating is limited by reading the big model's weights once per token (Lab 26). <b>Speculative decoding</b> lets a small,
        fast <b>draft</b> model guess the next <i>k</i> tokens; the big model then checks all <i>k</i> in a single pass, which costs
        about the same as producing one token. It keeps the guesses up to the first wrong one, and always adds one token of its
        own. If the draft is right a fraction <b>α</b> of the time, each big-model pass yields on average{' '}
        <b>(1 − α<sup>k+1</sup>) / (1 − α)</b> tokens.
      </p>
      <div className="tr-controls">
        <label>
          Draft accepted α <input type="range" min={0.3} max={0.95} step={0.05} value={alpha} onChange={(e) => setAlpha(+e.target.value)} /> <b className="mono">{alpha.toFixed(2)}</b>
        </label>
        <label>
          Guesses per pass k <input type="range" min={1} max={8} value={k} onChange={(e) => setK(+e.target.value)} /> <b className="mono">{k}</b>
        </label>
        <label>
          Draft step cost <input type="range" min={0.01} max={0.3} step={0.01} value={cost} onChange={(e) => setCost(+e.target.value)} /> <b className="mono">{cost.toFixed(2)}</b>
        </label>
      </div>
      <div className="tr-two">
        <div className="card">
          <table className="t">
            <tbody>
              <tr>
                <td>Tokens per big-model pass</td>
                <td className="num">
                  <b>{expectedTokens(alpha, k).toFixed(2)}</b>
                </td>
              </tr>
              <tr>
                <td>Speed-up, counting the draft's cost</td>
                <td className="num">
                  <b>{speedUp(alpha, k, cost).toFixed(2)}×</b>
                </td>
              </tr>
              <tr>
                <td>Simulated so far</td>
                <td className="num">
                  {passes ? `${chips.length} tokens in ${passes} passes = ${(chips.length / passes).toFixed(2)} per pass` : '—'}
                </td>
              </tr>
            </tbody>
          </table>
          <div className="row">
            <button className="btn small" onClick={() => run(1)}>
              One pass
            </button>
            <button className="btn small" onClick={() => run(50)}>
              50 passes
            </button>
            <button className="btn small" onClick={() => (setChips([]), setPasses(0), setSeed((s) => s + 1))}>
              Reset
            </button>
          </div>
          <div className="tr-chips" aria-label="Generated tokens: kept guesses, corrections and bonus tokens">
            {chips.slice(-120).map((c, i) => (
              <span key={i} className={`${c.kind} ${c.pass % 2 ? 'odd' : ''}`} />
            ))}
          </div>
          <div className="tr-legend small">
            <span>
              <i className="ok" /> draft guess kept
            </span>
            <span>
              <i className="fix" /> big model's correction
            </span>
            <span>
              <i className="bonus" /> bonus token (all {k} guesses right)
            </span>
          </div>
        </div>
        <div className="card">
          <Plot
            x={[1, 10]}
            y={[0, Math.max(...alphas.map((a) => Math.max(...ks.map((kk) => speedUp(a, kk, cost))))) * 1.12]}
            height={210}
            xLabel="guesses per pass k"
            yLabel="speed-up"
            ariaLabel="Speed-up against guesses per pass for three acceptance rates"
            draw={(f) => {
              alphas.forEach((a, i) => f.line(ks, ks.map((kk) => speedUp(a, kk, cost)), [f.c.s2, f.c.s1, f.c.s3][i], 2.5));
              f.hline(1, f.c.muted);
              f.dots([[k, speedUp(alpha, k, cost)]], f.c.brand, 5);
            }}
          />
          <div className="tr-legend small">
            {alphas.map((a, i) => (
              <span key={a}>
                <i style={{ background: colours[i] }} /> α = {a}
              </span>
            ))}
          </div>
          <p className="small">More guesses help only while they are likely to be right; past a point, the draft's own cost wins.</p>
        </div>
      </div>
      <div className="card">
        <b>The output is unchanged.</b>{' '}
        <span className="small">
          With the right acceptance rule (keep a draft token x with probability min(1, p(x)/q(x)), otherwise sample from what is
          left of the big model's distribution), the tokens come out exactly as if the big model had generated them alone. Checked
          here on 40,000 samples:
        </span>
        <div className="table-wrap">
          <table className="t tr-dist">
            <thead>
              <tr>
                <th>Token</th>
                {P.map((_, i) => (
                  <th key={i} className="num">
                    {String.fromCharCode(65 + i)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Big model p</td>
                {P.map((p, i) => (
                  <td key={i} className="num">
                    {p.toFixed(3)}
                  </td>
                ))}
              </tr>
              <tr>
                <td>Draft model q</td>
                {Q.map((q, i) => (
                  <td key={i} className="num">
                    {q.toFixed(3)}
                  </td>
                ))}
              </tr>
              <tr>
                <td>
                  <b>Speculative output</b>
                </td>
                {dist.freq.map((f, i) => (
                  <td key={i} className="num">
                    <b>{f.toFixed(3)}</b>
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
        <p className="tr-note">
          The output matches p, not q, within sampling noise; the draft was accepted {(dist.acceptance * 100).toFixed(0)}% of the time
          here (in theory {(P.reduce((s, p, i) => s + Math.min(p, Q[i]), 0) * 100).toFixed(0)}%). Providers use this, or draft heads
          built into the model (Medusa, EAGLE), to serve faster at no cost in quality.
        </p>
      </div>
    </section>
  );
}
