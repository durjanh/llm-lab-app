import { useMemo, useState } from 'react';
import { Plot } from '../deep-learning/Plot';

const MAX_K = 40;

function logFactorials(n: number): number[] {
  const out = [0];
  for (let i = 1; i <= n; i++) out.push(out[i - 1] + Math.log(i));
  return out;
}
const LF = logFactorials(200);
const choose = (n: number, k: number) => Math.exp(LF[n] - LF[k] - LF[n - k]);

/** pass@k: at least one of k independent samples is right. */
export const passAtK = (p: number, k: number) => 1 - (1 - p) ** k;

/**
 * Majority vote over k samples, exactly. Assumption: each sample is right with probability p, otherwise one of
 * `wrong` wrong answers chosen uniformly. The right answer wins if it has more votes than every wrong answer; a tie
 * for first place is broken at random.
 */
export function majority(p: number, wrong: number, k: number): number {
  let total = 0;
  for (let c = 1; c <= k; c++) {
    const pc = choose(k, c) * p ** c * (1 - p) ** (k - c);
    if (pc < 1e-15) continue;
    const w = k - c;
    // dp[n][t]: spread n of the w wrong votes over the wrong answers seen so far, none above c, t of them at exactly c;
    // weighted by 1/s! per answer, so w! · dp[w][t] / wrong^w is the probability.
    let dp: number[][] = Array.from({ length: w + 1 }, () => new Array(wrong + 1).fill(0));
    dp[0][0] = 1;
    for (let j = 0; j < wrong; j++) {
      const next = Array.from({ length: w + 1 }, () => new Array(wrong + 1).fill(0));
      for (let n = 0; n <= w; n++) {
        for (let t = 0; t <= j; t++) {
          if (!dp[n][t]) continue;
          for (let s = 0; s <= Math.min(c, w - n); s++) next[n + s][t + (s === c ? 1 : 0)] += dp[n][t] / Math.exp(LF[s]);
        }
      }
      dp = next;
    }
    let win = 0;
    for (let t = 0; t <= wrong; t++) win += (Math.exp(LF[w]) * dp[w][t] * wrong ** -w) / (t + 1);
    total += pc * win;
  }
  return total;
}

/** Test-time compute: spend more samples at answer time, and pick an answer by checking or by voting. */
export default function TestTime() {
  const [p, setP] = useState(0.4);
  const [wrong, setWrong] = useState(3);
  const ks = useMemo(() => Array.from({ length: MAX_K }, (_, i) => i + 1), []);
  const vote = useMemo(() => ks.map((k) => majority(p, wrong, k)), [ks, p, wrong]);
  const pass = ks.map((k) => passAtK(p, k));
  const threshold = 1 / (wrong + 1);
  const pct = (v: number) => `${(v * 100).toFixed(v > 0.995 && v < 1 ? 1 : 0)}%`;

  return (
    <section className="rm-section">
      <h2>Test-time compute: more samples, picked well</h2>
      <p>
        Thinking longer is one way to spend compute at answer time. Another is to sample several answers and pick one.{' '}
        <b>pass@k</b> is the chance that at least one of k answers is right: what you get if something can check each answer
        (unit tests, a proof checker). <b>Majority voting</b> (self-consistency) needs no checker: take the most common answer.
        The <a href="/sampling">Sampling lab</a> does self-consistency with GPT-2.
      </p>
      <div className="rm-controls">
        <label>
          One answer is right with probability p{' '}
          <input type="range" min={0.05} max={0.9} step={0.01} value={p} onChange={(e) => setP(+e.target.value)} />
          <span className="mono">{p.toFixed(2)}</span>
        </label>
        <label>
          Different wrong answers <input type="range" min={1} max={10} step={1} value={wrong} onChange={(e) => setWrong(+e.target.value)} />
          <span className="mono">{wrong}</span>
        </label>
      </div>
      <div className="rm-two">
        <div className="card">
          <Plot
            x={[1, MAX_K]}
            y={[0, 1]}
            height={240}
            xLabel="answers sampled, k"
            yLabel="chance of a right final answer"
            ariaLabel="pass@k and majority-vote accuracy as the number of samples grows"
            draw={(f) => {
              f.hline(p, f.c.muted);
              f.line(ks, pass, f.c.s3, 3);
              f.line(ks, vote, f.c.s1, 3);
            }}
          />
          <div className="rm-legend small">
            <span>
              <i style={{ background: 'var(--s3)' }} /> pass@k (a checker picks)
            </span>
            <span>
              <i style={{ background: 'var(--s1)' }} /> majority vote
            </span>
            <span>
              <i style={{ background: 'var(--muted)' }} /> one answer
            </span>
          </div>
        </div>
        <div className="card">
          <table className="t">
            <thead>
              <tr>
                <th>k</th>
                <th className="num">pass@k</th>
                <th className="num">Majority vote</th>
              </tr>
            </thead>
            <tbody>
              {[1, 5, 10, 20, 40].map((k) => (
                <tr key={k}>
                  <td>{k}</td>
                  <td className="num">{pct(pass[k - 1])}</td>
                  <td className="num">{pct(vote[k - 1])}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className={`small ${p > threshold ? 'rm-good' : 'rm-bad'}`}>
            {p > threshold
              ? `The right answer is the single most likely answer (p = ${p.toFixed(2)} is above 1 ÷ (${wrong} + 1) = ${threshold.toFixed(2)}), so voting converges on it.`
              : `A wrong answer is at least as likely as the right one (p = ${p.toFixed(2)} is not above 1 ÷ (${wrong} + 1) = ${threshold.toFixed(2)}), so voting converges on a wrong answer: more samples make it worse.`}
          </p>
        </div>
      </div>
      <p className="small muted">
        Assumption: answers are independent; a wrong answer is one of the {wrong} wrong answers at random. Real models' errors
        are correlated and often agree on the same wrong answer, which makes voting weaker than this. Ties for first place are
        broken at random. Majority vote is computed exactly over every way the votes can fall.
      </p>
    </section>
  );
}
