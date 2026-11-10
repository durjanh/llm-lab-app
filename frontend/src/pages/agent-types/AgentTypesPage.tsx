import { AGENT_TYPES, type Example } from './catalog';
import './agent-types.css';

function ExampleItem({ ex }: { ex: Example }) {
  const label = ex.href ? <a href={ex.href}>{ex.label}</a> : <code>{ex.label}</code>;
  return (
    <li>
      {label}
      {ex.isNew && <span className="at-new">new</span>}
      {ex.run && <pre>{ex.run}</pre>}
    </li>
  );
}

/** Lab 50: the thirteen common types of agent, what each is for, and a working example of every one in this lab. */
export default function AgentTypesPage() {
  return (
    <main className="page-agent-types">
      <div className="kicker">Lab 50 · Agent types</div>
      <h1>Thirteen types of agent, and where each one is built</h1>
      <p className="lede">
        People sort agents into types: reflex, tool-using, planning, memory, multi-agent and so on. The types overlap. A
        coding agent is also a tool-using, planning and autonomous agent. What separates them is the part that does the
        deciding and what it is allowed to remember and touch. Each type below has a working example in this lab, with
        what it shows and how to run it.
      </p>
      <p className="small muted">
        Commands run from the repository root with the virtual environment active. Every script prints what it sent,
        what came back and an estimated cost; most cost under a cent on Haiku. The reflex agent costs nothing without
        <code>--compare</code>. The browsing and computer use agents need Chrome and <code>pip install websockets</code>
        .
      </p>

      <section>
        <h2>At a glance</h2>
        <div className="table-wrap">
          <table className="t">
            <thead>
              <tr>
                <th>Type</th>
                <th>How it works</th>
                <th>Best for</th>
                <th>Not for</th>
              </tr>
            </thead>
            <tbody>
              {AGENT_TYPES.map((t) => (
                <tr key={t.id}>
                  <td>
                    <a href={`#${t.id}`}>{t.name}</a>
                  </td>
                  <td>{t.how}</td>
                  <td>{t.bestFor}</td>
                  <td>{t.notFor}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2>The examples</h2>
        <div className="at-grid">
          {AGENT_TYPES.map((t, i) => (
            <article className="card at-card" id={t.id} key={t.id}>
              <h3>
                <span className="at-num">{i + 1}</span>
                {t.name}
              </h3>
              <p className="small">{t.shows}</p>
              <ul className="at-examples">
                {t.examples.map((ex) => (
                  <ExampleItem ex={ex} key={ex.label} />
                ))}
              </ul>
            </article>
          ))}
        </div>
      </section>

      <section>
        <h2>Choosing</h2>
        <p>
          Start with the simplest type that does the job. If fixed rules cover every case, a reflex agent is faster,
          cheaper and fully predictable. Add a model when the input varies, tools when it must act, a plan when there
          are several steps worth checking first, and memory only when repeating yourself is the problem. Browsing and
          computer use are for software with no API: they are slow and see everything on the page, so keep them behind
          an allowlist and ask a person before anything that cannot be undone. Whatever the type, the limits belong in
          code, not in the prompt: the examples here check budgets, addresses, sensitive data and allowed sites in the
          tools themselves.
        </p>
      </section>
    </main>
  );
}
