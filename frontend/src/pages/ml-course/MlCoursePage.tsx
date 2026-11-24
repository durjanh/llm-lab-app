import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { ALL_QUIZ, quizFor } from './quizzes';
import { commit, load, passed, recordScore, toggleDone, type Progress } from './progress';
import type { QuizQuestion } from './types';
import { exerciseFor, PARTS, WEEKS, type Week } from './weeks';
import './ml-course.css';

/** A week's self-check: pick an answer per question, then check them all at once and see why each is right. */
function Quiz({
  week,
  questions,
  best,
  onScore,
}: {
  week: number;
  questions: QuizQuestion[];
  best?: number;
  onScore: (n: number) => void;
}) {
  const [picked, setPicked] = useState<(number | null)[]>(() => questions.map(() => null));
  const [checked, setChecked] = useState(false);
  if (!questions.length) return <p className="small muted">The quiz for this week is on its way.</p>;
  const score = picked.filter((p, i) => p === questions[i].answer).length;
  const all = picked.every((p) => p !== null);
  return (
    <div className="mc-quiz">
      {questions.map((q, i) => (
        <fieldset key={q.q} className="mc-q">
          <legend>
            {i + 1}. {q.q}
          </legend>
          {q.options.map((o, j) => {
            const state = checked ? (j === q.answer ? 'right' : picked[i] === j ? 'wrong' : '') : '';
            return (
              <label key={o} className={`mc-opt ${state}`}>
                <input
                  type="radio"
                  name={`w${week}-q${i}`}
                  checked={picked[i] === j}
                  disabled={checked}
                  onChange={() => setPicked((p) => p.map((v, k) => (k === i ? j : v)))}
                />
                <span>{o}</span>
              </label>
            );
          })}
          {checked && <p className="small mc-why">{q.why}</p>}
        </fieldset>
      ))}
      <div className="row mc-quiz-bar">
        {checked ? (
          <>
            <b className={passed(score, questions.length) ? 'mc-good' : 'mc-bad'}>
              {score} of {questions.length}
              {passed(score, questions.length) ? ': passed' : ': not yet, read the explanations and try again'}
            </b>
            <button
              type="button"
              className="btn small"
              onClick={() => {
                setPicked(questions.map(() => null));
                setChecked(false);
              }}
            >
              Try again
            </button>
          </>
        ) : (
          <button
            type="button"
            className="btn small primary"
            disabled={!all}
            onClick={() => {
              setChecked(true);
              onScore(score);
            }}
          >
            Check answers
          </button>
        )}
        {best !== undefined && <span className="small muted">Best so far: {best}</span>}
      </div>
    </div>
  );
}

function WeekCard({
  w,
  progress,
  open,
  onToggleOpen,
  onToggleDone,
  onScore,
}: {
  w: Week;
  progress: Progress;
  open: boolean;
  onToggleOpen: () => void;
  onToggleDone: () => void;
  onScore: (n: number) => void;
}) {
  const questions = quizFor(w.n);
  const done = progress.done.includes(w.n);
  const best = progress.best[w.n];
  return (
    <article id={`week-${w.n}`} className={`card mc-week${done ? ' done' : ''}`}>
      <button type="button" className="mc-week-head" aria-expanded={open} onClick={onToggleOpen}>
        <span className="mc-num">Week {w.n}</span>
        <span className="mc-title">{w.title}</span>
        <span className="mc-flags">
          {passed(best, questions.length) && <span className="mc-tag good">quiz passed</span>}
          {done && <span className="mc-tag">done</span>}
        </span>
      </button>
      {open && (
        <div className="mc-week-body">
          <h3>By the end of the week you can</h3>
          <ul>
            {w.goals.map((g) => (
              <li key={g}>{g}</li>
            ))}
          </ul>
          <h3>Work through</h3>
          <ol>
            {w.pages.map(([to, label]) => (
              <li key={to + label}>
                <Link to={to}>{label}</Link>
              </li>
            ))}
          </ol>
          <h3>Try this</h3>
          <p>{w.task}</p>
          <h3>Python exercise</h3>
          <p className="small">{exerciseFor(w.n).brief}</p>
          <pre className="code mc-cmd">
            <code>
              cd examples/ml-course{'\n'}
              {exerciseFor(w.n).command}
            </code>
          </pre>
          <h3>Check yourself</h3>
          <Quiz key={w.n} week={w.n} questions={questions} best={best} onScore={onScore} />
          <div className="row">
            <button type="button" className={`btn small${done ? '' : ' primary'}`} onClick={onToggleDone}>
              {done ? 'Mark as not done' : 'Mark week as done'}
            </button>
          </div>
        </div>
      )}
    </article>
  );
}

/**
 * An original 25-week course in machine learning and AI, built from the lab's own pages: each week has goals, pages
 * to work through, a task, a Python exercise and a self-check quiz. Progress stays in this browser.
 */
export default function MlCoursePage() {
  const [progress, setProgress] = useState<Progress>(() => load());
  const [part, setPart] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(() => {
    const p = load();
    return WEEKS.find((w) => !p.done.includes(w.n))?.n ?? 0;
  });

  // Another tab's changes arrive as a storage event; show them here too.
  useEffect(() => {
    const onStorage = () => setProgress(load());
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const quizzesPassed = useMemo(
    () => WEEKS.filter((w) => passed(progress.best[w.n], quizFor(w.n).length)).length,
    [progress],
  );
  const weeks = part ? WEEKS.filter((w) => w.part === part) : WEEKS;
  const next = WEEKS.find((w) => !progress.done.includes(w.n));

  return (
    <main className="page-ml-course">
      <p className="kicker">Course</p>
      <h1>Machine learning and AI in 25 weeks</h1>
      <p className="lede">
        A course that starts with the maths and the classical methods, goes through neural networks and language models,
        and ends with a project you can show. Each week points at lab pages you can play with, gives you one thing to
        try, a Python exercise with tests, and a short quiz. It is written for someone who can already program; plan on
        eight to ten hours a week.
      </p>

      <div className="stats mc-stats">
        <div className="stat">
          <b>
            {progress.done.length} / {WEEKS.length}
          </b>
          <span className="small muted">weeks done</span>
        </div>
        <div className="stat">
          <b>
            {quizzesPassed} / {WEEKS.length}
          </b>
          <span className="small muted">quizzes passed (three quarters or better)</span>
        </div>
        <div className="stat">
          <b>{ALL_QUIZ.length}</b>
          <span className="small muted">questions in all</span>
        </div>
        <div className="stat">
          <b>{next ? `Week ${next.n}` : 'Finished'}</b>
          <span className="small muted">{next ? next.title : 'every week is marked done'}</span>
        </div>
      </div>
      <div
        className="mc-bar"
        role="progressbar"
        aria-label="Weeks done"
        aria-valuemin={0}
        aria-valuemax={WEEKS.length}
        aria-valuenow={progress.done.length}
      >
        <span style={{ width: `${(progress.done.length / WEEKS.length) * 100}%` }} />
      </div>
      <p className="small muted">
        Progress is kept in this browser only. Nothing is sent anywhere, and a private window forgets it when closed.
      </p>

      <h2>How it works</h2>
      <ul>
        <li>
          <b>Pages first.</b> Every week starts on lab pages where you can move a slider or run a model and watch the
          idea work. Most need no backend and cost nothing.
        </li>
        <li>
          <b>Then code.</b> <code>examples/ml-course/</code> has one folder per week: an exercise with gaps, tests that
          fail until you fill them, and worked solutions (run the tests with <code>ML_COURSE_SOLUTIONS=1</code> to check
          the solutions instead). Build each idea in numpy first, then use the library.
        </li>
        <li>
          <b>Then check yourself.</b> Each quiz explains every answer. Three quarters right counts as a pass, and you
          can retake it.
        </li>
        <li>
          <b>All the way through, the capstone.</b> From week 14 you can start the <Link to="/capstone">capstone</Link>:
          find the best inputs of hidden functions on a fixed budget of tries, and keep a log of why you chose each one.
          In week 25 you finish it and publish it.
        </li>
      </ul>
      <pre className="code">
        <code>
          {'# Set up once (Python 3.12)\n'}
          {'cd examples/ml-course\n'}
          {'python3.12 -m venv .venv && .venv/bin/pip install -r requirements.txt\n'}
          {'.venv/bin/pip install -r requirements-torch.txt   # optional: weeks 15 to 17, 19 and 20\n\n'}
          {'# Each week\n'}
          {'.venv/bin/python -m pytest week04 -q                        # your exercise\n'}
          {'ML_COURSE_SOLUTIONS=1 .venv/bin/python -m pytest week04 -q  # the worked solution'}
        </code>
      </pre>

      <h2>The weeks</h2>
      <div className="chips mc-parts" role="group" aria-label="Show a part of the course">
        <button type="button" className={`chip-btn${part === null ? ' on' : ''}`} onClick={() => setPart(null)}>
          All
        </button>
        {PARTS.map((p) => (
          <button key={p} type="button" className={`chip-btn${part === p ? ' on' : ''}`} onClick={() => setPart(p)}>
            {p}
          </button>
        ))}
      </div>
      {PARTS.filter((p) => !part || p === part).map((p) => (
        <section key={p} className="mc-part">
          <h3 className="mc-part-title">{p}</h3>
          {weeks
            .filter((w) => w.part === p)
            .map((w) => (
              <WeekCard
                key={w.n}
                w={w}
                progress={progress}
                open={open === w.n}
                onToggleOpen={() => setOpen((o) => (o === w.n ? null : w.n))}
                onToggleDone={() => setProgress(commit((pr) => toggleDone(pr, w.n), progress))}
                onScore={(s) => setProgress(commit((pr) => recordScore(pr, w.n, s), progress))}
              />
            ))}
        </section>
      ))}

      <h2>Where to go next</h2>
      <p>
        The course stops where production work starts. <Link to="/mlops">MLOps</Link> and{' '}
        <Link to="/llmops">LLMOps</Link> cover releasing and running models, <Link to="/evals">Evals</Link> measuring
        language models, and <Link to="/agents">Agents and tools</Link> building on them. The{' '}
        <Link to="/bible">Bible</Link> has short answers to the questions each page raises.
      </p>
    </main>
  );
}
