import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useNavHeight } from '@/lib/useNavHeight';
import { workflowsService, type GraphShape, type WorkflowEvent } from '@/services/workflowsService';
import { CHOOSER, GROUPS, PATTERNS, RUN_MODES, type Pattern } from './catalog';
import { Diagram, type NodeState } from './Diagram';
import recordingsJson from './recordings.json';
import './workflows.css';

interface Recording {
  model: string;
  recorded: string;
  cost_usd: number;
  events: WorkflowEvent[];
}

const RECORDINGS = recordingsJson as unknown as Record<string, Recording>;
const MIN_GAP_MS = 60;
const MAX_GAP_MS = 900;

const name = (id: string) => id.replace(/_/g, ' ');

/** Which steps are lit, worked out from the events so far. */
function nodeStates(events: WorkflowEvent[], routeDriven: boolean, start: string): Record<string, NodeState> {
  const states: Record<string, NodeState> = {};
  const hasStarted = events.some((e) => e.type === 'step' || e.type === 'route');
  if (routeDriven && hasStarted) states[start] = 'active';
  for (const e of events) {
    if (e.type === 'route') {
      if (states[e.source]) states[e.source] = 'done';
      states[e.target] = 'active';
    } else if (e.type === 'step' && !routeDriven) {
      if (e.state === 'start') states[e.node] = 'active';
      if (e.state === 'done') states[e.node] = 'done';
      if (e.state === 'failed') states[e.node] = 'failed';
    } else if (e.type === 'output' && routeDriven) {
      Object.keys(states).forEach((k) => states[k] === 'active' && (states[k] = 'done'));
    }
  }
  return states;
}

function Line({ e }: { e: WorkflowEvent }) {
  const at = 'ms' in e ? <span className="wf-ms">{(e.ms / 1000).toFixed(1)}s</span> : null;
  switch (e.type) {
    case 'step':
      if (e.state === 'failed')
        return (
          <li className="bad">
            {at}
            <b>{name(e.node)} failed.</b> {e.text}
          </li>
        );
      if (e.state !== 'done' || !e.text) return null;
      return (
        <li>
          {at}
          <b>{name(e.node)}</b>
          <div className="wf-text">{e.text}</div>
        </li>
      );
    case 'route':
      return (
        <li className="route">
          {at}
          {name(e.source)} → <b>{name(e.target)}</b> <span className="muted">({e.how})</span>
        </li>
      );
    case 'ledger':
      return (
        <li>
          {at}
          <details>
            <summary>Manager&apos;s ledger: {e.kind.replace(/_/g, ' ')}</summary>
            <div className="wf-text">{e.text}</div>
          </details>
        </li>
      );
    case 'note':
      return (
        <li className="note">
          {at}
          {e.text}
        </li>
      );
    case 'ask':
      return (
        <li className="ask">
          {at}
          <b>Waiting for a person</b>
          <div className="wf-text">{e.question}</div>
        </li>
      );
    case 'answered':
      return (
        <li className="note">
          {at}
          {e.approved ? 'A person approved it.' : 'A person rejected it.'}
        </li>
      );
    case 'output':
      return e.text ? (
        <li className="output">
          {at}
          <b>Result</b>
          <div className="wf-text">{e.text}</div>
        </li>
      ) : null;
    default:
      return null;
  }
}

function Card({ p }: { p: Pattern }) {
  const rec = RECORDINGS[p.id];
  const recordedTask = rec.events.find((e) => e.type === 'task');
  const defaultTask = recordedTask?.type === 'task' ? recordedTask.task : '';
  const graph = rec.events.find((e) => e.type === 'graph') as unknown as GraphShape;
  const recordedUsage = rec.events.find((e) => e.type === 'usage');

  const [task, setTask] = useState(defaultTask);
  const [events, setEvents] = useState<WorkflowEvent[]>([]);
  const [mode, setMode] = useState<'idle' | 'replay' | 'live'>('idle');
  const [source, setSource] = useState<'replay' | 'live' | null>(null);
  const [approval, setApproval] = useState<{ id: string; question: string } | null>(null);
  const [error, setError] = useState('');
  const [final, setFinal] = useState<{ cost: number; input: number; output: number } | null>(null);
  const timer = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const runId = useRef('');

  useEffect(
    () => () => {
      clearTimeout(timer.current);
      abort.current?.abort();
    },
    [],
  );

  const states = useMemo(() => nodeStates(events, !!p.routeDriven, graph.start), [events, p.routeDriven, graph.start]);

  const reset = (next: 'replay' | 'live') => {
    clearTimeout(timer.current);
    abort.current?.abort();
    setEvents([]);
    setError('');
    setFinal(null);
    setApproval(null);
    setMode(next);
    setSource(next);
  };

  const replay = () => {
    reset('replay');
    const steps = rec.events.filter((e) => e.type !== 'task' && e.type !== 'graph');
    let i = 0;
    const next = () => {
      const e = steps[i++];
      if (!e) {
        setMode('idle');
        if (recordedUsage?.type === 'usage')
          setFinal({ cost: rec.cost_usd, input: recordedUsage.input_tokens, output: recordedUsage.output_tokens });
        return;
      }
      setEvents((all) => [...all, e]);
      const after = steps[i];
      const gap = after && 'ms' in after && 'ms' in e ? after.ms - e.ms : MIN_GAP_MS;
      timer.current = window.setTimeout(next, Math.min(MAX_GAP_MS, Math.max(MIN_GAP_MS, gap)));
    };
    next();
  };

  const live = async () => {
    reset('live');
    const controller = new AbortController();
    abort.current = controller;
    try {
      await workflowsService.run(
        p.id,
        task.trim() || undefined,
        (e) => {
          if (e.type === 'run') runId.current = e.run_id;
          else if (e.type === 'approval') setApproval({ id: e.id, question: e.input.question });
          else if (e.type === 'approval_done') setApproval(null);
          else if (e.type === 'final') setFinal({ cost: e.cost_usd, input: e.input_tokens, output: e.output_tokens });
          else if (e.type === 'error') setError(e.message);
          else setEvents((all) => [...all, e]);
        },
        controller.signal,
      );
    } catch (err) {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!controller.signal.aborted) setMode('idle');
    }
  };

  const answer = (allow: boolean) => {
    if (!approval) return;
    workflowsService.approve(runId.current, approval.id, allow).catch((err: Error) => setError(err.message));
    setApproval(null);
  };

  return (
    <article id={p.id} className="wf-card card">
      <h3>{p.title}</h3>
      {p.aka && <p className="wf-aka">Also called: {p.aka}</p>}
      <p>{p.what}</p>
      <div className="wf-when">
        <div>
          <b>Use it when</b> {p.use}
        </div>
        <div>
          <b>Avoid it when</b> {p.avoid}
        </div>
      </div>
      <Diagram graph={graph} states={states} />
      <details className="wf-code">
        <summary>
          The code: <span className="mono">examples/agent-framework/workflows/{p.file}</span>
        </summary>
        <pre>{p.code}</pre>
      </details>
      <label className="wf-task">
        <span className="small muted">Task for a live run</span>
        <textarea value={task} rows={2} maxLength={2000} onChange={(e) => setTask(e.target.value)} />
      </label>
      <div className="wf-actions">
        <button className="btn primary" onClick={replay} disabled={mode !== 'idle'}>
          Replay the recorded run
        </button>
        <button className="btn" onClick={() => void live()} disabled={mode !== 'idle'}>
          Run it live on Azure
        </button>
        <span className="small muted">
          Replay is free and shows real output from {rec.recorded}, on the task above as first set. A live run cost
          about ${rec.cost_usd.toFixed(rec.cost_usd < 0.01 ? 4 : 3)}.
        </span>
      </div>
      {approval && (
        <div className="wf-approval">
          <b>The workflow has stopped and is waiting for you.</b>
          <div className="wf-text">{approval.question}</div>
          <button className="btn primary" onClick={() => answer(true)}>
            Approve
          </button>{' '}
          <button className="btn" onClick={() => answer(false)}>
            Reject
          </button>
        </div>
      )}
      {error && <p className="wf-error">{error}</p>}
      {events.length > 0 && (
        <ol className="wf-log" aria-live="polite">
          {events.map((e, i) => (
            <Line key={i} e={e} />
          ))}
        </ol>
      )}
      {final && (
        <p className="small muted">
          {source === 'replay' ? 'That recording used' : 'This run used'} {final.input.toLocaleString('en-GB')} tokens
          in and {final.output.toLocaleString('en-GB')} out, ${final.cost.toFixed(4)}.
        </p>
      )}
    </article>
  );
}

/** Every type of multi-agent workflow, each a real Agent Framework program you can replay for free or run live. */
export default function WorkflowsPage() {
  const navHeight = useNavHeight();
  return (
    <main className="page-workflows" style={{ '--nav-h': `${navHeight}px` } as CSSProperties}>
      <div className="kicker">Lab 48 · Multi-agent workflows</div>
      <h1>Every kind of agent workflow, and when to use each</h1>
      <p className="lede">
        Thirteen real programs on Microsoft Agent Framework and Azure OpenAI, covering the orchestrations in
        Microsoft&apos;s design patterns guide, the graph edges beneath them, and pausing, resuming, nesting and YAML
        workflows. Each diagram is read from the built workflow. Replay a recorded run for free, or run it live with
        your own task.
      </p>
      <p className="small muted">
        Guidance follows Microsoft&apos;s{' '}
        <a
          href="https://learn.microsoft.com/azure/architecture/ai-ml/guide/ai-agent-design-patterns"
          target="_blank"
          rel="noreferrer"
        >
          AI agent orchestration patterns
        </a>{' '}
        and{' '}
        <a href="https://learn.microsoft.com/agent-framework/workflows/" target="_blank" rel="noreferrer">
          Agent Framework workflows
        </a>
        . Start with the simplest thing that works: most tasks need no orchestration at all.
      </p>
      <div className="wf-layout">
        <nav className="wf-toc" aria-label="Contents">
          <a href="#choose">Which should I use?</a>
          <a href="#modes">Run modes</a>
          {GROUPS.map((g) => (
            <div key={g}>
              <b>{g}</b>
              {PATTERNS.filter((p) => p.group === g).map((p) => (
                <a key={p.id} href={`#${p.id}`}>
                  {p.title}
                </a>
              ))}
            </div>
          ))}
        </nav>
        <div>
          <section id="choose" className="wf-section">
            <h2>Which should I use?</h2>
            <table className="t">
              <thead>
                <tr>
                  <th>If…</th>
                  <th>Use</th>
                </tr>
              </thead>
              <tbody>
                {CHOOSER.map(([when, what, id]) => (
                  <tr key={when}>
                    <td>{when}</td>
                    <td>{id ? <a href={`#${id}`}>{what}</a> : what}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <section id="modes" className="wf-section">
            <h2>Run modes, as in Claude Code</h2>
            <p className="muted">How much a person is involved is a separate choice from the shape of the workflow.</p>
            <table className="t">
              <thead>
                <tr>
                  <th>Mode</th>
                  <th>What happens</th>
                  <th>In the lab</th>
                </tr>
              </thead>
              <tbody>
                {RUN_MODES.map(([mode, what, where, to]) => (
                  <tr key={mode}>
                    <td>
                      <b>{mode}</b>
                    </td>
                    <td>{what}</td>
                    <td>
                      <a href={to}>{where}</a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          {GROUPS.map((g) => (
            <section key={g} className="wf-section">
              <h2>{g}</h2>
              {PATTERNS.filter((p) => p.group === g).map((p) => (
                <Card key={p.id} p={p} />
              ))}
            </section>
          ))}
        </div>
      </div>
    </main>
  );
}
