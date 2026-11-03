import { useRef, useState } from 'react';
import { Plot } from '../deep-learning/Plot';
import { softmax, useAnimation } from '../deep-learning/kit';
import { TASKS, Trainer, type Settings } from './policy';

const SEEDS = 5;
const STEPS = 150;

function makeRuns(compare: boolean) {
  return {
    grpo: Array.from({ length: SEEDS }, (_, i) => new Trainer('grpo', 100 + i)),
    reinforce: compare ? Array.from({ length: SEEDS }, (_, i) => new Trainer('reinforce', 100 + i)) : [],
  };
}

const meanAt = (runs: Trainer[], i: number) => runs.reduce((s, r) => s + (r.history[i] ?? r.history[r.history.length - 1]), 0) / runs.length;

/** GRPO, live: sample a group of answers per problem, reward the right ones, normalise within the group, update. */
export default function Grpo() {
  const [settings, setSettings] = useState<Settings>({ group: 8, lr: 0.5, beta: 0, batch: 8 });
  const [compare, setCompare] = useState(true);
  const [running, setRunning] = useState(false);
  const runs = useRef(makeRuns(true));
  const [, setTick] = useState(0);
  const steps = runs.current.grpo[0].history.length - 1;

  const reset = (nextCompare = compare) => {
    runs.current = makeRuns(nextCompare);
    setRunning(false);
    setTick((t) => t + 1);
  };
  const advance = (n: number) => {
    for (let k = 0; k < n; k++) {
      if (runs.current.grpo[0].history.length - 1 >= STEPS) return false;
      [...runs.current.grpo, ...runs.current.reinforce].forEach((r) => r.step(settings));
    }
    setTick((t) => t + 1);
    return runs.current.grpo[0].history.length - 1 < STEPS;
  };
  useAnimation(running, () => {
    const more = advance(2);
    if (!more) setRunning(false);
    return more;
  });
  const set = (k: keyof Settings, v: number) => {
    setSettings((s) => ({ ...s, [k]: v }));
    reset();
  };

  const { grpo, reinforce } = runs.current;
  const xs = Array.from({ length: steps + 1 }, (_, i) => i);
  const last = grpo[0].last;
  const zeroNow = grpo.reduce((s, r) => s + (r.zeroSignal[r.zeroSignal.length - 1] ?? 0), 0) / SEEDS;
  const at = (runsOf: Trainer[], i: number) => (runsOf.length && steps >= i ? `${Math.round(meanAt(runsOf, i) * 100)}%` : '—');

  return (
    <section className="rm-section">
      <h2>GRPO, live</h2>
      <p>
        Reasoning models are trained with reinforcement learning on problems whose answers can be checked. <b>GRPO</b> (Group
        Relative Policy Optimisation, used for DeepSeek-R1) does it without a separate value model: for each problem, sample a{' '}
        <b>group</b> of answers, score each one, and compare it with its own group. Answers better than the group average are
        made more likely, worse ones less likely:
      </p>
      <p className="rm-formula">advantage = (reward − group mean) ÷ (group standard deviation)</p>
      <p className="small muted">
        <b>A toy, not a language model.</b> Each of four kinds of problem has four strategies; one gives the right answer. The
        policy picks a strategy with probabilities from trainable numbers, starting with the right one unlikely (12% overall).
        The training loop is the real one. Five runs with different random seeds are drawn faintly, their average in bold.
      </p>
      <div className="rm-controls">
        <label>
          Group size G <input type="range" min={2} max={16} step={1} value={settings.group} onChange={(e) => set('group', +e.target.value)} />
          <span className="mono">{settings.group}</span>
        </label>
        <label>
          Learning rate <input type="range" min={0.1} max={1.5} step={0.1} value={settings.lr} onChange={(e) => set('lr', +e.target.value)} />
          <span className="mono">{settings.lr.toFixed(1)}</span>
        </label>
        <label>
          KL penalty β <input type="range" min={0} max={0.6} step={0.05} value={settings.beta} onChange={(e) => set('beta', +e.target.value)} />
          <span className="mono">{settings.beta.toFixed(2)}</span>
        </label>
        <label>
          <input type="checkbox" checked={compare} onChange={(e) => (setCompare(e.target.checked), reset(e.target.checked))} /> Compare with REINFORCE (no group baseline)
        </label>
      </div>
      <div className="rm-controls">
        <button className="btn primary" disabled={steps >= STEPS} onClick={() => setRunning((r) => !r)}>
          {running ? 'Pause' : steps ? 'Continue' : 'Train'}
        </button>
        <button className="btn" disabled={running || steps >= STEPS} onClick={() => advance(1)}>
          Step
        </button>
        <button className="btn" onClick={() => reset()}>
          Reset
        </button>
        <span className="small muted">
          Step {steps} of {STEPS}
        </span>
      </div>

      <div className="rm-two">
        <div className="card">
          <Plot
            x={[0, STEPS]}
            y={[0, 1]}
            height={240}
            xLabel="training step"
            yLabel="accuracy"
            ariaLabel="Accuracy during training, GRPO and REINFORCE"
            draw={(f) => {
              for (const r of reinforce) f.line(xs.slice(0, r.history.length), r.history, f.c.s2, 1, [3, 3]);
              for (const r of grpo) f.line(xs.slice(0, r.history.length), r.history, f.c.s1, 1);
              if (reinforce.length) f.line(xs, xs.map((i) => meanAt(reinforce, i)), f.c.s2, 3);
              f.line(xs, xs.map((i) => meanAt(grpo, i)), f.c.s1, 3);
            }}
          />
          <div className="rm-legend small">
            <span>
              <i style={{ background: 'var(--s1)' }} /> GRPO
            </span>
            {reinforce.length > 0 && (
              <span>
                <i style={{ background: 'var(--s2)' }} /> REINFORCE, no baseline
              </span>
            )}
          </div>
          <div className="rm-readout">
            <div>
              <b className="mono">{at(grpo, 0)}</b>
              <span>at the start</span>
            </div>
            <div>
              <b className="mono">{at(grpo, 50)}</b>
              <span>GRPO at step 50</span>
            </div>
            {reinforce.length > 0 && (
              <div>
                <b className="mono">{at(reinforce, 50)}</b>
                <span>REINFORCE at step 50</span>
              </div>
            )}
            <div>
              <b className="mono">{at(grpo, steps)}</b>
              <span>GRPO now</span>
            </div>
          </div>
        </div>
        <div className="card">
          <b className="small">The last group (GRPO, first run)</b>
          {last ? (
            <>
              <p className="small">
                Problem: <b>{TASKS[last.task].name}</b>. G = {last.picks.length} answers:
              </p>
              <div className="rm-group">
                {last.picks.map((a, i) => (
                  <div key={i} className={`rm-answer ${last.rewards[i] ? 'right' : 'wrong'}`} title={TASKS[last.task].strategies[a]}>
                    <span>{last.rewards[i] ? '✓' : '✗'}</span>
                    <span className="mono">{last.advantages[i] === 0 ? '0' : (last.advantages[i] > 0 ? '+' : '') + last.advantages[i].toFixed(2)}</span>
                  </div>
                ))}
              </div>
              <p className="small muted">
                ✓ right, ✗ wrong; the number is each answer's advantage. When every answer in a group is right, or every one is
                wrong, they all get 0: <b>that group teaches nothing</b>.
              </p>
            </>
          ) : (
            <p className="small muted">Press Train or Step.</p>
          )}
          <p className="small">
            Groups with no learning signal in the last step: <b className="mono">{steps ? `${Math.round(zeroNow * 100)}%` : '—'}</b>
          </p>
          <Plot
            x={[0, STEPS]}
            y={[0, 1]}
            height={130}
            xLabel="step"
            yLabel="no-signal groups"
            ariaLabel="Share of groups with no learning signal during training"
            draw={(f) => {
              const smooth = xs.slice(1).map((i) => {
                const from = Math.max(0, i - 10);
                let s = 0;
                let n = 0;
                for (const r of grpo) for (let k = from; k < i; k++) if (r.zeroSignal[k] !== undefined) (s += r.zeroSignal[k], n++);
                return n ? s / n : 0;
              });
              f.line(xs.slice(1), smooth, f.c.s4, 2.5);
            }}
          />
          <p className="small muted">
            High at the start (most groups all wrong) and again at the end (most all right), so learning slows as the policy
            gets good. Larger groups, or keeping only problems that are neither too easy nor too hard, keep the signal flowing.
          </p>
        </div>
      </div>
      <details className="small">
        <summary>What the policy has learned (GRPO, first run)</summary>
        <table className="t">
          <tbody>
            {TASKS.map((t, i) => {
              const p = softmax(grpo[0].logits[i]);
              return (
                <tr key={t.name}>
                  <td>{t.name}</td>
                  <td>
                    {t.strategies.map((s, j) => (
                      <span key={s} className={`rm-strat ${t.correct.includes(j) ? 'right' : ''}`}>
                        {s} <b className="mono">{Math.round(p[j] * 100)}%</b>
                      </span>
                    ))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </details>
      <p className="small">
        <b>Try:</b> G = 2 (fewer comparisons, slower and noisier learning); a KL penalty of 0.1 (the policy is held near where it
        started and stops a little short) and 0.5 (it barely moves); untick REINFORCE to see GRPO alone. Without the group
        baseline, REINFORCE rewards every right answer by the same amount however easy the problem, and learns more slowly at
        the same learning rate.
      </p>
    </section>
  );
}
