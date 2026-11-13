import {
  CHECKED,
  CONTEXT_RULES,
  DATA_RULES,
  ESCALATE,
  ETHICS,
  FEATURES,
  FORMATS,
  GOOD_USES,
  MODELS,
  MODEL_TASKS,
  POOR_USES,
  PROJECT_STEPS,
  SAME_INSTRUCTION,
  SOURCES,
  STAKEHOLDER,
  SURFACES,
} from './content';
import { Audiences, CheckAnswer, TaskTypes, UseCase, useModels } from './Tools';
import './claude-at-work.css';

const NAV: [string, string][] = [
  ['features', 'Features'],
  ['models', 'Models'],
  ['context', 'Context'],
  ['formats', 'Formats'],
  ['surfaces', 'Surfaces'],
  ['governance', 'Responsible use'],
  ['stakeholders', 'Stakeholders'],
  ['task-types', 'Task types'],
  ['audiences', 'Audiences'],
  ['check', 'Check an answer'],
  ['use-case', 'Good use?'],
  ['sources', 'Sources'],
];

const Pairs = ({ rows }: { rows: string[][] }) => (
  <ul className="aw-list">
    {rows.map(([a, b]) => (
      <li key={a}>
        <b>{a}.</b> {b}
      </li>
    ))}
  </ul>
);

/** Claude at work: the product skills for the Associate exam, with live practice at the judgement parts. */
export default function ClaudeAtWorkPage() {
  const picker = useModels();
  return (
    <main className="page-claude-at-work">
      <div className="kicker">Claude Certified Associate · Claude at work</div>
      <h1>Claude at work</h1>
      <p className="lede">
        The rest of this lab is for developers. This page is for people who use Claude in the apps for operations,
        marketing, project work, teaching or communications, with no code. It explains which feature fits which job,
        then lets you practise the judgement parts: prompting by task type, writing for an audience, checking an answer
        before you send it, and deciding whether a task is a good use of Claude at all.
      </p>
      <nav className="aw-nav small">
        {NAV.map(([id, label]) => (
          <a key={id} href={`#${id}`}>
            {label}
          </a>
        ))}
      </nav>

      <section id="features">
        <h2>Which feature for which job</h2>
        <div className="table-wrap">
          <table className="t">
            <thead>
              <tr>
                <th>Feature</th>
                <th>Use it for</th>
                <th>How it works</th>
                <th>Worked example</th>
              </tr>
            </thead>
            <tbody>
              {FEATURES.map((f) => (
                <tr key={f.name}>
                  <td>
                    <b>{f.name}</b>
                  </td>
                  <td>{f.job}</td>
                  <td>{f.how}</td>
                  <td>{f.example}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <h3>Setting up a Project</h3>
        <ol className="aw-list">
          {PROJECT_STEPS.map(([a, b]) => (
            <li key={a}>
              <b>{a}.</b> {b}
            </li>
          ))}
        </ol>
        <p className="small muted">
          Projects are on all plans (the free plan allows five). Sharing is for Team and Enterprise. Plans and limits
          change, so check the pages in Sources.
        </p>
      </section>

      <section id="models">
        <h2>Matching the model to the task</h2>
        <p>
          Anthropic describes each model by speed, intelligence and price. Cheaper and faster is right when the task is
          simple or repeated. Pay for a larger model when a mistake is costly or the reasoning is long.
        </p>
        <div className="table-wrap">
          <table className="t">
            <thead>
              <tr>
                <th>Model</th>
                <th>Speed</th>
                <th>API price per million tokens (input / output)</th>
                <th>Anthropic's description</th>
              </tr>
            </thead>
            <tbody>
              {MODELS.map((m) => (
                <tr key={m.id}>
                  <td>
                    <b>{m.id}</b>
                  </td>
                  <td>{m.speed}</td>
                  <td>{m.price}</td>
                  <td>{m.best}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="small muted">Prices are the API's. Which models you can pick in the apps depends on your plan.</p>
        <h3>An example</h3>
        <div className="table-wrap">
          <table className="t">
            <thead>
              <tr>
                <th>Task</th>
                <th>Model</th>
                <th>Why</th>
              </tr>
            </thead>
            <tbody>
              {MODEL_TASKS.map(([a, b, c]) => (
                <tr key={a}>
                  <td>{a}</td>
                  <td>{b}</td>
                  <td>{c}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="small muted">
          The task-to-model pairings are this lab's suggestions, not Anthropic's rules. Try the cheaper model on a
          sample and compare.
        </p>
      </section>

      <section id="context">
        <h2>Context limits and memory</h2>
        <p>
          The context window is everything Claude can look at while it answers: your messages, its replies, and any
          files. On the API the current models take up to 1 million tokens. The apps manage the window for you and can
          drop older material, so very long chats can lose early detail.
        </p>
        <Pairs rows={CONTEXT_RULES} />
      </section>

      <section id="formats">
        <h2>Choosing an output format</h2>
        <div className="table-wrap">
          <table className="t">
            <thead>
              <tr>
                <th>Format</th>
                <th>Choose it when</th>
                <th>Example</th>
              </tr>
            </thead>
            <tbody>
              {FORMATS.map((f) => (
                <tr key={f.name}>
                  <td>
                    <b>{f.name}</b>
                  </td>
                  <td>{f.use}</td>
                  <td>{f.example}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="small muted">
          Rule of thumb: people read tables, programs read JSON, and anything you will edit or share belongs in an
          artifact or file. Say the format in your prompt.
        </p>
      </section>

      <section id="surfaces">
        <h2>The same instruction in different places</h2>
        <div className="table-wrap">
          <table className="t">
            <thead>
              <tr>
                <th>Where</th>
                <th>What Claude reads</th>
                <th>What Anthropic publishes</th>
              </tr>
            </thead>
            <tbody>
              {SURFACES.map((s) => (
                <tr key={s.place}>
                  <td>
                    <b>{s.place}</b>
                  </td>
                  <td>{s.reads}</td>
                  <td>{s.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <h3>Where to put {SAME_INSTRUCTION.instruction}</h3>
        <Pairs rows={SAME_INSTRUCTION.rows} />
      </section>

      <section id="governance">
        <h2>Responsible use</h2>
        <div className="aw-cols">
          <div className="card">
            <h3>Good uses</h3>
            <ul className="aw-list">
              {GOOD_USES.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          </div>
          <div className="card">
            <h3>Poor uses</h3>
            <ul className="aw-list">
              {POOR_USES.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          </div>
        </div>
        <h3>Data sensitivity and regulation</h3>
        <ul className="aw-list">
          {DATA_RULES.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
        <h3>When to escalate</h3>
        <Pairs rows={ESCALATE} />
        <h3>Ethics</h3>
        <Pairs rows={ETHICS} />
      </section>

      <section id="stakeholders">
        <h2>Explaining Claude to stakeholders</h2>
        <Pairs rows={STAKEHOLDER} />
      </section>

      <h2 className="aw-live">Practise it live</h2>
      <p className="small muted">These tools make paid calls through the lab backend. Pick the model for each.</p>

      <section id="task-types">
        <h2>Prompt by task type</h2>
        <p>
          A good prompt has a role, context, a task, constraints and an output format. What goes in each depends on the
          kind of task. Run one goal under two task types to see how the approach changes.
        </p>
        <TaskTypes p={picker} />
      </section>

      <section id="audiences">
        <h2>Rewrite for an audience</h2>
        <p>The facts stay the same. Length, vocabulary, order and tone change with the reader.</p>
        <Audiences p={picker} />
      </section>

      <section id="check">
        <h2>Check an answer</h2>
        <CheckAnswer p={picker} />
      </section>

      <section id="use-case">
        <h2>Is this a good use?</h2>
        <UseCase p={picker} />
      </section>

      <section id="sources">
        <h2>Sources</h2>
        <p className="small muted">
          Facts about the Claude apps on this page were read on these Anthropic pages and checked on {CHECKED}. Anything
          I could not confirm there is left out.
        </p>
        <ul className="aw-list">
          {SOURCES.map(([title, url]) => (
            <li key={url}>
              <a href={url} target="_blank" rel="noreferrer">
                {title}
              </a>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
