import { useState } from 'react';
import { Link } from 'react-router';
import { LANES, PARTS, USE_CASES, type Part, type UseCaseId } from './data';
import { ArchIcon } from '@/components/architecture/ArchIcon';
import { InteractionDiagram } from './InteractionDiagram';
import './medassist-architecture.css';

const Icon = ArchIcon;

const useCaseName = (id: UseCaseId) => USE_CASES.find((u) => u.id === id)?.name ?? id;

function Detail({ part }: { part: Part }) {
  return (
    <div className={`arch-detail${part.core ? ' core' : ''}`}>
      <div className="arch-detail-head">
        <Icon name={part.icon} size={40} />
        <h3>{part.name}</h3>
      </div>
      <p>{part.what}</p>
      <dl>
        <dt>Used for</dt>
        <dd>{part.usedFor}</dd>
        <dt>Runs in</dt>
        <dd>{part.runs}</dd>
        <dt>Use cases</dt>
        <dd className="arch-chips">
          {part.uses.map((u) => (
            <span key={u}>{useCaseName(u)}</span>
          ))}
        </dd>
        <dt>Files</dt>
        <dd>
          <ul>
            {part.files.map((f) => (
              <li key={f}>
                <code>{f}</code>
              </li>
            ))}
          </ul>
        </dd>
      </dl>
    </div>
  );
}

/** MedAssist's whole solution as a diagram: every component, what it is for, and which use cases touch it. */
export default function MedAssistArchitecturePage() {
  const [useCase, setUseCase] = useState<UseCaseId | null>(null);
  const [selected, setSelected] = useState<string>('rules');
  const part = PARTS.find((p) => p.id === selected) ?? PARTS[0];
  const active = USE_CASES.find((u) => u.id === useCase);

  return (
    <main className="page-medassist-architecture">
      <div className="kicker">MedAssist · solution architecture</div>
      <h1>Every component, and what it is for</h1>
      <p className="lede">
        The whole MedAssist solution: the channels people use, our code, the agent engines, the practice data, Microsoft
        Foundry and the Azure services around them. The first diagram shows how the components call each other; the
        second lists every component by lane. Select a component to see what it does, where it runs and which files hold
        it. Choose a use case to follow its requests. The agent itself is on the{' '}
        <Link to="/medassist">MedAssist page</Link>.
      </p>

      <div className="arch-filter" role="group" aria-label="Use case">
        <button className={useCase === null ? 'on' : ''} onClick={() => setUseCase(null)}>
          All components
        </button>
        {USE_CASES.map((u) => (
          <button key={u.id} className={useCase === u.id ? 'on' : ''} onClick={() => setUseCase(u.id)}>
            {u.name}
          </button>
        ))}
      </div>
      <p className="arch-path small">
        {active ? (
          <>
            <b>{active.name}:</b> {active.path}
          </>
        ) : (
          'Only the clinic tools touch patient data, so the rules in them hold for every channel and engine.'
        )}
      </p>

      <h2>How the components interact</h2>
      <InteractionDiagram useCase={useCase} selected={selected} onSelect={setSelected} />
      <p className="arch-caption small">
        <b>{part.name}:</b> {part.usedFor} Its full details are beside the lanes below.
      </p>

      <h2>Every component, by lane</h2>
      <div className="arch-layout">
        <div className="arch-lanes">
          {LANES.map((lane) => (
            <section key={lane.id} className={`arch-lane lane-${lane.id}`}>
              <div className="arch-lane-head">
                {lane.icon && <Icon name={lane.icon} size={28} />}
                <div>
                  <h3>{lane.name}</h3>
                  <p className="small">{lane.note}</p>
                </div>
              </div>
              <div className="arch-parts">
                {PARTS.filter((p) => p.lane === lane.id).map((p) => {
                  const dim = useCase !== null && !p.uses.includes(useCase);
                  return (
                    <button
                      key={p.id}
                      className={`arch-part${p.core ? ' core' : ''}${dim ? ' dim' : ''}${p.id === selected ? ' sel' : ''}`}
                      onClick={() => setSelected(p.id)}
                      aria-pressed={p.id === selected}
                    >
                      <Icon name={p.icon} />
                      <span className="arch-part-name">{p.name}</span>
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
        <aside className="arch-side">
          <Detail part={part} />
        </aside>
      </div>

      <h2>Which use case uses which component</h2>
      <div className="table-wrap">
        <table className="t arch-matrix">
          <thead>
            <tr>
              <th>Component</th>
              <th>Used for</th>
              {USE_CASES.map((u) => (
                <th key={u.id} className="c">
                  {u.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {LANES.map((lane) => [
              <tr key={lane.id} className="arch-group">
                <td colSpan={2 + USE_CASES.length}>{lane.name}</td>
              </tr>,
              ...PARTS.filter((p) => p.lane === lane.id).map((p) => (
                <tr key={p.id} className={p.id === selected ? 'sel' : ''} onClick={() => setSelected(p.id)}>
                  <td>
                    <span className="arch-row-name">
                      <Icon name={p.icon} size={20} />
                      {p.name}
                    </span>
                  </td>
                  <td className="small">{p.usedFor}</td>
                  {USE_CASES.map((u) => (
                    <td key={u.id} className="c">
                      {p.uses.includes(u.id) ? (
                        <span className="arch-yes">✓ yes</span>
                      ) : (
                        <span className="faint">–</span>
                      )}
                    </td>
                  ))}
                </tr>
              )),
            ])}
          </tbody>
        </table>
      </div>

      <h2>How each use case flows</h2>
      <div className="arch-flows">
        {USE_CASES.map((u) => (
          <div key={u.id} className="card">
            <h3>{u.name}</h3>
            <p className="small">{u.path}</p>
          </div>
        ))}
      </div>
    </main>
  );
}
