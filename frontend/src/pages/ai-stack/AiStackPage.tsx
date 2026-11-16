import { useState } from 'react';
import { AREAS, STATUS, type Status } from './stack';
import './ai-stack.css';

/* A common "AI tech stack" chart, mapped to the lab: for each tool, whether it runs on a lab page, runs as an example
   in examples/stack/ or examples/sdks/, has full code that waits for an account or key, or is only explained. */

const ORDER: Status[] = ['lab', 'example', 'needs', 'explained'];

export default function AiStackPage() {
  const [only, setOnly] = useState<Status | null>(null);
  const all = AREAS.flatMap((a) => a.tools);
  const count = (s: Status) => all.filter((t) => t.status === s).length;
  return (
    <main className="page-ai-stack">
      <div className="kicker">Map · The AI tech stack</div>
      <h1>The AI tech stack, mapped to the lab</h1>
      <p className="lede">
        A widely shared chart of AI tools has {all.length} entries in eleven areas, from model providers to vector
        databases. This page says where each one is in the lab. Most areas have one example per tool in{' '}
        <code>examples/stack/</code>, every tool in an area doing the same task on the same data (the lab&apos;s
        invented Northwind handbook and its 12 gold questions), so they can be compared line for line.
      </p>
      <div className="as-filter" role="group" aria-label="Show">
        <button type="button" className={`btn small${only === null ? ' primary' : ''}`} onClick={() => setOnly(null)}>
          All ({all.length})
        </button>
        {ORDER.map((s) => (
          <button
            key={s}
            type="button"
            className={`btn small${only === s ? ' primary' : ''}`}
            aria-pressed={only === s}
            onClick={() => setOnly(only === s ? null : s)}
          >
            <span className={`as-dot ${s}`} aria-hidden="true" /> {STATUS[s].label} ({count(s)})
          </button>
        ))}
      </div>
      <p className="small muted">
        {ORDER.map((s) => (
          <span key={s} className="as-legend">
            <b>{STATUS[s].label}:</b> {STATUS[s].means}.{' '}
          </span>
        ))}
      </p>
      <div className="as-grid">
        {AREAS.map((a) => {
          const tools = a.tools.filter((t) => !only || t.status === only);
          if (!tools.length) return null;
          return (
            <section key={a.name} className="as-area" style={{ ['--as-c' as string]: a.colour }}>
              <h2>{a.name}</h2>
              {a.folder && (
                <p className="small muted as-folder">
                  <code>{a.folder}</code>
                </p>
              )}
              <ul>
                {tools.map((t) => (
                  <li key={t.name}>
                    <span className={`as-dot ${t.status}`} title={STATUS[t.status].label} aria-hidden="true" />
                    <div>
                      <b>{t.name}</b> <span className="small muted">{STATUS[t.status].label}</span>
                      <div className="small">
                        {t.where.map(([label, href], i) => (
                          <span key={label}>
                            {i > 0 && ' · '}
                            {href ? <a href={href}>{label}</a> : <code>{label}</code>}
                          </span>
                        ))}
                      </div>
                      {t.note && <div className="small muted">{t.note}</div>}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
      <h2>Running the examples</h2>
      <p>
        Each tool folder has its own Python 3.12 virtual environment, because these packages pin conflicting versions.
        Make one with <code>python3.12 -m venv .venv &amp;&amp; .venv/bin/pip install -r requirements.txt</code> in the
        folder, then run <code>python examples/stack/run_all.py</code> (or name an area, such as <code>vector-dbs</code>
        ) from the repository root. It writes <code>examples/stack/RESULTS.md</code>. Tools that need an account print
        SKIP with exactly what to set, and run as soon as it is set. Containers bind to 127.0.0.1 and are removed after
        each run. The agent SDKs use <code>examples/sdks/run_all.py</code> instead.
      </p>
    </main>
  );
}
