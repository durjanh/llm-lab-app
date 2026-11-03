import { useMemo, useState } from 'react';
import { rng } from '../deep-learning/kit';
import { ngramOverlap, wilson } from './stats';
import { pct, Slider } from './ui';

const TRAINING = `Forum post, 2023: Here are the answers to last year's quiz. Q: A train leaves London at 9am travelling at 80 miles per hour; how far has it gone by 11:30am? A: 200 miles. Q: What is the capital of Australia? A: Canberra. People always guess Sydney.
Blog: The boiling point of water falls as you climb, because air pressure drops.`;

const QUESTIONS = `A train leaves London at 9am travelling at 80 miles per hour; how far has it gone by 11:30am?
What is the capital city of Australia?
Why does water boil at a lower temperature on a mountain?
How many prime numbers are there between 10 and 30?`;

/** A model that memorised part of the test set: what the score says, and how to catch it. */
export default function Contamination() {
  const [memorised, setMemorised] = useState(25);
  const [skill, setSkill] = useState(60);
  const [seed, setSeed] = useState(3);
  const [training, setTraining] = useState(TRAINING);
  const [questions, setQuestions] = useState(QUESTIONS);
  const [gram, setGram] = useState(5);
  const n = 500;

  const sim = useMemo(() => {
    const r = rng(seed);
    let published = 0;
    let fresh = 0;
    for (let i = 0; i < n; i++) {
      // On the published test, memorised questions are always right; the rest depend on real skill.
      published += r() < memorised / 100 || r() < skill / 100 ? 1 : 0;
      // A fresh variant (new or reworded questions) only measures real skill.
      fresh += r() < skill / 100 ? 1 : 0;
    }
    return { published: published / n, fresh: fresh / n };
  }, [memorised, skill, seed]);
  const expected = memorised / 100 + (1 - memorised / 100) * (skill / 100);
  const [pLo, pHi] = wilson(sim.published, n);
  const [fLo, fHi] = wilson(sim.fresh, n);
  const suspicious = pLo > fHi;

  const overlaps = questions
    .split('\n')
    .map((q) => q.trim())
    .filter(Boolean)
    .map((q) => ({ q, score: ngramOverlap(training, q, gram) }));

  return (
    <section className="bm-section">
      <h2>Contamination: when the test leaked into training</h2>
      <p>
        Benchmarks are public, and models are trained on the web. If a model saw the test questions and answers during training,
        its score measures memory, not skill. Labs fight this with held-out and refreshed tests, and by checking training data for
        overlap.
      </p>
      <div className="bm-controls">
        <Slider label="test questions memorised" value={memorised} min={0} max={60} onChange={setMemorised} show={(v) => `${v}%`} />
        <Slider label="real skill" value={skill} min={10} max={95} onChange={setSkill} show={(v) => `${v}%`} />
        <button className="btn small" onClick={() => setSeed((s) => s + 1)}>
          New sample
        </button>
      </div>
      <div className="bm-ci">
        {[
          ['Published test', sim.published, pLo, pHi, 'var(--s2)'],
          ['Fresh variant', sim.fresh, fLo, fHi, 'var(--s1)'],
        ].map(([name, p, lo, hi, colour]) => (
          <div key={name as string} className="bm-ci-row">
            <span className="small">{name as string}</span>
            <div className="bm-ci-track">
              <i style={{ left: `${(lo as number) * 100}%`, width: `${((hi as number) - (lo as number)) * 100}%`, background: colour as string }} />
              <b style={{ left: `${(p as number) * 100}%` }} />
            </div>
            <span className="small mono">{pct(p as number)}</span>
          </div>
        ))}
      </div>
      <p className="small">
        On {n} questions the published score is <b>{pct(sim.published)}</b> (expected {pct(expected)}: memorised {memorised}%, plus
        {' '}{skill}% of the rest); the fresh variant gives <b>{pct(sim.fresh)}</b>, the real skill.{' '}
        {suspicious ? (
          <span className="bm-bad">The intervals do not overlap: a gap this size suggests contamination.</span>
        ) : (
          <span>The intervals overlap, so this sample cannot tell contamination from noise.</span>
        )}
      </p>

      <h3>Checking for overlap</h3>
      <p className="small">
        A simple contamination check: what share of each test question's {gram}-word sequences appear in the training text? Labs
        run this kind of check (often with 8- to 13-word sequences) over their whole training set. Edit either box.
      </p>
      <div className="bm-two">
        <label className="small bm-text">
          Training text
          <textarea rows={7} value={training} onChange={(e) => setTraining(e.target.value)} />
        </label>
        <label className="small bm-text">
          Test questions, one per line
          <textarea rows={7} value={questions} onChange={(e) => setQuestions(e.target.value)} />
        </label>
      </div>
      <div className="bm-controls">
        <Slider label="words per sequence" value={gram} min={3} max={13} onChange={setGram} />
      </div>
      <table className="t">
        <thead>
          <tr>
            <th>Question</th>
            <th className="num">Overlap</th>
            <th>Flag</th>
          </tr>
        </thead>
        <tbody>
          {overlaps.map((o, i) => (
            <tr key={i}>
              <td className="small">{o.q}</td>
              <td className="num">{pct(o.score, 0)}</td>
              <td className={o.score >= 0.5 ? 'bm-bad' : o.score > 0 ? 'bm-warn' : 'bm-good'}>
                {o.score >= 0.5 ? 'leaked' : o.score > 0 ? 'partial' : 'clean'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="small muted">
        Exact-match checks miss paraphrases: the capital question was reworded, so its overlap is low although the answer leaked.
        That is why fresh variants of a test matter as much as overlap checks.
      </p>
    </section>
  );
}
