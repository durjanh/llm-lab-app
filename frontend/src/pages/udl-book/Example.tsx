import type { BookChapter, BookExample } from './types';

/** One worked example: the book's reference, what it shows, the notebooks that cover it, and any demo. */
export function Example({ ex }: { ex: BookExample }) {
  const { Demo } = ex;
  return (
    <section id={`ex-${ex.id}`} className="ub-ex card">
      <div className="ub-ex-head">
        <span className="ub-num">{ex.id}</span>
        <h4>{ex.title}</h4>
        <span className="ub-page small muted">book p. {ex.page}</span>
      </div>
      <div className="ub-shows">{ex.shows}</div>
      {ex.notebooks && ex.notebooks.length > 0 && (
        <p className="small ub-nb">
          Interactive notebook{ex.notebooks.length > 1 ? 's' : ''}:{' '}
          {ex.notebooks.map((id, i) => (
            <span key={id}>
              {i > 0 && ', '}
              <a href={`/deep-learning#nb-${id}`}>{id}</a>
            </span>
          ))}
        </p>
      )}
      {Demo && (
        <div className="ub-demo">
          <Demo />
        </div>
      )}
    </section>
  );
}

/** One chapter: what it offers, its worked examples, where it lives in LLMs, and what research does with it next. */
export function Chapter({ ch }: { ch: BookChapter }) {
  return (
    <div id={`ch-${ch.n}`} className="ub-chapter">
      <h2>
        {ch.n}. {ch.title}
      </h2>
      <div className="ub-offers">{ch.offers}</div>
      <div className="ub-examples">
        {ch.examples.map((ex) => (
          <Example key={ex.id} ex={ex} />
        ))}
      </div>
      <div className="ub-llm-grid">
        <div className="ub-llm">
          <b>In today&apos;s LLMs</b>
          <div>{ch.inLlms}</div>
        </div>
        <div className="ub-next">
          <b>Where research takes it next</b>
          <ul>
            {ch.next.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </div>
      </div>
      {ch.labs && ch.labs.length > 0 && (
        <p className="small muted ub-labs">
          Go deeper in the lab:{' '}
          {ch.labs.map(([to, label], i) => (
            <span key={to}>
              {i > 0 && ' · '}
              <a href={to}>{label}</a>
            </span>
          ))}
        </p>
      )}
    </div>
  );
}
