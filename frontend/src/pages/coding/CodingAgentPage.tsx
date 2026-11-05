import { Fragment, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  codingService as svc,
  type CodingEvent,
  type CodingInfo,
  type CodingMode,
  type CodingState,
  type CodingTodo,
  type CodingWorkspace,
  type ShotImage,
} from '@/services';
import './coding.css';

const MODELS = ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5']; // until /info says which GPT deployments exist
const MODE_LABEL: Record<CodingMode, string> = {
  default: 'Ask before edits',
  accept_edits: 'Accept edits',
  plan: 'Plan (read only)',
  bypass: 'Bypass (deny rules still apply)',
  auto: 'Auto (sandboxed, never asks)',
};
const TASK_LABEL: Record<string, string> = {
  fix: 'Fix the failing tests',
  feature: 'Add a CLI report',
  plan: 'Plan monthly budgets',
  cleanup: 'A destructive request (refused)',
  page: 'Build a chart page and check it by eye',
  analyse: 'Summarise the data, with charts',
  deck: 'Make a PowerPoint from the data',
  excel: 'Export to Excel, with no Excel library',
};

type Item =
  | { kind: 'user'; text: string; sdk: boolean }
  | { kind: 'text'; text: string; depth: number }
  | { kind: 'note'; text: string; depth: number }
  | {
      kind: 'tool';
      id: string;
      name: string;
      input: Record<string, unknown>;
      depth: number;
      diff?: string;
      result?: string;
      error?: boolean;
      images?: ShotImage[];
      approval?: { reason: string; state: 'waiting' | 'allowed' | 'denied' | 'timed out'; runId: string };
    }
  | { kind: 'final'; text: string };

interface Totals {
  turns: number;
  cost: number;
  seconds?: number;
  tools: number;
}

/** **bold** and `code` from the agent's markdown; the rest as plain text with its line breaks. */
function rich(text: string): ReactNode {
  return text
    .split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
    .map((p, i) =>
      p.startsWith('**') ? (
        <strong key={i}>{p.slice(2, -2)}</strong>
      ) : p.startsWith('`') ? (
        <code key={i}>{p.slice(1, -1)}</code>
      ) : (
        <Fragment key={i}>{p}</Fragment>
      ),
    );
}

function Diff({ text }: { text: string }) {
  if (!text) return <p className="small muted">No changes.</p>;
  return (
    <pre className="cg-diff">
      {text.split('\n').map((l, i) => (
        <span
          key={i}
          className={
            l.startsWith('+++') || l.startsWith('---')
              ? 'f'
              : l.startsWith('+')
                ? 'a'
                : l.startsWith('-')
                  ? 'd'
                  : l.startsWith('@@')
                    ? 'h'
                    : ''
          }
        >
          {l + '\n'}
        </span>
      ))}
    </pre>
  );
}

const IMAGE = /\.(png|jpe?g|gif|webp)$/i;

/** What a step did, in plain words, for the hand-built tools and Claude Code's alike. */
function verb(name: string, input: Record<string, unknown>): string {
  const command = String(input.command ?? '');
  const path = String(input.path ?? input.file_path ?? '');
  switch (name) {
    case 'read_file':
    case 'Read':
      return IMAGE.test(path) ? 'Looked at' : 'Read';
    case 'write_file':
    case 'Write':
      return 'Wrote';
    case 'edit_file':
    case 'Edit':
      return 'Edited';
    case 'glob':
    case 'Glob':
      return 'Listed files';
    case 'grep':
    case 'Grep':
      return 'Searched for';
    case 'bash':
    case 'Bash':
      return /(^|&&|;|\s)(pip|python -m pip)\s+install/.test(command)
        ? 'Installed'
        : /\bunittest|pytest\b/.test(command)
          ? 'Ran the tests'
          : /soffice|pdftoppm/.test(command)
            ? 'Rendered'
            : 'Ran';
    case 'screenshot':
    case 'mcp__lab__screenshot':
      return 'Looked at';
    case 'todo_write':
    case 'TodoWrite':
      return 'Updated the to-do list';
    case 'explore':
    case 'Task':
      return 'Asked the explorer';
    default:
      return name;
  }
}

/** The one-line summary of a call: the command, the path, or the pattern. */
const brief = (name: string, input: Record<string, unknown>) =>
  String(input.command ?? input.path ?? input.file_path ?? input.pattern ?? input.task ?? '')
    .replace(/^\/.*?\/project\//, '') // the SDK sends absolute paths
    .slice(0, 120) || (name === 'todo_write' || name === 'TodoWrite' ? '' : '');

export default function CodingAgentPage() {
  const [info, setInfo] = useState<CodingInfo | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [draft, setDraft] = useState('');
  const [mode, setMode] = useState<CodingMode>('default');
  const [model, setModel] = useState(MODELS[0]);
  const [sdk, setSdk] = useState(false);
  const [workspace, setWorkspace] = useState<CodingWorkspace>('practice');
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [todos, setTodos] = useState<CodingTodo[]>([]);
  const [state, setState] = useState<CodingState | null>(null);
  const [sdkDiff, setSdkDiff] = useState('');
  const [tab, setTab] = useState<'changes' | 'files'>('changes');
  const [file, setFile] = useState<{ path: string; content: string; image?: string } | null>(null);
  const [context, setContext] = useState<{ input: number; cached: number } | null>(null);
  const [last, setLast] = useState<{ own?: Totals; sdk?: Totals }>({});
  const session = useRef<string | undefined>(undefined);
  const runId = useRef('');
  const toolCount = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    svc
      .info()
      .then((i) => {
        setInfo(i);
        setDraft(i.tasks.fix);
      })
      .catch((e: Error) => setError(e.message));
    return () => abort.current?.abort();
  }, []);
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [items, busy]);

  const updateTool = (id: string, change: (t: Extract<Item, { kind: 'tool' }>) => Partial<Item>) =>
    setItems((xs) => xs.map((x) => (x.kind === 'tool' && x.id === id ? ({ ...x, ...change(x) } as Item) : x)));

  function onEvent(e: CodingEvent, viaSdk: boolean, started: number) {
    switch (e.type) {
      case 'run':
        runId.current = e.run_id;
        break;
      case 'session':
        if (e.session_id) session.current = e.session_id;
        break;
      case 'init':
        setItems((xs) => [...xs, { kind: 'note', depth: 0, text: `Claude Code started: ${e.tools.join(', ')}` }]);
        break;
      case 'turn':
        if (e.depth === 0) setContext({ input: e.input_tokens + e.cache_read + e.cache_write, cached: e.cache_read });
        break;
      case 'text':
        setItems((xs) => [...xs, { kind: 'text', text: e.text, depth: e.depth }]);
        break;
      case 'tool_use':
        toolCount.current += 1;
        setItems((xs) =>
          xs.some((x) => x.kind === 'tool' && x.id === e.id)
            ? xs
            : [...xs, { kind: 'tool', id: e.id, name: e.name, input: e.input, depth: e.depth }],
        );
        break;
      case 'diff':
        updateTool(e.id, () => ({ diff: e.diff }));
        break;
      case 'approval':
        setItems((xs) =>
          xs.some((x) => x.kind === 'tool' && x.id === e.id)
            ? xs.map((x) =>
                x.kind === 'tool' && x.id === e.id
                  ? { ...x, approval: { reason: e.reason, state: 'waiting', runId: runId.current } }
                  : x,
              )
            : [
                ...xs,
                {
                  kind: 'tool',
                  id: e.id,
                  name: e.name,
                  input: e.input,
                  depth: 0,
                  approval: { reason: e.reason, state: 'waiting', runId: runId.current },
                },
              ],
        );
        break;
      case 'approval_done':
        updateTool(e.id, (t) => ({
          approval: t.approval && {
            ...t.approval,
            state: e.allow ? 'allowed' : e.timed_out ? 'timed out' : 'denied',
          },
        }));
        break;
      case 'result':
        updateTool(e.id, () => ({ result: e.content, error: e.is_error, images: e.images }));
        break;
      case 'todos':
        setTodos(e.todos);
        break;
      case 'checkpoint':
        if (session.current) void svc.state(session.current).then(setState);
        break;
      case 'installed':
        setItems((xs) => [
          ...xs,
          {
            kind: 'note',
            depth: 0,
            text:
              'Recorded for later sessions: ' +
              Object.entries(e.packages)
                .map(([k, v]) => `${k} ${v.join(', ')}`)
                .join('; ') +
              e.note,
          },
        ]);
        break;
      case 'stop_check':
        setItems((xs) => [
          ...xs,
          {
            kind: 'note',
            depth: 0,
            text: e.passed
              ? `Stop check: ${e.command} passes, so the agent may finish`
              : `Stop check: ${e.command} fails, so the agent is sent back to work`,
          },
        ]);
        break;
      case 'cleared':
        setItems((xs) => [
          ...xs,
          {
            kind: 'note',
            depth: 0,
            text: `Cleared ${e.count} old tool results at ${e.tokens.toLocaleString('en-GB')} tokens`,
          },
        ]);
        break;
      case 'agent_start':
        setItems((xs) => [
          ...xs,
          { kind: 'note', depth: e.depth, text: `explore starts with an empty context: ${e.task}` },
        ]);
        break;
      case 'agent_end':
        setItems((xs) => [...xs, { kind: 'note', depth: e.depth, text: 'explore reports back' }]);
        break;
      case 'final': {
        const seconds = e.seconds ?? (performance.now() - started) / 1000;
        const totals = { turns: e.turns, cost: e.cost ?? 0, seconds, tools: toolCount.current };
        const outcome = e.outcome === 'done' || e.outcome === 'success' ? 'Finished' : e.outcome;
        setItems((xs) => [
          ...xs,
          {
            kind: 'final',
            text: `${outcome} · ${e.turns} turns · ${seconds.toFixed(0)} s · $${totals.cost.toFixed(4)}`,
          },
        ]);
        setLast((l) => ({ ...l, [viaSdk ? 'sdk' : 'own']: totals }));
        if (e.state) setState(e.state);
        if (viaSdk) setSdkDiff(e.diff ?? '');
        break;
      }
      case 'error':
        setError(e.message);
        break;
    }
  }

  async function send(prompt: string) {
    if (!prompt.trim() || busy) return;
    setBusy(true);
    setError('');
    const viaSdk = sdk;
    setItems((xs) => [...xs, { kind: 'user', text: prompt, sdk: viaSdk }]);
    const ctl = new AbortController();
    abort.current = ctl;
    const started = performance.now();
    toolCount.current = 0;
    try {
      if (viaSdk) await svc.sdkRun({ prompt, mode, model }, (e) => onEvent(e, true, started), ctl.signal);
      else
        await svc.run(
          { prompt, mode, model, session_id: session.current },
          (e) => onEvent(e, false, started),
          ctl.signal,
        );
    } catch (e) {
      if (!ctl.signal.aborted) setError((e as Error).message);
    } finally {
      setBusy(false);
      if (ctl.signal.aborted) setItems((xs) => [...xs, { kind: 'note', depth: 0, text: 'Stopped by you.' }]);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void send(draft);
    setDraft('');
  }

  /** The session for Your files is made before the first request, so files can go into it. */
  async function sessionForFiles(): Promise<string> {
    if (session.current) return session.current;
    const st = await svc.create('files');
    session.current = st.session_id;
    setState(st);
    return st.session_id;
  }

  async function addFiles(files: FileList | null) {
    if (!files?.length) return;
    try {
      const sid = await sessionForFiles();
      for (const f of Array.from(files)) {
        setState(await svc.addFile(sid, f));
        setItems((xs) => [...xs, { kind: 'note', depth: 0, text: `You added inputs/${f.name}` }]);
      }
      setTab('files');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  async function addSample() {
    try {
      setState(await svc.addSample(await sessionForFiles()));
      setItems((xs) => [...xs, { kind: 'note', depth: 0, text: `You added inputs/${info?.sample ?? 'the sample'}` }]);
      setTab('files');
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function chooseWorkspace(w: CodingWorkspace) {
    newSession();
    setWorkspace(w);
    if (w === 'files') {
      setSdk(false); // files are added to hand-built sessions
      if (info?.sandbox) setMode('auto');
    }
    const first = info?.workspaces[w]?.[0];
    if (first && info) setDraft(info.tasks[first]);
  }

  function newSession() {
    abort.current?.abort();
    session.current = undefined;
    setItems([]);
    setTodos([]);
    setState(null);
    setSdkDiff('');
    setFile(null);
    setContext(null);
    setError('');
  }

  async function answer(id: string, run: string, allow: boolean) {
    try {
      await svc.approve(run, id, allow);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function undo() {
    if (!session.current) return;
    try {
      const r = await svc.undo(session.current);
      setState(r);
      setItems((xs) => [...xs, { kind: 'note', depth: 0, text: `Undid ${r.undone.tool} on ${r.undone.path}` }]);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function open(path: string) {
    if (!session.current) return;
    try {
      setFile(await svc.file(session.current, path));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const diff = sdk ? sdkDiff : (state?.diff ?? '');

  return (
    <main className="page-coding">
      <div className="kicker">Lab 46 · A coding agent, built the way Claude Code is</div>
      <h1>Build a coding agent: a harness like Claude Code</h1>
      <p className="lede">
        A small project with failing tests, and an agent that works on it: it reads the code, plans, edits, runs the
        tests and stops when they pass. It runs two ways. The hand-built harness (<code>python/19_coding_agent.py</code>
        , no framework) has file tools that refuse blind edits, a shell behind permission rules, modes, hooks,{' '}
        <code>CLAUDE.md</code>, a to-do list, checkpoints you can undo, a read-only sub-agent and context kept small.
        The same task on the <b>Claude Agent SDK</b> runs Claude Code itself, with your rules and callbacks. Every call
        shows on the left; edits wait for you unless you change the mode.
      </p>

      <div className="cg-bar">
        <div className="cg-switch" role="group" aria-label="Workspace">
          <button
            className={workspace === 'practice' ? 'on' : ''}
            onClick={() => chooseWorkspace('practice')}
            disabled={busy}
          >
            Practice project
          </button>
          <button
            className={workspace === 'files' ? 'on' : ''}
            onClick={() => chooseWorkspace('files')}
            disabled={busy}
          >
            Your files
          </button>
        </div>
        <div className="cg-switch" role="group" aria-label="Harness">
          <button className={!sdk ? 'on' : ''} onClick={() => setSdk(false)} disabled={busy}>
            Hand-built harness
          </button>
          <button
            className={sdk ? 'on' : ''}
            onClick={() => setSdk(true)}
            disabled={busy || !info?.sdk || workspace === 'files' || model.startsWith('gpt-')}
            title={
              !info?.sdk
                ? 'Install examples/claude-agent-sdk first (see below)'
                : model.startsWith('gpt-')
                  ? 'The Agent SDK runs Claude Code, which uses Claude models only'
                  : ''
            }
          >
            Agent SDK
          </button>
        </div>
        <label className="small">
          Mode{' '}
          <select value={mode} onChange={(e) => setMode(e.target.value as CodingMode)}>
            {(info?.modes ?? (Object.keys(MODE_LABEL) as CodingMode[])).map((m) => (
              <option key={m} value={m}>
                {MODE_LABEL[m]}
              </option>
            ))}
          </select>
        </label>
        <label className="small">
          Model{' '}
          <select
            value={model}
            onChange={(e) => {
              setModel(e.target.value);
              if (e.target.value.startsWith('gpt-')) setSdk(false); // GPT runs on the hand-built harness only
            }}
          >
            {(info?.models ?? MODELS).map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
        </label>
        <button className="btn small" onClick={newSession}>
          New session
        </button>
      </div>
      {!info?.sdk && info && (
        <p className="small muted">
          The Agent SDK version is not installed. In <code>examples/claude-agent-sdk</code> run{' '}
          <code>python3.12 -m venv .venv &amp;&amp; .venv/bin/pip install -r requirements.txt</code>, then restart the
          backend.
        </p>
      )}
      {workspace === 'files' && (
        <div className="cg-bar">
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            accept=".xlsx,.xls,.csv,.json,.txt,.md,.pdf,.docx,.pptx"
            onChange={(e) => void addFiles(e.target.files)}
          />
          <button className="btn small primary" onClick={() => fileInput.current?.click()} disabled={busy}>
            Add a file
          </button>
          <button className="btn small" onClick={() => void addSample()} disabled={busy}>
            Use the sample workbook
          </button>
          <span className="small muted">
            Files go in <code>inputs/</code>; what the agent makes goes in <code>outputs/</code>, to download from the
            Files tab. Up to 20 MB each.
          </span>
        </div>
      )}
      {mode === 'auto' && info && (
        <p className={`small ${info.sandbox ? 'muted' : 'cg-bad'}`}>
          {info.sandbox
            ? `Auto mode: nothing asks. ${info.sandbox === 'sessions' ? 'Commands run in an Azure Container Apps dynamic session, a Hyper-V isolated container for this session' : `Commands run in the ${info.sandbox} sandbox: writes only in the project, no home folder, no API key`}; pip and curl work. Still refused: ${info.rules.auto_deny.join(', ')}.`
            : 'No sandbox was found here, so auto mode keeps the full deny rules, as bypass does (see LLM_LAB_SANDBOX).'}
        </p>
      )}
      {error && <p className="cg-bad small">{error}</p>}

      <div className="cg-layout">
        <section className="cg-chat" aria-label="Agent">
          <header>
            {sdk ? 'Claude Code, through the Agent SDK' : 'Hand-built harness'}
            {context && !sdk && (
              <span className="small muted">
                {' '}
                · last request {context.input.toLocaleString('en-GB')} tokens,{' '}
                {Math.round((100 * context.cached) / Math.max(1, context.input))}% from cache
              </span>
            )}
          </header>
          <div className="cg-lines" ref={scroller}>
            {!items.some((x) => x.kind === 'user') && (
              <div className="cg-tasks">
                {Object.entries(info?.tasks ?? {})
                  .filter(([k]) => info?.workspaces[workspace]?.includes(k) ?? true)
                  .map(([k, v]) => (
                    <button
                      key={k}
                      className="cg-chip"
                      onClick={() => {
                        setDraft(v);
                        if (k === 'plan') setMode('plan');
                      }}
                    >
                      {TASK_LABEL[k] ?? k}
                    </button>
                  ))}
              </div>
            )}
            {items.map((it, i) => {
              const pad = { marginLeft: 'depth' in it ? it.depth * 18 : 0 };
              const step =
                it.kind === 'tool'
                  ? items.slice(0, i + 1).filter((x) => x.kind === 'tool' && x.depth === it.depth).length
                  : 0;
              if (it.kind === 'user')
                return (
                  <div key={i} className="cg-user">
                    {it.sdk && <small>Agent SDK · </small>}
                    {it.text}
                  </div>
                );
              if (it.kind === 'text')
                return (
                  <div key={i} className="cg-text" style={pad}>
                    {rich(it.text)}
                  </div>
                );
              if (it.kind === 'note')
                return (
                  <div key={i} className="cg-note small muted" style={pad}>
                    {it.text}
                  </div>
                );
              if (it.kind === 'final')
                return (
                  <div key={i} className="cg-final small">
                    {it.text}
                  </div>
                );
              return (
                <div
                  key={i}
                  className={`cg-tool${it.error ? ' bad' : ''}${it.approval?.state === 'waiting' ? ' ask' : ''}`}
                  style={pad}
                >
                  <details open={!!it.approval && it.approval.state === 'waiting'}>
                    <summary>
                      <span className="cg-step">{step}</span> <b>{verb(it.name, it.input)}</b>{' '}
                      <span>{brief(it.name, it.input)}</span> <small className="cg-tool-name">{it.name}</small>
                      {it.result === undefined && !it.approval && <i className="muted"> running…</i>}
                    </summary>
                    {it.diff ? (
                      <Diff text={it.diff} />
                    ) : (
                      <pre className="cg-pre">{JSON.stringify(it.input, null, 2)}</pre>
                    )}
                    {it.result !== undefined && <pre className="cg-pre out">{it.result}</pre>}
                  </details>
                  {it.approval && (
                    <div className="cg-approval">
                      {it.approval.state === 'waiting' ? (
                        <>
                          <span className="small">Allow this? ({it.approval.reason})</span>
                          <button
                            className="btn small primary"
                            onClick={() => void answer(it.id, it.approval!.runId, true)}
                          >
                            Allow
                          </button>
                          <button className="btn small" onClick={() => void answer(it.id, it.approval!.runId, false)}>
                            Deny
                          </button>
                        </>
                      ) : (
                        <span className={`small ${it.approval.state === 'allowed' ? 'cg-good' : 'cg-bad'}`}>
                          {it.approval.state === 'allowed' ? 'You allowed it' : `Refused (${it.approval.state})`}
                        </span>
                      )}
                    </div>
                  )}
                  {it.result !== undefined && it.error && (
                    <div className="cg-err small">{it.result.split('\n')[0].slice(0, 200)}</div>
                  )}
                  {it.images?.map((img, j) => (
                    <figure key={j} className="cg-shot">
                      <img src={`data:${img.media_type};base64,${img.data}`} alt={`What ${it.name} showed Claude`} />
                      <figcaption className="small muted">
                        {it.result?.split('\n')[0]}: this is what Claude saw
                      </figcaption>
                    </figure>
                  ))}
                </div>
              );
            })}
            {busy && <div className="small muted">Working…</div>}
          </div>
          <form className="cg-input" onSubmit={onSubmit}>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={session.current && !sdk ? 'A follow-up, in the same session…' : 'Ask for a change…'}
              rows={2}
              aria-label="Request"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) onSubmit(e);
              }}
            />
            {busy ? (
              <button type="button" className="btn" onClick={() => abort.current?.abort()}>
                Stop
              </button>
            ) : (
              <button className="btn primary" disabled={!draft.trim()}>
                Send
              </button>
            )}
          </form>
        </section>

        <aside className="cg-side">
          <section className="cg-card">
            <b>To-do list</b>
            {todos.length === 0 ? (
              <p className="small muted">The agent writes one for work in several steps.</p>
            ) : (
              <ul className="cg-todos">
                {todos.map((t, i) => (
                  <li key={i} className={t.status}>
                    <span>{t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▸' : '○'}</span>
                    {t.content}
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="cg-card">
            <div className="cg-tabs">
              <button className={tab === 'changes' ? 'on' : ''} onClick={() => setTab('changes')}>
                Changes
              </button>
              <button className={tab === 'files' ? 'on' : ''} onClick={() => setTab('files')} disabled={sdk}>
                Files
              </button>
              {!sdk && (
                <button
                  className="cg-undo"
                  onClick={() => void undo()}
                  disabled={busy || !state?.checkpoints.length}
                  title="Put back the file the agent changed last"
                >
                  Undo ({state?.checkpoints.length ?? 0})
                </button>
              )}
            </div>
            {tab === 'changes' || sdk ? (
              <Diff text={diff} />
            ) : (
              <>
                <ul className="cg-files">
                  {(state?.files ?? []).map((f) => (
                    <li key={f.path}>
                      <button className={file?.path === f.path ? 'on' : ''} onClick={() => void open(f.path)}>
                        {f.path}
                      </button>
                      {f.new ? <small className="cg-good"> new</small> : f.changed ? <small> changed</small> : null}
                      {state && (
                        <a
                          className="cg-download"
                          href={svc.downloadUrl(state.session_id, f.path)}
                          download
                          title={`Download ${f.path}`}
                        >
                          download
                        </a>
                      )}
                    </li>
                  ))}
                  {(state?.deleted ?? []).map((f) => (
                    <li key={f} className="cg-bad small">
                      {f} deleted
                    </li>
                  ))}
                </ul>
                {!state && <p className="small muted">Files appear once the session starts.</p>}
                {file &&
                  (file.image ? (
                    <img className="cg-file-image" src={file.image} alt={file.path} />
                  ) : (
                    <pre className="cg-pre file">{file.content}</pre>
                  ))}
              </>
            )}
          </section>
        </aside>
      </div>

      {(last.own || last.sdk) && (
        <table className="cg-table">
          <thead>
            <tr>
              <th>Last run</th>
              <th>Turns</th>
              <th>Tool calls</th>
              <th>Seconds</th>
              <th>Cost</th>
            </tr>
          </thead>
          <tbody>
            {(['own', 'sdk'] as const).map(
              (k) =>
                last[k] && (
                  <tr key={k}>
                    <td>{k === 'own' ? 'Hand-built harness' : 'Agent SDK (Claude Code)'}</td>
                    <td>{last[k]!.turns}</td>
                    <td>{last[k]!.tools}</td>
                    <td>{last[k]!.seconds?.toFixed(1)}</td>
                    <td>${last[k]!.cost.toFixed(4)}</td>
                  </tr>
                ),
            )}
          </tbody>
        </table>
      )}

      <h2>What a coding harness is made of</h2>
      <p>
        The loop is short: send the conversation and the tools, run the calls Claude asks for, send back the results,
        stop when it answers without a call. The rest is what makes that loop safe to point at your code.
      </p>
      <table className="cg-table">
        <thead>
          <tr>
            <th>Part</th>
            <th>Hand-built (19_coding_agent.py)</th>
            <th>Agent SDK</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>File tools</td>
            <td>
              <code>edit_file</code> replaces one exact string that appears once, only in a file read since it last
              changed. Paths must stay in the folder.
            </td>
            <td>Read, Edit, Write, with the same read-first rule</td>
          </tr>
          <tr>
            <td>Search</td>
            <td>
              <code>glob</code> and <code>grep</code> as tools, so the model does not pipe <code>find</code> through the
              shell
            </td>
            <td>Glob, Grep</td>
          </tr>
          <tr>
            <td>Shell</td>
            <td>
              A real shell with a timeout and capped output. <code>a &amp;&amp; b</code> is split and each part checked.
            </td>
            <td>Bash</td>
          </tr>
          <tr>
            <td>Eyes</td>
            <td>
              <code>read_file</code> on an image returns the image; <code>screenshot</code> renders a project page in
              headless Chrome and returns the picture and the console
            </td>
            <td>
              Read already returns images; <code>screenshot</code> is added as an in-process tool with{' '}
              <code>create_sdk_mcp_server</code>
            </td>
          </tr>
          <tr>
            <td>Permissions</td>
            <td>Deny rules in every mode, then the mode, then the allow list; a person answers the rest</td>
            <td>
              <code>disallowed_tools</code>, <code>permission_mode</code>, <code>allowed_tools</code>, then{' '}
              <code>can_use_tool</code>
            </td>
          </tr>
          <tr>
            <td>Hooks</td>
            <td>Before a call: protect .env and .git. After an edit: compile the Python.</td>
            <td>
              <code>hooks=&#123;&quot;PreToolUse&quot;: …, &quot;PostToolUse&quot;: …&#125;</code>, the same two
            </td>
          </tr>
          <tr>
            <td>Memory</td>
            <td>
              <code>CLAUDE.md</code> and a file list, once, in the system prompt
            </td>
            <td>
              <code>setting_sources=[&quot;project&quot;]</code>
            </td>
          </tr>
          <tr>
            <td>To-do list</td>
            <td>
              <code>todo_write</code>, one item in progress at a time
            </td>
            <td>TodoWrite</td>
          </tr>
          <tr>
            <td>Sub-agent</td>
            <td>
              <code>explore</code>: an empty context, reading tools only, a short report back
            </td>
            <td>
              <code>agents=&#123;&quot;explore&quot;: AgentDefinition(…)&#125;</code>, started with Task
            </td>
          </tr>
          <tr>
            <td>Checkpoints</td>
            <td>The file before every write, so Undo puts it back and the agent is told</td>
            <td>File checkpoints and rewind (not used here)</td>
          </tr>
          <tr>
            <td>Context</td>
            <td>
              Cached system prompt, tools and conversation; long output cut to its start and end; old results cleared in
              one go past a limit
            </td>
            <td>Caching and automatic compaction</td>
          </tr>
          <tr>
            <td>Limits</td>
            <td>Turns and a spending budget per request; Stop interrupts between calls</td>
            <td>
              <code>max_turns</code>, <code>max_budget_usd</code>, <code>interrupt()</code>
            </td>
          </tr>
        </tbody>
      </table>

      <div className="grid2" style={{ marginTop: 14 }}>
        <div className="card">
          <h3>Rules that make edits safe</h3>
          <p>
            Most damage a coding agent does comes from editing what it has not seen. So <code>edit_file</code> refuses a
            file the agent has not read, or one that changed since (a person, or another tool, may have edited it), and
            an <code>old_string</code> that is missing or appears twice. Each refusal is a tool error the model reads
            and fixes, usually by reading again. Every write is checkpointed first. Bash changes are not, which is why
            commands outside the allow list ask first.
          </p>
        </div>
        <div className="card">
          <h3>Keep the tools fixed, and the cache warm</h3>
          <p>
            The tool list never changes during a session, plan mode included: changing it would invalidate the cached
            prefix. Plan mode is a note in the next message plus permission checks that refuse edits. Old tool results
            are cleared in one go when the context passes a limit, not a few each turn, so the cache breaks once. A file
            whose read was cleared counts as unread, so the agent reads it again before editing.
          </p>
        </div>
        <div className="card">
          <h3>Build it, or use the Agent SDK?</h3>
          <p>
            The hand-built harness is about 500 lines, and every rule is yours to read and change. The Agent SDK gives
            you Claude Code&apos;s own loop, tools, prompts and context management, which have had far more use than
            anything written for one project; you configure it and add callbacks. Its system prompt is much longer, so
            each run costs more tokens. Build your own to learn, or when the tools are not files and a shell; use the
            SDK for a coding agent.
          </p>
        </div>
        <div className="card">
          <h3>Autonomous, because it is contained</h3>
          <p>
            An agent finishes work on its own when it has a general tool and room to use it. The shell is that tool:
            with no tool for Excel, it writes the file format itself or installs a package. Letting it act without
            asking is safe only inside a boundary the operating system enforces, as Claude Code&apos;s sandbox does. In
            auto mode every command runs under <code>sandbox-exec</code> (macOS) or bubblewrap (Linux): it writes only
            in the project, cannot read the home folder or <code>.env</code>, and gets no API key. So <code>pip</code>,{' '}
            <code>curl</code> and <code>rm</code> are allowed; publishing, <code>ssh</code> and <code>sudo</code> are
            not. A Stop hook makes &quot;done&quot; mean done: if the agent changed files, it is sent back until the
            tests pass, at most three times.
          </p>
        </div>
        <div className="card">
          <h3>In Azure Container Apps</h3>
          <p>
            The backend&apos;s container holds the managed identity and the API key, so agent commands must not run in
            it, and it cannot use bubblewrap. The boundary there is a container per session: with{' '}
            <code>LLM_LAB_SANDBOX=sessions</code> each command, screenshots included, goes to an Azure Container Apps
            dynamic session, a Hyper-V isolated container made on demand and called with the backend&apos;s managed
            identity. The project travels with each command and only what changed comes back, so undo and diffs still
            work. <code>examples/coding-sandbox</code> has the container and a keyless setup script. Without it, auto
            mode keeps the deny rules.
          </p>
        </div>
        <div className="card">
          <h3>How the agent sees a page</h3>
          <p>
            There is no special screenshot ability. A tool makes a picture, and the tool result carries it back as an
            image block,{' '}
            <code>&#123;&quot;type&quot;: &quot;image&quot;, &quot;source&quot;: &#123;base64 PNG&#125;&#125;</code>,
            next to a line of text. Claude reads images, so on the next turn it sees the page. Claude Code works the
            same way: a command renders a file to PNG, and its Read tool returns the image.{' '}
            {info && !info.screenshot && <b>Chrome was not found on this machine, so screenshot will fail here. </b>}
            An image costs about width × height / 750 tokens, so a 1000 × 800 screenshot is about 1,070. It is cleared
            with the other old results.
          </p>
        </div>
        <div className="card">
          <h3>Run it from the command line</h3>
          <pre className="cg-pre">
            {`cd python
python 19_coding_agent.py                    # asks before edits
python 19_coding_agent.py --task feature --mode accept_edits
python 19_coding_agent.py --task cleanup     # deny rules at work
python 19_coding_agent.py --task page --mode accept_edits --keep
python 19_coding_agent.py --task excel --mode auto  # sandboxed, never asks

cd examples/claude-agent-sdk
.venv/bin/python coding_agent_sdk.py --mode acceptEdits`}
          </pre>
        </div>
      </div>
      <p className="small muted">
        Deny rules: {info?.rules.deny.join(', ')}. Allowed without asking: {info?.rules.allow.join(', ')}. The project,
        its people and its data are invented.
      </p>
    </main>
  );
}
