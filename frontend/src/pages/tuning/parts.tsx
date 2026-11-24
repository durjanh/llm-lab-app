import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import type { QuizQuestion } from '@/pages/ml-course/types';

/* Building blocks shared by the course pages on evaluation, tuning and the capstone. Styles are in plot.css. */

/** A page section with its course week shown as a tag beside the heading. */
export function CourseSection({
  id,
  title,
  weeks,
  children,
}: {
  id: string;
  title: string;
  weeks: number[];
  children: ReactNode;
}) {
  return (
    <section id={id} className="cs-section">
      <h2>
        {title}
        <span className="wk-tag">
          {weeks.length > 1 ? 'Weeks' : 'Week'} {weeks.join(' and ')}
        </span>
      </h2>
      {children}
    </section>
  );
}

/** The section links at the top of a page. */
export function SectionNav({ sections }: { sections: [string, string][] }) {
  return (
    <nav className="cs-nav" aria-label="Sections">
      {sections.map(([id, name]) => (
        <a key={id} href={`#${id}`}>
          {name}
        </a>
      ))}
    </nav>
  );
}

/** Self-check questions: pick an answer to see whether it is right and why. Nothing is stored or sent. */
export function Quiz({ questions }: { questions: QuizQuestion[] }) {
  const [picked, setPicked] = useState<Record<number, number>>({});
  const score = questions.filter((q, i) => picked[i] === q.answer).length;
  return (
    <div className="card cs-quiz">
      <ol>
        {questions.map((q, i) => (
          <li key={q.q}>
            <span className="small muted">Week {q.week}. </span>
            {q.q}
            <div className="cs-opts" role="group" aria-label={`Answers to question ${i + 1}`}>
              {q.options.map((o, j) => {
                const chosen = picked[i] === j;
                const cls = chosen ? (j === q.answer ? ' right' : ' wrong') : '';
                return (
                  <button
                    key={o}
                    type="button"
                    className={`btn small cs-opt${cls}`}
                    aria-pressed={chosen}
                    onClick={() => setPicked((p) => ({ ...p, [i]: j }))}
                  >
                    {o}
                  </button>
                );
              })}
            </div>
            {picked[i] !== undefined && (
              <p className="small" aria-live="polite">
                <b className={picked[i] === q.answer ? 'cs-good' : 'cs-bad'}>
                  {picked[i] === q.answer ? 'Right.' : 'Not quite.'}
                </b>{' '}
                {q.why}
              </p>
            )}
          </li>
        ))}
      </ol>
      <p className="small muted">
        {score} of {questions.length} right so far.
      </p>
    </div>
  );
}

/** The closing list of lab pages that use the ideas on this page. */
export function WhereUsed({ links }: { links: [string, string, string][] }) {
  return (
    <section id="where" className="cs-section">
      <h2>Where this is used in the lab</h2>
      <ul>
        {links.map(([to, name, what]) => (
          <li key={to}>
            <Link to={to}>{name}</Link>: {what}
          </li>
        ))}
      </ul>
    </section>
  );
}
