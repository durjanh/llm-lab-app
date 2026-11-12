import { useState } from 'react';
import { Link } from 'react-router';
import { ArchDiagram } from '@/components/architecture/ArchDiagram';
import { ArchIcon } from '@/components/architecture/ArchIcon';
import { PARTS, VIEWS, type LabPart, type ViewId } from './data';
import { ARROWS, BOXES, GROUPS, HEADINGS, HEIGHT, LABELS, WIDTH } from './diagram';
import './lab-architecture.css';

const viewName = (id: ViewId) => VIEWS.find((v) => v.id === id)?.name ?? id;

function Detail({ part }: { part: LabPart }) {
  return (
    <div className={`la-detail${part.core ? ' core' : ''}`}>
      <div className="la-detail-head">
        <ArchIcon name={part.icon} size={40} />
        <div>
          <h3>{part.name}</h3>
          <p className="small muted">{part.where}</p>
        </div>
      </div>
      <p>{part.what}</p>
      <p>
        <b>Used for:</b> {part.usedFor}
      </p>
      <div className="la-chips">
        {part.uses.map((u) => (
          <span key={u}>{viewName(u)}</span>
        ))}
      </div>
      <ul className="la-files">
        {part.files.map((f) => (
          <li key={f}>
            <code>{f}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The whole LLM Lab as one architecture diagram: Claude, GPT, the local model, Foundry and Azure, and what calls what. */
export default function LabArchitecturePage() {
  const [view, setView] = useState<ViewId | null>(null);
  const [selected, setSelected] = useState('client');
  const part = PARTS.find((p) => p.id === selected) ?? PARTS[0];
  const active = VIEWS.find((v) => v.id === view);

  return (
    <main className="page-lab-architecture">
      <div className="kicker">LLM Lab · architecture</div>
      <h1>The whole lab, and how its parts call each other</h1>
      <p className="lede">
        Every page and script reaches a model through one client, which sends each request to Claude, to a GPT
        deployment in Microsoft Foundry, or to an open model on this machine. Foundry agents, Azure AI services and the
        phone line are reached through the backend’s gateways, all signed in with Entra ID. Select a component to see
        what it is and where it lives; choose a path to follow its requests. MedAssist on its own is on the{' '}
        <Link to="/medassist/architecture">MedAssist architecture page</Link>.
      </p>

      <div className="la-filter" role="group" aria-label="Path">
        <button className={view === null ? 'on' : ''} onClick={() => setView(null)}>
          Everything
        </button>
        {VIEWS.map((v) => (
          <button key={v.id} className={view === v.id ? 'on' : ''} onClick={() => setView(v.id)}>
            {v.name}
          </button>
        ))}
      </div>
      <p className="la-path small">
        {active ? (
          <>
            <b>{active.name}:</b> {active.path} <span className="muted">Used by: {active.examples}</span>
          </>
        ) : (
          'The navy box is the model client: one place decides whether a request goes to Claude, GPT or the local model, so no page has to know.'
        )}
      </p>

      <div className="la-layout">
        <ArchDiagram
          width={WIDTH}
          height={HEIGHT}
          label="How the LLM Lab's components interact"
          headings={HEADINGS}
          groups={GROUPS}
          boxes={BOXES}
          arrows={ARROWS}
          labels={LABELS}
          parts={PARTS}
          active={view}
          selected={selected}
          onSelect={setSelected}
        />
        <aside className="la-side">
          <Detail part={part} />
        </aside>
      </div>

      <h2>Three ways to reach a model</h2>
      <div className="table-wrap">
        <table className="t">
          <thead>
            <tr>
              <th>Path</th>
              <th>Where it runs</th>
              <th>How the lab reaches it</th>
              <th>What it cannot do</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <b>Claude</b>
              </td>
              <td>Anthropic’s cloud: Haiku 5.5 (default), Sonnet 5.5, Opus 5.5</td>
              <td>The Anthropic SDK, through the model client</td>
              <td>Nothing is refused: server tools, Files, Skills, code execution and MCP are Claude’s</td>
            </tr>
            <tr>
              <td>
                <b>GPT</b>
              </td>
              <td>Microsoft Foundry: gpt-5.4-mini, gpt-4.1-mini</td>
              <td>The same request, translated to Chat Completions by gpt_model.py, signed in with Entra ID</td>
              <td>Claude-only features are refused with a message naming Azure OpenAI</td>
            </tr>
            <tr>
              <td>
                <b>Local model</b>
              </td>
              <td>This machine, in Docker Model Runner</td>
              <td>Its Anthropic-compatible API, when LLM_LAB_LOCAL_MODEL is set; priced at zero</td>
              <td>Claude-only features, and images on models that cannot read them</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2>Every component</h2>
      <div className="table-wrap">
        <table className="t la-parts">
          <thead>
            <tr>
              <th>Component</th>
              <th>Used for</th>
              <th>Where it runs</th>
            </tr>
          </thead>
          <tbody>
            {PARTS.map((p) => (
              <tr key={p.id} className={p.id === selected ? 'sel' : ''} onClick={() => setSelected(p.id)}>
                <td>
                  <span className="la-row-name">
                    <ArchIcon name={p.icon} size={20} />
                    {p.name}
                  </span>
                </td>
                <td className="small">{p.usedFor}</td>
                <td className="small">{p.where}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
