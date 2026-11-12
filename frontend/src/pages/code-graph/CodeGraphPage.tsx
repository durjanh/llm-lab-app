import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { VoiceComposer } from '@/components/voice/VoiceComposer';
import { isLocalModel } from '@/lib/models';
import {
  codeGraphService,
  type CodeGraph,
  type EdgeKind,
  type GraphAnswer,
  type GraphMeta,
  type NodeDetail,
  type NodeKind,
  type NodeRef,
} from '@/services/codeGraphService';
import { statusService } from '@/services/statusService';
import { EDGE_COLOUR, GraphCanvas, KIND_COLOUR, type GraphCanvasHandle } from './GraphCanvas';
import './code-graph.css';

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const usd = (v: number) => `$${v < 0.1 ? v.toFixed(4) : v.toFixed(2)}`;
const KINDS: NodeKind[] = ['folder', 'file', 'class', 'interface', 'function', 'method'];
const EDGES: EdgeKind[] = ['contains', 'imports', 'calls', 'extends'];
const DEPTHS: { label: string; value: number | null }[] = [
  { label: 'All', value: null },
  { label: '1 step', value: 1 },
  { label: '2 steps', value: 2 },
  { label: '3 steps', value: 3 },
];
const SAMPLES = [
  'How is spending tracked and capped?',
  'What calls SpendTracker.charge?',
  'Which classes inherit from BaseModel?',
  'How does the diet planner page talk to the backend?',
];

/** Reads a ZIP into base64, for the upload route. */
function readZip(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(new Error('The file could not be read.'));
    reader.readAsDataURL(file);
  });
}

function Refs({ title, items, onPick }: { title: string; items?: NodeRef[]; onPick: (id: string) => void }) {
  if (!items?.length) return null;
  return (
    <div className="cg-refs">
      <h4>
        {title} <span className="muted">({items.length})</span>
      </h4>
      <ul>
        {items.map((r) => (
          <li key={r.id + title}>
            <button className="cg-link" onClick={() => onPick(r.id)}>
              <i style={{ background: KIND_COLOUR[r.kind] }} />
              {r.name}
            </button>
            <span className="muted small">
              {' '}
              {r.file}
              {r.line ? `:${r.line}` : ''}
              {r.matched_by ? ` · matched by ${r.matched_by}` : ''}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A code knowledge graph: a code base as files, classes, functions, imports and calls, and a chat that explores it. */
export default function CodeGraphPage() {
  const canvas = useRef<GraphCanvasHandle>(null);
  const [sources, setSources] = useState<GraphMeta[]>([]);
  const [graph, setGraph] = useState<CodeGraph | null>(null);
  const [meta, setMeta] = useState<GraphMeta | null>(null);
  const [kinds, setKinds] = useState<Set<NodeKind>>(new Set(['file', 'class', 'interface', 'function']));
  const [edgeKinds, setEdgeKinds] = useState<Set<EdgeKind>>(new Set(EDGES));
  const [depth, setDepth] = useState<number | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<NodeDetail | null>(null);
  const [lit, setLit] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [github, setGithub] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState('');
  const [question, setQuestion] = useState('');
  const [chat, setChat] = useState<({ q: string } & Partial<GraphAnswer>)[]>([]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [cost, setCost] = useState(0);

  useEffect(() => {
    codeGraphService
      .info()
      .then((i) => setSources(i.sources))
      .catch((err) => setError(errorText(err)));
    statusService
      .status()
      .then((s) => {
        setModels(s.models || []);
        setModel(s.claude_model || s.models?.[0] || '');
      })
      .catch((err) => setError(errorText(err)));
    void open(() => codeGraphService.analyseLab(), 'Reading this lab’s code…');
  }, []);

  async function open(analyse: () => Promise<GraphMeta>, label: string) {
    setBusy(label);
    setError('');
    try {
      const m = await analyse();
      const g = await codeGraphService.graph(m.id);
      setMeta(m);
      setGraph(g);
      setSelected(null);
      setDetail(null);
      setLit(new Set());
      setChat([]);
      setSources((s) => [m, ...s.filter((x) => x.id !== m.id)]);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy('');
    }
  }

  // The side panel follows the selection.
  useEffect(() => {
    if (!graph || !selected) {
      setDetail(null);
      return;
    }
    let live = true;
    codeGraphService
      .node(graph.id, selected)
      .then((d) => live && setDetail(d))
      .catch((err) => live && setError(errorText(err)));
    return () => {
      live = false;
    };
  }, [graph, selected]);

  // A new depth, or a new focus while focused, shows a different set of nodes: fit them in once they have moved.
  // With everything shown, a picked node is centred instead, so the view is left alone.
  const lastDepth = useRef(depth);
  useEffect(() => {
    const changed = lastDepth.current !== depth;
    lastDepth.current = depth;
    if (!changed && depth === null) return;
    const timer = window.setTimeout(() => canvas.current?.fit(), 700);
    return () => window.clearTimeout(timer);
  }, [depth, selected, kinds]);

  const matches = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!graph || q.length < 2) return [];
    return graph.nodes
      .filter((n) => n.kind !== 'folder' && `${n.qual || n.name} ${n.file}`.toLowerCase().includes(q))
      .sort(
        (a, b) =>
          Number(a.name.toLowerCase() !== q) - Number(b.name.toLowerCase() !== q) || a.name.length - b.name.length,
      )
      .slice(0, 12);
  }, [graph, search]);

  function pick(id: string) {
    const n = graph?.nodes.find((x) => x.id === id);
    if (n && !kinds.has(n.kind)) setKinds((k) => new Set(k).add(n.kind));
    setSelected(id);
    window.setTimeout(() => canvas.current?.centreOn(id), 60);
  }

  async function ask(text: string) {
    if (!graph || busy || !text.trim()) return;
    const history = chat.filter((c) => c.answer).map((c) => ({ q: c.q, a: c.answer ?? '' }));
    setChat((c) => [...c, { q: text }]);
    setQuestion('');
    setBusy('The model is exploring the graph…');
    setError('');
    try {
      const r = await codeGraphService.ask(graph.id, text, history, model || undefined);
      setChat((c) => [...c.slice(0, -1), { q: text, ...r }]);
      setLit(new Set(r.used));
      setCost((x) => x + r.cost_usd);
    } catch (err) {
      setChat((c) => c.slice(0, -1));
      setError(errorText(err));
    } finally {
      setBusy('');
    }
  }

  const toggle = <T,>(set: Set<T>, v: T) => {
    const next = new Set(set);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    return next;
  };
  const node = detail?.node;

  return (
    <main className="page-code-graph">
      <div className="kicker">Building · Code knowledge graph</div>
      <h1>See a code base as a graph, then ask it questions</h1>
      <p className="lede">
        Point it at a code base. Code reads it in four passes: the files and folders; every file parsed into classes,
        functions and methods; imports joined to the files they name; and calls joined to the functions they name. Then
        ask a question: a model explores the graph through a few tools and answers, and the nodes it looked at light up.
      </p>

      <section className="card cg-source" aria-label="Code base">
        <div className="cg-row">
          <button
            className="btn"
            disabled={!!busy}
            onClick={() => void open(() => codeGraphService.analyseLab(), 'Reading this lab’s code…')}
          >
            This lab’s code
          </button>
          <label className={`btn${busy ? ' disabled' : ''}`}>
            Upload a ZIP…
            <input
              type="file"
              accept=".zip,application/zip"
              hidden
              disabled={!!busy}
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (!f) return;
                const data = await readZip(f);
                void open(() => codeGraphService.upload(f.name, data), `Unpacking and reading ${f.name}…`);
              }}
            />
          </label>
          <form
            className="cg-github"
            onSubmit={(e) => {
              e.preventDefault();
              if (github.trim())
                void open(() => codeGraphService.analyseGithub(github.trim()), 'Downloading from GitHub…');
            }}
          >
            <input
              value={github}
              onChange={(e) => setGithub(e.target.value)}
              placeholder="https://github.com/owner/repo"
              aria-label="Public GitHub repository"
            />
            <button className="btn" disabled={!!busy || !github.trim()}>
              Read from GitHub
            </button>
          </form>
          {sources.length > 1 && (
            <select
              aria-label="Code bases read before"
              value={meta?.id ?? ''}
              onChange={(e) => {
                const m = sources.find((s) => s.id === e.target.value);
                if (m) void open(async () => m, `Opening ${m.label}…`);
              }}
            >
              {sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          )}
        </div>
        {meta && (
          <p className="small muted cg-stats">
            <b>{meta.label}</b>: {meta.files} files read in {meta.took_s} s ·{' '}
            {KINDS.filter((k) => meta.counts[k])
              .map((k) => `${meta.counts[k]} ${k === 'class' ? 'classes' : k + 's'}`)
              .join(', ')}{' '}
            ·{' '}
            {EDGES.filter((k) => meta.edge_counts[k])
              .map((k) => `${meta.edge_counts[k]} ${k}`)
              .join(', ')}
            {meta.notes.length > 0 && <> · {meta.notes.join('; ')}</>}
          </p>
        )}
        {busy && <p className="small cg-busy">{busy}</p>}
        {error && <p className="small cg-bad">{error}</p>}
      </section>

      <div className="cg-layout">
        <aside className="card cg-filters" aria-label="Filters">
          <h3>Show</h3>
          {KINDS.map((k) => (
            <label key={k} className="cg-check">
              <input type="checkbox" checked={kinds.has(k)} onChange={() => setKinds((s) => toggle(s, k))} />
              <i style={{ background: KIND_COLOUR[k] }} /> {k === 'class' ? 'classes' : `${k}s`}
              <span className="muted">{graph?.counts[k] ?? 0}</span>
            </label>
          ))}
          <h3>Links</h3>
          {EDGES.map((k) => (
            <label key={k} className="cg-check">
              <input type="checkbox" checked={edgeKinds.has(k)} onChange={() => setEdgeKinds((s) => toggle(s, k))} />
              <i className="line" style={{ background: EDGE_COLOUR[k] }} /> {k}
              <span className="muted">{graph?.edge_counts[k] ?? 0}</span>
            </label>
          ))}
          <h3>Around the selection</h3>
          <div className="cg-depths">
            {DEPTHS.map((d) => (
              <button
                key={d.label}
                className={`btn small${depth === d.value ? ' primary' : ''}`}
                onClick={() => setDepth(d.value)}
                disabled={d.value !== null && !selected}
              >
                {d.label}
              </button>
            ))}
          </div>
          <h3>Find</h3>
          <input
            className="cg-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="A name or a path"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && matches[0]) pick(matches[0].id);
            }}
          />
          <ul className="cg-matches">
            {matches.map((n) => (
              <li key={n.id}>
                <button className="cg-link" onClick={() => pick(n.id)}>
                  <i style={{ background: KIND_COLOUR[n.kind] }} />
                  {n.qual || n.name}
                </button>
              </li>
            ))}
          </ul>
          <button className="btn small" onClick={() => canvas.current?.fit()}>
            Fit to view
          </button>
          {lit.size > 0 && (
            <button className="btn small" onClick={() => setLit(new Set())}>
              Clear highlights
            </button>
          )}
        </aside>

        <section className="card cg-graph" aria-label="Graph">
          {graph ? (
            <GraphCanvas
              ref={canvas}
              graph={graph}
              kinds={kinds}
              edgeKinds={edgeKinds}
              focus={selected}
              depth={depth}
              lit={lit}
              selected={selected}
              onSelect={setSelected}
            />
          ) : (
            <div className="cg-empty muted">{busy || 'Choose a code base above.'}</div>
          )}
          <p className="small muted cg-hint">
            Scroll to zoom, drag the background to move, drag a node to pull it, click a node to read it.
          </p>
        </section>

        <aside className="card cg-panel" aria-label="Selected node">
          {!node && <p className="small muted">Click a node, or find one by name, to see its code and its links.</p>}
          {node && (
            <>
              <div className="cg-kind" style={{ color: KIND_COLOUR[node.kind] }}>
                {node.kind}
              </div>
              <h3 className="cg-name">{node.qual || node.name}</h3>
              <p className="small muted">
                {node.file}
                {node.line ? `:${node.line}` : ''}
                {node.end && node.line ? ` (${node.end - node.line + 1} lines)` : ''}
              </p>
              {node.error && <p className="small cg-bad">{node.error}</p>}
              {detail?.code && <pre className="cg-code">{detail.code}</pre>}
              <Refs title="Contains" items={detail?.outline} onPick={pick} />
              <Refs title="Calls" items={detail?.calls} onPick={pick} />
              <Refs title="Called by" items={detail?.called_by} onPick={pick} />
              <Refs title="Imports" items={detail?.imports} onPick={pick} />
              <Refs title="Imported by" items={detail?.imported_by} onPick={pick} />
              <Refs title="Extends" items={detail?.extends} onPick={pick} />
              <Refs title="Extended by" items={detail?.subclasses} onPick={pick} />
              {detail?.packages && detail.packages.length > 0 && (
                <p className="small">
                  <b>Packages:</b> {detail.packages.join(', ')}
                </p>
              )}
            </>
          )}
        </aside>
      </div>

      <section className="card cg-chat" aria-label="Ask about the code">
        <div className="cg-row">
          <h2>Ask about the code</h2>
          <label className="small">
            Model{' '}
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                  {m.startsWith('gpt-') ? ' (Azure OpenAI)' : isLocalModel(m) ? ' (local, free)' : ''}
                </option>
              ))}
            </select>
          </label>
          <span className="small muted">Spent here: {usd(cost)}</span>
        </div>
        <p className="small muted">
          What leaves this machine: only what the model asks for through its tools (search results, one function’s code,
          who calls what), sent to the model you choose.{' '}
          {isLocalModel(model) ? 'With the local model, nothing leaves.' : 'Choose the local model and nothing leaves.'}
        </p>
        {chat.map((c, i) => (
          <div key={i} className="cg-turn">
            <p className="small">
              <b>You:</b> {c.q}
            </p>
            {c.steps && c.steps.length > 0 && (
              <ol className="cg-steps small muted">
                {c.steps.map((s, j) => (
                  <li key={j}>
                    <code>
                      {s.tool}({Object.values(s.input).map(String).join(', ')})
                    </code>{' '}
                    → {s.found} node{s.found === 1 ? '' : 's'}
                  </li>
                ))}
              </ol>
            )}
            {c.answer ? (
              <div className="cg-answer">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{c.answer}</ReactMarkdown>
                {c.used && c.used.length > 0 && (
                  <button className="btn small" onClick={() => setLit(new Set(c.used))}>
                    Light up the {c.used.length} nodes it used
                  </button>
                )}
              </div>
            ) : (
              <p className="small muted">{busy}</p>
            )}
          </div>
        ))}
        <div className="cg-samples">
          {SAMPLES.map((s) => (
            <button key={s} className="btn small" disabled={!!busy || !graph} onClick={() => void ask(s)}>
              {s}
            </button>
          ))}
        </div>
        <VoiceComposer
          value={question}
          onChange={setQuestion}
          onSend={(t) => void ask(t)}
          onError={setError}
          busy={!!busy}
          disabled={!graph}
          placeholder="How does authentication work? What calls this function?"
        />
      </section>

      <h2>Who does what</h2>
      <div className="table-wrap">
        <table className="t">
          <thead>
            <tr>
              <th>Step</th>
              <th>Done by</th>
              <th>Why</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>List the files; unpack a ZIP or a GitHub download</td>
              <td>Code: paths checked (no absolute paths, no “..”, no links), sizes and counts capped</td>
              <td>An archive is untrusted input; the code in it is read, never run</td>
            </tr>
            <tr>
              <td>Parse every file into classes, functions and methods</td>
              <td>Code: Python’s own parser, and oxc for JavaScript and TypeScript</td>
              <td>A parser is exact and takes about a second for this whole lab</td>
            </tr>
            <tr>
              <td>Join imports to files, and calls to functions</td>
              <td>Code, by name; each call edge says which rule joined it</td>
              <td>Without running the code, a call can only be matched by name, so the call graph is approximate</td>
            </tr>
            <tr>
              <td>Answer a question</td>
              <td>The model, through seven tools over the graph</td>
              <td>It reads only what it asks for, so a large code base fits and little leaves the machine</td>
            </tr>
            <tr>
              <td>Show what the answer used</td>
              <td>Code: the tools record every node they returned</td>
              <td>You can check the answer against the code it came from</td>
            </tr>
          </tbody>
        </table>
      </div>
    </main>
  );
}
