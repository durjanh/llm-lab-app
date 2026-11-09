import Arena from './Arena';
import Contamination from './Contamination';
import PassAtK from './PassAtK';
import Significance from './Significance';
import { wilson } from './stats';
import './benchmarks.css';

// What each well-known benchmark tests and how it is graded. No scores: they go stale within months.
const BENCHMARKS: { name: string; tests: string; graded: string; check?: boolean }[] = [
  { name: 'MMLU / MMLU-Pro', tests: 'Broad knowledge: multiple-choice questions across 57 subjects, from law to physics. MMLU-Pro is harder, with ten options and more reasoning.', graded: 'Accuracy on the chosen option' },
  { name: 'GPQA (Diamond)', tests: 'Graduate-level biology, physics and chemistry, written by experts to be hard to look up ("Google-proof"); Diamond is the hardest subset, about 200 questions.', graded: 'Accuracy, multiple choice' },
  { name: 'HumanEval / MBPP', tests: 'Short Python functions from a description: 164 problems in HumanEval, about 1,000 simpler ones in MBPP.', graded: 'Hidden unit tests; pass@k (below)' },
  { name: 'SWE-bench Verified', tests: 'Real GitHub issues from Python projects; the model must write a patch. "Verified" is a 500-issue subset that people checked were solvable.', graded: 'The project\'s own tests: the failing ones must now pass, and the passing ones must still pass' },
  { name: 'MATH / AIME', tests: 'Competition mathematics. MATH has 12,500 problems; AIME is the American Invitational Mathematics Examination, two papers (AIME I and II) of 15 problems each, so 30 a year, with whole-number answers.', graded: 'Exact final answer' },
  { name: 'ARC-AGI', tests: 'Visual puzzles on coloured grids: infer the rule from a few examples and apply it to a new grid. Easy for people, hard for models.', graded: 'Exact output grid' },
  { name: "Humanity's Last Exam", tests: 'A few thousand very hard expert questions across many subjects, some with images, collected to sit beyond other benchmarks.', graded: 'Multiple choice or a short exact answer, checked by a model for equivalence', check: true },
  { name: 'LMArena (Chatbot Arena)', tests: 'Real users\' own prompts; two anonymous models answer and the user votes for the better one.', graded: 'Pairwise votes turned into ratings (below)' },
];

/** Lab 33: what benchmarks measure, and how to read their numbers honestly. */
export default function BenchmarksPage() {
  // Saturation: two models at 97% and 98% on a 1,000-question benchmark.
  const [aLo, aHi] = wilson(0.97, 1000);
  const [bLo, bHi] = wilson(0.98, 1000);
  return (
    <main className="page-benchmarks">
      <div className="kicker">Lab 33 · Benchmarks</div>
      <h1>Benchmarks: what the numbers mean, and when to trust them</h1>
      <p className="lede">
        Model announcements lead with benchmark scores. Each one is a sample of questions with its own way of grading, its own
        noise, and its own ways of being gamed. This lab works through the statistics behind the leaderboards, with every number
        computed here. For testing your own application, see the <a href="/evals">Evals lab</a>.
      </p>

      <section className="bm-section">
        <h2>What the well-known benchmarks test</h2>
        <div className="table-wrap">
          <table className="t">
            <thead>
              <tr>
                <th>Benchmark</th>
                <th>What it tests</th>
                <th>How it is graded</th>
              </tr>
            </thead>
            <tbody>
              {BENCHMARKS.map((b) => (
                <tr key={b.name}>
                  <td>
                    <b>{b.name}</b>
                  </td>
                  <td className="small">{b.tests}</td>
                  <td className="small">
                    {b.graded}
                    {b.check && <span className="bm-note"> (details vary by version; check the paper)</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="small muted">No scores here on purpose: they change with every model release, and a score means little without its interval.</p>
      </section>

      <PassAtK />
      <Significance />
      <Contamination />
      <Arena />

      <section className="bm-section">
        <h2>Saturation and Goodhart's law</h2>
        <p>
          When the best models score near 100%, a benchmark stops separating them. On 1,000 questions, models at 97% and 98% have
          95% intervals of {(aLo * 100).toFixed(1)}–{(aHi * 100).toFixed(1)}% and {(bLo * 100).toFixed(1)}–{(bHi * 100).toFixed(1)}%: they overlap, and
          the last few points are often questions with wrong or ambiguous answer keys anyway. That is why MMLU gave way to
          MMLU-Pro and GPQA, and why new benchmarks such as Humanity's Last Exam are built to start low.
        </p>
        <p>
          <b>Goodhart's law</b>: when a measure becomes a target, it stops being a good measure. Once a benchmark is what
          everyone reports, training (deliberately or not) tunes towards it: its style, its format, sometimes its questions. A
          model can then rise on the benchmark without getting better at what the benchmark was meant to show.
        </p>
      </section>

      <section className="bm-section">
        <h2>Engineering takeaways</h2>
        <ul className="bm-takeaways">
          <li>
            <b>Build your own eval</b> from your own tasks and data; public benchmarks only shortlist models. The{' '}
            <a href="/evals">Evals lab</a> shows how.
          </li>
          <li>
            <b>Report intervals, and compare paired.</b> A two-point gap on a few hundred questions is usually noise.
          </li>
          <li>
            <b>Check contamination:</b> keep a private test set, refresh it, and be wary of scores far above your own results.
          </li>
          <li>
            <b>Use several benchmarks</b> that test different things, plus human preference (arenas) for open-ended quality.
          </li>
          <li>
            <b>Match the metric to the use:</b> pass@1 or pass^k (every attempt succeeds) for agents that must be reliable, not
            pass@10.
          </li>
        </ul>
      </section>
    </main>
  );
}
