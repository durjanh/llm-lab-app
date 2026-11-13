import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { modelName } from '@/lib/models';
import { statusService } from '@/services/statusService';
import {
  graphragService,
  type GraphAnswer,
  type GraphBuildEvent,
  type GraphEntity,
  type GraphMode,
  type GraphStatus,
  type KnowledgeGraph,
} from '@/services/graphragService';
import { communityColour, GraphView, type GraphHighlight } from './GraphView';
import './graphrag.css';

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const usd = (v: number) => `$${v < 0.1 ? v.toFixed(4) : v.toFixed(2)}`;

const MODES: { mode: GraphMode; title: string; how: string }[] = [
  {
    mode: 'vector',
    title: 'Plain vector RAG',
    how: 'The five chunks nearest the question by meaning, straight from the vector database.',
  },
  {
    mode: 'local',
    title: 'GraphRAG: local search',
    how: 'The five entities nearest the question, a walk of up to two relationships out, and the chunks they came from.',
  },
  {
    mode: 'global',
    title: 'GraphRAG: global search',
    how: 'Each community summary is asked what it knows (map); the best points from all of them make the answer (reduce).',
  },
];

const KIND_LABEL = { chunk: 'chunk', entity: 'entity', relation: 'relationship', community: 'community' } as const;

/** An answer with its [n] citations as chips; a number it was not given is marked. */
function Cited({ answer, unknown }: { answer: string; unknown: number[] }) {
  return (
    <p className="gr-answer">
      {answer.split(/(\[\d{1,3}\])/).map((p, i) => {
        const m = /^\[(\d+)\]$/.exec(p);
        if (!m)
          return <span key={i}>{p.split(/\*\*([^*]+)\*\*/).map((t, j) => (j % 2 ? <b key={j}>{t}</b> : t))}</span>;
        const bad = unknown.includes(Number(m[1]));
        return (
          <span
            key={i}
            className={`gr-cite${bad ? ' bad' : ''}`}
            title={bad ? 'Not one of the items it was given' : ''}
          >
            {m[1]}
          </span>
        );
      })}
    </p>
  );
}

interface BuildLog {
  done: number;
  total: number;
  step: string;
  notes: string[];
  merged?: { mentions: number; entities: number; relations: number };
  communities?: { count: number; summarised: number; sizes: number[] };
  cost: number;
  finished?: { entities: number; relations: number; communities: number; cost_usd: number; seconds: number };
}

/** GraphRAG: a knowledge graph built from a vector database collection, searched beside plain vector retrieval. */
export default function GraphRagPage() {
  const [status, setStatus] = useState<GraphStatus | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState('');
  const [collection, setCollection] = useState('');
  const [graph, setGraph] = useState<KnowledgeGraph | null>(null);
  const [selected, setSelected] = useState<GraphEntity | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [log, setLog] = useState<BuildLog | null>(null);
  const [question, setQuestion] = useState('');
  const [answers, setAnswers] = useState<Partial<Record<GraphMode, GraphAnswer | { error: string } | 'asking'>>>({});
  const [showing, setShowing] = useState<GraphMode | null>(null);
  const [cost, setCost] = useState(0);
  const abort = useRef<AbortController | null>(null);

  const refresh = useCallback(async (m: string) => {
    try {
      const s = await graphragService.status(m);
      setStatus(s);
      setCollection((c) =>
        c && s.collections.some((x) => x.collection === c)
          ? c
          : (s.collections.find((x) => x.collection === s.sample.collection)?.collection ??
            s.collections[0]?.collection ??
            ''),
      );
    } catch (err) {
      setError(errorText(err));
    }
  }, []);

  useEffect(() => {
    statusService
      .status()
      .then((s) => {
        const offered = s.models || [];
        setModels(offered);
        const m = s.default_model || offered[0] || '';
        setModel(m);
        void refresh(m);
      })
      .catch((err) => setError(errorText(err)));
    return () => abort.current?.abort();
  }, [refresh]);

  const current = status?.collections.find((c) => c.collection === collection);

  useEffect(() => {
    setGraph(null);
    setSelected(null);
    setAnswers({});
    setShowing(null);
    if (!collection || !current?.entities) return;
    graphragService
      .graph(collection)
      .then(setGraph)
      .catch((err) => setError(errorText(err)));
    // the graph changes only when the collection or its build does
  }, [collection, current?.built, current?.entities]);

  const suggestions = status?.questions[collection];
  useEffect(() => {
    setQuestion(suggestions?.local[0] ?? '');
  }, [collection]);

  async function loadSample() {
    setBusy('Embedding the sample memos and storing them…');
    setError('');
    try {
      const r = await graphragService.loadSample();
      setCollection(r.collection);
      await refresh(model);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy('');
    }
  }

  async function build() {
    const controller = new AbortController();
    abort.current = controller;
    setBusy('Building the graph…');
    setError('');
    setLog({ done: 0, total: current?.estimate.used ?? 0, step: 'Starting', notes: [], cost: 0 });
    const on = (e: GraphBuildEvent) =>
      setLog((l) => {
        if (!l) return l;
        switch (e.type) {
          case 'progress':
            return { ...l, step: e.step, total: e.total ?? l.total };
          case 'chunk':
            return {
              ...l,
              done: e.done,
              total: e.total,
              cost: l.cost + e.cost_usd,
              step: `Read ${e.source}, chunk ${e.chunk}: ${e.entities} entities, ${e.relationships} relationships`,
            };
          case 'note':
            return { ...l, notes: [...l.notes, e.message] };
          case 'merged':
            return { ...l, merged: e };
          case 'communities':
            return { ...l, communities: e };
          case 'done':
            return { ...l, finished: e, step: 'Done' };
          case 'error':
            setError(e.message);
            return l;
          default:
            return l;
        }
      });
    try {
      await graphragService.build(collection, model, on, controller.signal);
      await refresh(model);
    } catch (err) {
      if (!controller.signal.aborted) setError(errorText(err));
    } finally {
      setBusy('');
      setLog((l) => {
        if (l?.finished) setCost((c) => c + (l.finished?.cost_usd ?? 0));
        return l;
      });
    }
  }

  async function ask(q: string) {
    if (!q.trim()) return;
    setError('');
    setAnswers({ vector: 'asking', local: 'asking', global: 'asking' });
    setShowing(null);
    await Promise.all(
      MODES.map(async ({ mode }) => {
        try {
          const r = await graphragService.ask(collection, q.trim(), mode, model);
          setAnswers((a) => ({ ...a, [mode]: r }));
          setCost((c) => c + r.cost_usd);
        } catch (err) {
          setAnswers((a) => ({ ...a, [mode]: { error: errorText(err) } }));
        }
      }),
    );
  }

  const highlight: GraphHighlight | null = useMemo(() => {
    const a = showing ? answers[showing] : undefined;
    if (!a || a === 'asking' || 'error' in a) return null;
    return {
      entities: new Set(a.highlight.entities),
      seeds: new Set(a.highlight.seeds ?? []),
      communities: new Set(a.highlight.communities),
    };
  }, [showing, answers]);

  const names = useMemo(() => new Map((graph?.entities ?? []).map((e) => [e.key, e.name])), [graph]);
  const asking = Object.values(answers).some((a) => a === 'asking');
  const ready = !!status?.embedder.has_model && !status.error;
  const built = !!current?.entities;

  return (
    <main className="page-graphrag">
      <div className="kicker">Building · GraphRAG</div>
      <h1>A knowledge graph from your documents, beside plain RAG</h1>
      <p className="lede">
        Plain retrieval finds the few chunks nearest a question. That answers “what does the handbook say about leave”,
        but not “who works with whom” or “what are the main risks across all of this”: the answer is spread over many
        chunks. GraphRAG has a model read every chunk once and list the people, projects and organisations in it and how
        they relate. Code joins those into one graph, finds the groups in it, and a model summarises each group. A
        question can then walk the graph, or ask every group at once.
      </p>

      {status && !status.embedder.has_model && (
        <div className="gr-setup small">
          The local embedding model is not ready. Run <code>./tools/local-model.sh --embed</code>, add{' '}
          <code>LLM_LAB_LOCAL_EMBED_MODEL</code> to <code>.env</code> and restart the backend.
        </div>
      )}
      {status?.error && (
        <div className="gr-setup small">
          {status.error} The graph lives in the same PostgreSQL as the <a href="/vector-db">vector database page</a>:
          start it with <code>./tools/vector-db.sh</code>.
        </div>
      )}
      {error && <p className="gr-bad small">{error}</p>}

      <section className="card gr-step">
        <h2>1. Choose documents and build the graph</h2>
        <div className="gr-row">
          <label>
            Collection{' '}
            <select value={collection} onChange={(e) => setCollection(e.target.value)} disabled={!!busy}>
              {!status?.collections.length && <option value="">none yet</option>}
              {status?.collections.map((c) => (
                <option key={c.collection} value={c.collection}>
                  {c.collection} ({c.documents} documents, {c.chunks} chunks{c.entities ? ', graph built' : ''})
                </option>
              ))}
            </select>
          </label>
          <button className="btn small" disabled={!ready || !!busy} onClick={() => void loadSample()}>
            Load: {status?.sample.title ?? 'the invented sample'}
          </button>
        </div>
        <p className="small muted">
          Collections come from the <a href="/vector-db">vector database page</a>, where you can add your own or load
          the handbook. The Quillmere memos are invented, written so that people, projects and suppliers run across
          several documents.
        </p>
        {current && (
          <div className="gr-row">
            <label>
              Model{' '}
              <select
                value={model}
                onChange={(e) => {
                  setModel(e.target.value);
                  void refresh(e.target.value);
                }}
                disabled={!!busy}
              >
                {models.map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
            </label>
            <button className="btn primary" disabled={!ready || !!busy} onClick={() => void build()}>
              {built ? 'Rebuild the graph' : 'Build the graph'}
            </button>
            <span className="small muted">
              {current.estimate.calls} calls to {modelName(model)}, about {usd(current.estimate.cost_usd)}
              {current.estimate.capped && ` (only the first ${current.estimate.used} chunks)`}.
            </span>
            {busy && abort.current && log && !log.finished && (
              <button className="btn small" onClick={() => abort.current?.abort()}>
                Stop
              </button>
            )}
          </div>
        )}
        {busy && !log && (
          <p className="small">
            <span className="gr-pulse" /> {busy}
          </p>
        )}
        {log && (
          <div className="gr-log small" aria-live="polite">
            <div className="gr-progress">
              <i style={{ width: `${log.total ? (log.done / log.total) * 100 : 0}%` }} />
            </div>
            <p>
              {!log.finished && <span className="gr-pulse" />} {log.step}
              {log.total > 0 && ` (${log.done} of ${log.total} chunks)`}. Spent {usd(log.cost)} so far.
            </p>
            {log.notes.map((n) => (
              <p key={n} className="muted">
                {n}
              </p>
            ))}
            {log.merged && (
              <p>
                Merged {log.merged.mentions} mentions into {log.merged.entities} entities and {log.merged.relations}{' '}
                relationships.
              </p>
            )}
            {log.communities && (
              <p>
                Found {log.communities.count} communities; summarising the {log.communities.summarised} with two or more
                entities (sizes {log.communities.sizes.join(', ')}).
              </p>
            )}
            {log.finished && (
              <p>
                <b>Built</b> in {log.finished.seconds} s for {usd(log.finished.cost_usd)}: {log.finished.entities}{' '}
                entities, {log.finished.relations} relationships, {log.finished.communities} community summaries.
              </p>
            )}
          </div>
        )}
      </section>

      {graph && graph.entities.length > 0 && (
        <section className="card gr-step">
          <h2>2. The graph</h2>
          <p className="small muted">
            {graph.entities.length} entities and {graph.relations.length} relationships, coloured by community. Bigger
            circles have more relationships. Hover for a description; click to see an entity’s links.
          </p>
          <div className="gr-graph-wrap">
            <GraphView graph={graph} highlight={highlight} selected={selected?.key ?? null} onSelect={setSelected} />
            <aside className="gr-side">
              {selected ? (
                <div>
                  <h3>
                    <span className="gr-dot" style={{ background: communityColour(selected.community) }} />{' '}
                    {selected.name}
                  </h3>
                  <p className="small muted">
                    {selected.type} · community {selected.community} · found in{' '}
                    {selected.refs.map((r) => `${r.source} #${r.chunk}`).join(', ')}
                  </p>
                  <p className="small">{selected.description}</p>
                  <ul className="small gr-links">
                    {graph.relations
                      .filter((r) => r.source === selected.key || r.target === selected.key)
                      .map((r) => (
                        <li key={`${r.source}|${r.target}`}>
                          <b>{names.get(r.source === selected.key ? r.target : r.source)}</b>: {r.description}
                        </li>
                      ))}
                  </ul>
                </div>
              ) : (
                <div>
                  <h3>Communities</h3>
                  {graph.communities.length === 0 && <p className="small muted">None summarised.</p>}
                  {graph.communities.map((c) => (
                    <details key={c.community} className={highlight?.communities.has(c.community) ? 'gr-used' : ''}>
                      <summary>
                        <span className="gr-dot" style={{ background: communityColour(c.community) }} /> {c.title}{' '}
                        <span className="muted small">({c.members.length})</span>
                      </summary>
                      <p className="small">{c.summary}</p>
                    </details>
                  ))}
                </div>
              )}
            </aside>
          </div>
        </section>
      )}

      {built && (
        <section className="card gr-step">
          <h2>3. Ask one question three ways</h2>
          <form
            className="gr-row"
            onSubmit={(e) => {
              e.preventDefault();
              void ask(question);
            }}
          >
            <input
              className="gr-question"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              maxLength={500}
              placeholder="Ask about the documents"
            />
            <button className="btn primary" disabled={asking || !question.trim() || !model}>
              Ask all three
            </button>
            <span className="small muted">Spent on this page: {usd(cost)}</span>
          </form>
          {suggestions && (
            <div className="gr-suggest small">
              <span className="muted">About one thing (local search should win):</span>
              {suggestions.local.map((q) => (
                <button key={q} className="gr-chip" onClick={() => setQuestion(q)} type="button">
                  {q}
                </button>
              ))}
              <span className="muted">About the whole set (global search should win):</span>
              {suggestions.global.map((q) => (
                <button key={q} className="gr-chip" onClick={() => setQuestion(q)} type="button">
                  {q}
                </button>
              ))}
            </div>
          )}

          <div className="gr-answers">
            {MODES.map(({ mode, title, how }) => {
              const a = answers[mode];
              return (
                <div
                  key={mode}
                  className={`gr-col${showing === mode ? ' on' : ''}`}
                  onMouseEnter={() => a && a !== 'asking' && !('error' in a) && setShowing(mode)}
                >
                  <div className="gr-col-head">
                    <b>{title}</b>
                    {a && a !== 'asking' && !('error' in a) && (
                      <span className="mono small muted">
                        {(a.ms / 1000).toFixed(1)} s · {usd(a.cost_usd)}
                      </span>
                    )}
                  </div>
                  <p className="small muted">{how}</p>
                  {a === 'asking' && (
                    <p className="small">
                      <span className="gr-pulse" /> Searching and answering…
                    </p>
                  )}
                  {a && a !== 'asking' && 'error' in a && <p className="gr-bad small">{a.error}</p>}
                  {a && a !== 'asking' && !('error' in a) && (
                    <>
                      <Cited answer={a.answer} unknown={a.unknown} />
                      {a.unknown.length > 0 && (
                        <p className="gr-bad small">
                          Cited {a.unknown.map((n) => `[${n}]`).join(', ')}, which it was not given.
                        </p>
                      )}
                      <details className="gr-evidence">
                        <summary className="small">
                          What it was given: {a.evidence.length} item{a.evidence.length === 1 ? '' : 's'}
                          {a.mapped ? `, from ${a.mapped} community summaries` : ''}
                        </summary>
                        <ol>
                          {a.evidence.map((e, i) => (
                            <li key={i} className={a.cited.includes(i + 1) ? 'cited' : ''}>
                              <span className={`gr-kind ${e.kind}`}>{KIND_LABEL[e.kind]}</span>{' '}
                              <span className="small muted">{e.label}</span>
                              <div className="gr-text">{e.text}</div>
                            </li>
                          ))}
                        </ol>
                        {a.sql && (
                          <details>
                            <summary className="small">The graph walk, in SQL</summary>
                            <pre>{a.sql}</pre>
                          </details>
                        )}
                      </details>
                    </>
                  )}
                </div>
              );
            })}
          </div>
          {graph && Object.keys(answers).length > 0 && (
            <p className="small muted">
              Hover over an answer to light up what it used in the graph above
              {showing ? `: now showing ${MODES.find((m) => m.mode === showing)?.title}` : ''}.
            </p>
          )}
        </section>
      )}

      <h2>When to use which</h2>
      <div className="table-wrap">
        <table className="t">
          <thead>
            <tr>
              <th />
              <th>Plain vector RAG</th>
              <th>Local search</th>
              <th>Global search</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Good at</td>
              <td>A fact written in one place</td>
              <td>One person, project or supplier, and what is linked to it</td>
              <td>Themes, risks and patterns across the whole collection</td>
            </tr>
            <tr>
              <td>Misses</td>
              <td>Answers spread over many documents</td>
              <td>Questions not about any named thing</td>
              <td>Exact details: summaries lose them</td>
            </tr>
            <tr>
              <td>Cost to set up</td>
              <td>Embedding only (free here)</td>
              <td colSpan={2}>A model call per chunk, plus one per community, again whenever the documents change</td>
            </tr>
            <tr>
              <td>Cost per question</td>
              <td>One answer</td>
              <td>One answer</td>
              <td>One call per community, then one answer</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2>How it works</h2>
      <ul className="gr-facts">
        <li>
          <b>Extraction.</b> A model reads each chunk and returns its entities (name, type, description) and
          relationships (two names, a description, a strength from 1 to 10) as structured output.
        </li>
        <li>
          <b>Merging.</b> Code joins mentions with the same normalised name (“the Kestrel Components” and “Kestrel
          Components”). This is the weak spot: “Priya” and “Priya Shah”, or two different people with one name, need
          more than string matching. Production systems add a model or rules for entity resolution.
        </li>
        <li>
          <b>Communities.</b> Code runs the Louvain method: move each entity to the neighbouring group that most raises
          modularity (links inside groups beyond what chance would give), merge each group into one node, and repeat.
          Microsoft’s GraphRAG uses Leiden, a refinement of the same idea, and builds a hierarchy of levels; this page
          uses one level.
        </li>
        <li>
          <b>Storage.</b> Three tables beside the chunks in PostgreSQL: entities (with a vector of each description, so
          a question can find them), relationships, and community summaries. The walk from the nearest entities is one
          recursive SQL query; no separate graph database is needed at this size.
        </li>
        <li>
          <b>Cost.</b> Building the graph reads every chunk with a model, so it costs far more than embedding, and must
          be redone when documents change. Global search makes one call per community for every question. Use it where
          the questions need it.
        </li>
      </ul>
    </main>
  );
}
