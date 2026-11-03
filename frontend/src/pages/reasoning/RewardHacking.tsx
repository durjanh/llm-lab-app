import { useRef, useState } from 'react';
import { Plot } from '../deep-learning/Plot';
import { softmax, useAnimation } from '../deep-learning/kit';
import { Trainer, type Task } from './policy';

const CODING: Task[] = [
  {
    name: 'Write a function that passes the tests',
    strategies: ['implement it correctly', 'implement it with an off-by-one bug', "hard-code the visible tests' answers", 'special-case the examples, buggy otherwise'],
    correct: [0], // what actually works on new inputs (the hidden tests)
    init: [0, 0.8, 0.6, 0.4],
  },
];
const WEAK_PASSES = [0, 2, 3]; // strategies that pass the visible tests only
const STEPS = 120;
const SETTINGS = { group: 8, lr: 0.5, beta: 0, batch: 8 };

const weakReward = (_: number, a: number) => (WEAK_PASSES.includes(a) ? 1 : 0);
const strongReward = (_: number, a: number) => (a === 0 ? 1 : 0);

/** RL with a weak checker: the measured reward climbs to 100% while the real pass rate does not. */
export default function RewardHacking() {
  const runs = useRef({ weak: new Trainer('grpo', 7, CODING), strong: new Trainer('grpo', 7, CODING) });
  const weakRewardHistory = useRef<number[]>([expectedWeak(runs.current.weak)]);
  const [running, setRunning] = useState(false);
  const [, setTick] = useState(0);
  const steps = runs.current.weak.history.length - 1;

  useAnimation(running, () => {
    for (let k = 0; k < 2 && runs.current.weak.history.length - 1 < STEPS; k++) {
      runs.current.weak.step(SETTINGS, weakReward);
      runs.current.strong.step(SETTINGS, strongReward);
      weakRewardHistory.current.push(expectedWeak(runs.current.weak));
    }
    setTick((t) => t + 1);
    const more = runs.current.weak.history.length - 1 < STEPS;
    if (!more) setRunning(false);
    return more;
  });
  const reset = () => {
    runs.current = { weak: new Trainer('grpo', 7, CODING), strong: new Trainer('grpo', 7, CODING) };
    weakRewardHistory.current = [expectedWeak(runs.current.weak)];
    setRunning(false);
    setTick((t) => t + 1);
  };

  const xs = Array.from({ length: steps + 1 }, (_, i) => i);
  const { weak, strong } = runs.current;
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const p = softmax(weak.logits[0]);

  return (
    <section className="rm-section">
      <h2>Verifiable rewards, and gaming a weak checker</h2>
      <p>
        The GRPO toy above scored answers by <b>checking</b> them, not by asking a learned reward model which answer people
        would prefer. That is <b>reinforcement learning with verifiable rewards</b> (RLVR): maths answers compared with the
        known result, code run against unit tests. Checks are cheap, exact and hard to flatter, which is why reasoning RL
        scaled first on maths and code. But the policy optimises <i>the check</i>, not your intention: a weak check gets gamed.
      </p>
      <p className="small muted">
        Toy: a coding task with four strategies. The <b>weak checker</b> runs only the visible tests, so hard-coding their
        answers, or special-casing the examples, passes too. The <b>strong checker</b> adds hidden tests on new inputs. Same
        GRPO training as above, same random seed for both.
      </p>
      <div className="rm-controls">
        <button className="btn primary" disabled={steps >= STEPS} onClick={() => setRunning((r) => !r)}>
          {running ? 'Pause' : steps ? 'Continue' : 'Train with both checkers'}
        </button>
        <button className="btn" onClick={reset}>
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
            height={230}
            xLabel="training step"
            yLabel="share of answers"
            ariaLabel="Reward and real pass rate under a weak and a strong checker"
            draw={(f) => {
              f.line(xs, weakRewardHistory.current, f.c.s2, 2.5, [6, 4]);
              f.line(xs, weak.history, f.c.s2, 3);
              f.line(xs, strong.history, f.c.s3, 3);
            }}
          />
          <div className="rm-legend small">
            <span>
              <i style={{ background: 'var(--s2)', opacity: 0.6 }} /> weak checker: reward it reports (dashed)
            </span>
            <span>
              <i style={{ background: 'var(--s2)' }} /> weak checker: really correct
            </span>
            <span>
              <i style={{ background: 'var(--s3)' }} /> strong checker: really correct
            </span>
          </div>
        </div>
        <div className="card">
          <div className="rm-readout">
            <div>
              <b className="mono">{pct(weakRewardHistory.current[steps])}</b>
              <span>weak checker's reward</span>
            </div>
            <div>
              <b className="mono">{pct(weak.history[steps])}</b>
              <span>really correct, weak checker</span>
            </div>
            <div>
              <b className="mono">{pct(strong.history[steps])}</b>
              <span>really correct, strong checker</span>
            </div>
          </div>
          <p className="small">What the weak-checker policy writes now:</p>
          <ul className="small rm-list">
            {CODING[0].strategies.map((s, j) => (
              <li key={s}>
                {s}: <b className="mono">{Math.round(p[j] * 100)}%</b>
                {j === 0 ? ' ✓' : WEAK_PASSES.includes(j) ? ' (passes the visible tests only)' : ''}
              </li>
            ))}
          </ul>
          <p className="small muted">
            Every strategy that passes the weak check gets the same reward, so training cannot tell the real solution from the
            hard-coded one: their shares drift at random from where they started, and the real solution can lose ground. The
            reward says 100%; the code is mostly wrong.
          </p>
        </div>
      </div>
    </section>
  );
}

function expectedWeak(t: Trainer): number {
  const p = softmax(t.logits[0]);
  return WEAK_PASSES.reduce((s, j) => s + p[j], 0);
}
