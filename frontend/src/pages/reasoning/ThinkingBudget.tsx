import { useState } from 'react';
import { Plot } from '../deep-learning/Plot';

// An illustrative model, not a measurement: accuracy rises towards a ceiling as thinking tokens grow, with diminishing
// returns. Each kind of task has its own starting accuracy, ceiling and scale.
const KINDS = [
  { name: 'Look-up or rewrite', start: 0.9, ceiling: 0.95, scale: 400, colour: 's3' },
  { name: 'Multi-step maths or code', start: 0.3, ceiling: 0.9, scale: 4000, colour: 's1' },
  { name: 'Hard problem (competition maths)', start: 0.05, ceiling: 0.6, scale: 15000, colour: 's2' },
] as const;
const MAX = 32000;
const SPEED = 80; // output tokens per second: an assumption for the latency figures

const accuracy = (k: (typeof KINDS)[number], t: number) => k.ceiling - (k.ceiling - k.start) * Math.exp(-t / k.scale);

export default function ThinkingBudget() {
  const [budget, setBudget] = useState(4000);
  const xs = Array.from({ length: 161 }, (_, i) => (i / 160) * MAX);
  return (
    <section className="rm-section">
      <h2>How much thinking? The budget trade-off</h2>
      <p>
        Thinking tokens are output tokens: they are billed and they take time to generate. More thinking helps until the task
        stops getting easier, and the point where it stops paying depends on the task. This is <b>an illustrative model</b> of
        that shape, not a measurement of any model; measure your own task with an evaluation set at several effort levels.
      </p>
      <div className="rm-controls">
        <label>
          Thinking budget{' '}
          <input type="range" min={0} max={MAX} step={500} value={budget} onChange={(e) => setBudget(+e.target.value)} />
          <span className="mono">{budget.toLocaleString('en-GB')} tokens</span>
        </label>
        <span className="small muted">
          About {Math.round(budget / SPEED)} s extra at {SPEED} tokens a second (an assumption)
        </span>
      </div>
      <div className="rm-two">
        <div className="card">
          <Plot
            x={[0, MAX]}
            y={[0, 1]}
            height={230}
            xLabel="thinking tokens"
            yLabel="accuracy (illustrative)"
            ariaLabel="Accuracy against thinking tokens for three kinds of task"
            draw={(f) => {
              for (const k of KINDS) f.line(xs, xs.map((t) => accuracy(k, t)), f.c[k.colour], 2.5);
              f.vline(budget, f.c.muted);
            }}
          />
          <div className="rm-legend small">
            {KINDS.map((k) => (
              <span key={k.name}>
                <i style={{ background: `var(--${k.colour})` }} /> {k.name}
              </span>
            ))}
          </div>
        </div>
        <div className="card">
          <table className="t">
            <thead>
              <tr>
                <th>Task</th>
                <th className="num">Accuracy</th>
                <th className="num">Gain from 1,000 more tokens</th>
              </tr>
            </thead>
            <tbody>
              {KINDS.map((k) => (
                <tr key={k.name}>
                  <td>{k.name}</td>
                  <td className="num">{Math.round(accuracy(k, budget) * 100)}%</td>
                  <td className="num">+{((accuracy(k, budget + 1000) - accuracy(k, budget)) * 100).toFixed(1)} points</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="small">
            <b>Low effort</b> for look-ups, extraction, rewriting and chat: extra thinking buys almost nothing and adds delay.{' '}
            <b>Higher effort</b> for multi-step maths, code and planning, until the gain per thousand tokens is too small to pay
            for. A per-request setting (Claude's effort, OpenAI's reasoning effort) lets one application do both.
          </p>
        </div>
      </div>
    </section>
  );
}
