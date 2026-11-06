import { Fragment, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  dataagentService as svc,
  statusService,
  type AgentEvent,
  type DataQuery,
  type DataViewer,
  type ModelTopic,
  type DataQueryResult as QueryResult,
  type SchemaTable,
  type Tile,
  type Viz,
} from '@/services';
import { Chart, label, Table } from './Chart';
import './dataagent.css';

const MODELS = ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5']; // until the status says more
const EXAMPLES = [
  'show me PRs merged to main in the harbour repo by week',
  'create a dashboard of engineering activity',
  'which team reviews the most, and how quickly?',
  'what share of PRs change more than 500 lines, by team?',
  'rank repositories by open P0 and P1 bugs per merged PR this year',
  'compare our merged PRs with the other companies in the warehouse',
];

type Line =
  | { kind: 'user'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'step'; label: string; detail: string; input: Record<string, unknown>; error?: boolean; sql?: string }
  | { kind: 'done'; cost: number };

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

/** The compiled SQL with its parameters written in, so it can be edited and run as plain SQL. */
const inline = (sql: string, params: unknown[]) => {
  let i = 0;
  return sql.replace(/\?/g, () => {
    const v = params[i++];
    return typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`;
  });
};

/** A chart for SQL results, read from what came back: text or date columns across, number columns up. */
const vizFromRows = (r: QueryResult): Viz => {
  const first = r.rows[0] ?? {};
  const nums = r.columns.filter((c) => typeof first[c] === 'number');
  const cats = r.columns.filter((c) => !nums.includes(c));
  if (!cats.length) return { kind: r.rows.length === 1 ? 'number' : 'table', title: 'Result', y: nums.slice(0, 1) };
  const dated = r.rows.every((row) => row[cats[0]] === null || /^\d{4}(-|$)/.test(String(row[cats[0]])));
  return { kind: dated ? 'line' : 'bar', title: 'Result', x: cats[0], y: nums.slice(0, 2), series: cats[1] ?? null };
};

const defaultViz = (r: QueryResult): Viz => {
  if (r.query.sql) return vizFromRows(r);
  const dims = r.query.dimensions ?? [];
  const time = dims.find((d) => d.includes(':'));
  if (!dims.length) return { kind: 'number', title: 'Result', y: r.query.measures };
  return {
    kind: time ? 'line' : 'bar',
    title: 'Result',
    x: time ?? dims[0],
    y: (r.query.measures ?? []).slice(0, 2),
    series: dims.length > 1 ? dims.find((d) => d !== (time ?? dims[0])) : null,
  };
};

/** Fields the agent made survive a reload of the model, which only knows the built-in ones. */
const keepCustom = (old: ModelTopic[], t: ModelTopic) => {
  const was = old.find((o) => o.topic === t.topic);
  return {
    dimensions: [...t.dimensions, ...(was?.dimensions.filter((f) => f.custom) ?? [])],
    measures: [...t.measures, ...(was?.measures.filter((f) => f.custom) ?? [])],
  };
};

/** Made fields as the backend expects them in a query, so the field list can use them too. */
const customSpecs = (fields: ModelTopic['dimensions']) =>
  fields.map((f) => ({
    name: f.field,
    label: f.label,
    kind: f.type ?? 'measure',
    sql: f.sql ?? '',
    description: f.description,
  }));

export default function DataAgentPage() {
  const [topics, setTopics] = useState<ModelTopic[]>([]);
  const [dashboards, setDashboards] = useState<Record<string, Tile[]>>({});
  const [view, setView] = useState<'workbook' | 'dashboards'>('workbook');
  const [lines, setLines] = useState<Line[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [models, setModels] = useState(MODELS);
  const [model, setModel] = useState(MODELS[0]);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [viz, setViz] = useState<Viz | null>(null);
  const [tab, setTab] = useState<'results' | 'chart' | 'both' | 'sql'>('both');
  const [topic, setTopic] = useState('pull_requests');
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [board, setBoard] = useState<{ name: string; tiles: Tile[] } | null>(null);
  const [schema, setSchema] = useState<SchemaTable[]>([]);
  const [pane, setPane] = useState<'fields' | 'schema'>('fields');
  const [sqlText, setSqlText] = useState('');
  const [viewers, setViewers] = useState<DataViewer[]>([]);
  const [viewer, setViewer] = useState('maya');
  const session = useRef<string | undefined>(undefined);
  const scroller = useRef<HTMLDivElement>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    statusService.status().then((s) => {
      if (!s.models?.length) return;
      setModels(s.models); // the local model first, when one is configured
      setModel(s.default_model ?? s.models[0]);
    });
  }, []);

  const loadModel = () =>
    svc
      .model()
      .then((m) => {
        setTopics((old) => m.topics.map((t) => ({ ...t, ...keepCustom(old, t) })));
        setSchema(m.schema.tables);
        setDashboards(m.dashboards);
      })
      .catch((e: Error) => setError(e.message));
  useEffect(() => {
    svc.signIn(viewer);
    void loadModel();
    svc
      .viewers()
      .then((r) => setViewers(r.viewers))
      .catch((e: Error) => setError(e.message));
    return () => abort.current?.abort();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /** Signing in as someone else starts afresh: their company's schema, dashboards and a new workbook. */
  function signInAs(id: string) {
    abort.current?.abort();
    svc.signIn(id);
    setViewer(id);
    session.current = undefined;
    setLines([]);
    setResult(null);
    setViz(null);
    setBoard(null);
    setSqlText('');
    setError('');
    setTopics([]);
    void loadModel();
  }
  useEffect(() => {
    if (result) setSqlText(inline(result.sql, result.params));
  }, [result]);
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [lines, busy]);

  async function ask(question: string) {
    if (!question.trim() || busy) return;
    setBusy(true);
    setError('');
    setLines((ls) => [...ls, { kind: 'user', text: question }]);
    const ctl = new AbortController();
    abort.current = ctl;
    try {
      await svc.ask(
        { question, session_id: session.current, model },
        (e: AgentEvent) => {
          if (e.type === 'session') session.current = e.session_id;
          else if (e.type === 'text') setLines((ls) => [...ls, { kind: 'text', text: e.text }]);
          else if (e.type === 'step')
            setLines((ls) => [
              ...ls,
              { kind: 'step', label: e.label, detail: e.detail, input: e.input, error: e.error, sql: e.sql },
            ]);
          else if (e.type === 'query') {
            setResult(e);
            setViz(null);
            if (e.query.topic) setTopic(e.query.topic);
          } else if (e.type === 'viz') setViz(e.viz);
          else if (e.type === 'field') {
            const { measure, ...f } = e.field;
            setTopics((ts) =>
              ts.map((t) =>
                t.topic !== e.topic
                  ? t
                  : measure
                    ? { ...t, measures: [...t.measures.filter((m) => m.field !== f.field), { ...f, custom: true }] }
                    : {
                        ...t,
                        dimensions: [...t.dimensions.filter((d) => d.field !== f.field), { ...f, custom: true }],
                      },
              ),
            );
          } else if (e.type === 'tile')
            setDashboards((d) => ({ ...d, [e.dashboard]: [...(d[e.dashboard] ?? []), e.tile] }));
          else if (e.type === 'done') setLines((ls) => [...ls, { kind: 'done', cost: e.cost_usd }]);
          else if (e.type === 'error') setError(e.message);
        },
        ctl.signal,
      );
    } catch (e) {
      if (!ctl.signal.aborted) setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const q = draft;
    setDraft('');
    void ask(q);
  }

  /** The field picker edits the current query and runs it straight through the compiler: no model, no cost. */
  async function toggle(field: string, isMeasure: boolean) {
    const custom = [...(t?.dimensions ?? []), ...(t?.measures ?? [])].filter((f) => f.custom);
    const q: DataQuery =
      result && result.query.topic === topic
        ? { ...result.query }
        : { topic, dimensions: [], measures: [], custom_fields: result?.query.custom_fields };
    if (custom.length && !q.custom_fields?.length) q.custom_fields = customSpecs(custom);
    const key = isMeasure ? 'measures' : 'dimensions';
    const list = [...(q[key] ?? [])];
    const at = list.indexOf(field);
    if (at >= 0) list.splice(at, 1);
    else list.push(field);
    q[key] = list;
    if (!q.dimensions?.length && !q.measures?.length) return;
    try {
      const r = await svc.query({
        ...q,
        filters: q.filters ?? [],
        sorts: (q.sorts ?? []).filter((s) => [...(q.dimensions ?? []), ...(q.measures ?? [])].includes(s.field)),
      });
      setResult(r);
      setViz(defaultViz(r));
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }

  /** SQL typed or edited in the SQL tab runs with the agent's checks, read-only, at no cost. */
  async function runSql() {
    try {
      const r = await svc.sql(sqlText);
      setResult(r);
      setViz(vizFromRows(r));
      setTab('both');
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function removeFilter(i: number) {
    if (!result) return;
    const q = { ...result.query, filters: (result.query.filters ?? []).filter((_, k) => k !== i) };
    const r = await svc.query({
      ...q,
      dimensions: q.dimensions ?? [],
      measures: q.measures ?? [],
      sorts: q.sorts ?? [],
    });
    setResult(r);
  }

  const t = topics.find((x) => x.topic === topic);
  const inUse = new Set(
    [
      ...(result?.query.dimensions ?? []),
      ...(result?.query.measures ?? []),
      ...(result?.query.filters ?? []).map((f) => f.field),
    ].map((f) => f.split(':')[0]),
  );
  const match = (f: { field: string; label: string }) =>
    !search || `${f.field} ${f.label}`.toLowerCase().includes(search.toLowerCase());
  const shown = viz ?? (result ? defaultViz(result) : null);

  return (
    <main className="page-dataagent">
      <div className="kicker">Lab 45 · A data agent with a semantic layer</div>
      <h1>Ask the data: an analytics agent on Claude</h1>
      <p className="lede">
        A workbook for engineering data: pull requests, reviews and issues since 2022, for three invented companies in
        one warehouse. Ask a question and Claude writes the query, runs it on the database, and builds the chart and
        dashboard tiles from the rows that come back. It works three ways: through the semantic model (field names,
        compiled to SQL), by adding a field the model lacks, or by writing SQL itself. Whoever writes the query, it sees
        only the signed-in person&apos;s company. Every step shows on the left, and you can change any query yourself in
        the field list or the SQL tab, at no cost.
      </p>

      <div className="da-tabs">
        <button className={view === 'workbook' ? 'on' : ''} onClick={() => setView('workbook')}>
          Workbook
        </button>
        <button
          className={view === 'dashboards' ? 'on' : ''}
          onClick={() => {
            setView('dashboards');
            void loadModel();
          }}
        >
          Dashboards ({Object.keys(dashboards).length})
        </button>
        <label className="small">
          Signed in as{' '}
          <select value={viewer} onChange={(e) => signInAs(e.target.value)}>
            {viewers.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name} · {v.company}
              </option>
            ))}
          </select>
        </label>
        <label className="small">
          Model{' '}
          <select value={model} onChange={(e) => setModel(e.target.value)}>
            {models.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
        </label>
      </div>
      {error && <p className="da-bad small">{error}</p>}

      {view === 'workbook' && (
        <div className="da-layout">
          <section className="da-chat" aria-label="Workbook agent">
            <header>Workbook agent</header>
            <div className="da-lines" ref={scroller}>
              {lines.length === 0 && (
                <div className="da-examples">
                  {EXAMPLES.map((e) => (
                    <button key={e} className="da-chip" onClick={() => void ask(e)}>
                      {e}
                    </button>
                  ))}
                </div>
              )}
              {lines.map((l, i) =>
                l.kind === 'user' ? (
                  <div key={i} className="da-user">
                    {l.text}
                  </div>
                ) : l.kind === 'text' ? (
                  <div key={i} className="da-text">
                    {rich(l.text)}
                  </div>
                ) : l.kind === 'done' ? (
                  <div key={i} className="da-cost small muted">
                    ${l.cost.toFixed(4)}
                  </div>
                ) : (
                  <details key={i} className={`da-step${l.error ? ' bad' : ''}`}>
                    <summary>
                      <b>{l.label}</b> <span>{l.detail}</span>
                    </summary>
                    <pre>
                      {JSON.stringify(l.input, null, 2)}
                      {l.sql && l.sql !== l.input.sql ? `\n\n${l.sql}` : ''}
                    </pre>
                  </details>
                ),
              )}
              {busy && <div className="da-thinking small muted">Thinking…</div>}
            </div>
            <form className="da-input" onSubmit={onSubmit}>
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Ask a question about your data…"
                disabled={busy}
                aria-label="Question"
              />
              <button className="btn primary" disabled={busy || !draft.trim()}>
                Ask
              </button>
            </form>
          </section>

          <section className="da-fields" aria-label="Fields">
            <div className="da-pane">
              <button className={pane === 'fields' ? 'on' : ''} onClick={() => setPane('fields')}>
                Fields
              </button>
              <button className={pane === 'schema' ? 'on' : ''} onClick={() => setPane('schema')}>
                Schema
              </button>
            </div>
            {pane === 'schema' &&
              schema.map((tb) => (
                <details key={tb.table} className="da-schema" open={tb.table === 'pull_requests'}>
                  <summary>
                    <b>{tb.table}</b> <span className="muted small">{tb.rows.toLocaleString('en-GB')} rows</span>
                  </summary>
                  <p className="small muted">{tb.note}</p>
                  {tb.columns.map((c) => (
                    <div key={c.name} className="da-col" title={c.values?.join(', ')}>
                      <code>{c.name}</code> <span className="muted">{c.type.toLowerCase()}</span>
                    </div>
                  ))}
                </details>
              ))}
            {pane === 'fields' && (
              <>
                <select value={topic} onChange={(e) => setTopic(e.target.value)} aria-label="Topic">
                  {topics.map((x) => (
                    <option key={x.topic} value={x.topic}>
                      {x.label}
                    </option>
                  ))}
                </select>
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search fields"
                  aria-label="Search fields"
                />
                {t && (
                  <>
                    <b className="small">Dimensions</b>
                    {t.dimensions.filter(match).map((f) => (
                      <div key={f.field}>
                        <button
                          className={`da-field${inUse.has(f.field) ? ' on' : ''}`}
                          title={f.description}
                          onClick={() =>
                            f.type === 'timestamp'
                              ? setOpen(open === f.field ? null : f.field)
                              : void toggle(f.field, false)
                          }
                        >
                          <span className="da-type">
                            {f.type === 'timestamp'
                              ? '◷'
                              : f.type === 'number'
                                ? '#'
                                : f.type === 'boolean'
                                  ? '✓'
                                  : 'A'}
                          </span>
                          {f.label}
                          {f.custom && <span className="da-new">new</span>}
                        </button>
                        {open === f.field && (
                          <div className="da-timeframes">
                            {t.timeframes.map((tf) => (
                              <button
                                key={tf}
                                className="da-chip"
                                onClick={() => void toggle(`${f.field}:${tf}`, false)}
                              >
                                {tf.replace('_', ' ')}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                    <b className="small">Measures</b>
                    {t.measures.filter(match).map((f) => (
                      <button
                        key={f.field}
                        className={`da-field measure${inUse.has(f.field) ? ' on' : ''}`}
                        title={f.description}
                        onClick={() => void toggle(f.field, true)}
                      >
                        <span className="da-type">Σ</span>
                        {f.label}
                        {f.custom && <span className="da-new">new</span>}
                      </button>
                    ))}
                  </>
                )}
              </>
            )}
          </section>

          <section className="da-results" aria-label="Results">
            <div className="da-bar">
              {(['results', 'chart', 'both', 'sql'] as const).map((k) => (
                <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
                  {k === 'sql' ? 'SQL' : k[0].toUpperCase() + k.slice(1)}
                </button>
              ))}
              {result && (
                <span className="small muted">
                  {result.query.sql ? 'SQL' : 'Semantic model'} · {result.row_count.toLocaleString('en-GB')} rows
                  {result.truncated ? ' (cut off)' : ''}
                  {result.cached ? ', from cache' : ''} · {result.ms} ms
                  {result.company ? ` · ${result.company} only` : ''}
                </span>
              )}
            </div>
            {result ? (
              <>
                <div className="da-filters">
                  {(result.query.filters ?? []).map((f, i) => (
                    <span key={i} className="da-filter">
                      <small>{label(f.field)}</small> {f.op.replace('_', ' ')} {(f.values ?? []).join(', ')}{' '}
                      <button onClick={() => void removeFilter(i)} aria-label="Remove filter">
                        ×
                      </button>
                    </span>
                  ))}
                </div>
                {shown && (tab === 'chart' || tab === 'both') && (
                  <div className="da-card">
                    <b>{shown.title}</b>
                    <Chart rows={result.rows} columns={result.columns} viz={shown} />
                  </div>
                )}
                {(tab === 'results' || tab === 'both') && (
                  <Table rows={result.rows} columns={result.columns} max={tab === 'both' ? 12 : 200} />
                )}
              </>
            ) : (
              <p className="small muted">Ask a question, pick fields on the left, or write SQL in the SQL tab.</p>
            )}
            {tab === 'sql' && (
              <div className="da-editor">
                <textarea
                  value={sqlText}
                  onChange={(e) => setSqlText(e.target.value)}
                  spellCheck={false}
                  aria-label="SQL"
                  placeholder="SELECT ... FROM pull_requests ..."
                />
                <button className="btn primary" onClick={() => void runSql()} disabled={!sqlText.trim()}>
                  Run SQL
                </button>
                <span className="small muted">
                  SQLite, read-only: one SELECT, at most 5,000 rows and 5 seconds, on your company&apos;s rows only.
                  Values the compiler passed as parameters are written in. Try removing the <code>company_id</code>{' '}
                  filter: the count does not change.
                </span>
              </div>
            )}
          </section>
        </div>
      )}

      {view === 'dashboards' && (
        <div>
          {Object.keys(dashboards).length === 0 && (
            <p className="small muted">
              No dashboards yet. Ask the agent to “create a dashboard of engineering activity”.
            </p>
          )}
          <div className="da-chips">
            {Object.keys(dashboards).map((name) => (
              <button
                key={name}
                className={`da-chip${board?.name === name ? ' on' : ''}`}
                onClick={() => void svc.dashboard(name).then(setBoard)}
              >
                {name} ({dashboards[name].length})
              </button>
            ))}
          </div>
          {board && (
            <>
              <h2>
                {board.name}{' '}
                <button
                  className="btn small"
                  onClick={() =>
                    void svc.deleteDashboard(board.name).then((r) => {
                      setDashboards(r.dashboards);
                      setBoard(null);
                    })
                  }
                >
                  Delete
                </button>
              </h2>
              <div className="da-tiles">
                {board.tiles.map((tl) => (
                  <div key={tl.id} className="da-card">
                    <b>{tl.title}</b>
                    {tl.error ? (
                      <p className="da-bad small">{tl.error}</p>
                    ) : (
                      <Chart rows={tl.rows ?? []} columns={tl.columns ?? []} viz={tl.viz} height={240} />
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      <h2>How the harness works</h2>
      <div className="grid2">
        <div className="card">
          <h3>Model first, then a new field, then SQL</h3>
          <p>
            Three topics (pull requests, reviews, issues) declare their tables, joins and fields: dimensions, timeframes
            for timestamps (<code>merged_at:week</code>), and measures such as merge rate. Asked by field name, the
            compiler checks every name, puts values in parameters and builds the SQL, so &ldquo;merge rate&rdquo; means
            the same in every chart. If a field is missing, the agent defines it as one expression; it is tried once and
            then joins the model, marked <i>new</i>. If the model cannot express the question (two topics, a rank, a
            subquery), the agent reads the schema and writes SQL itself.
          </p>
        </div>
        <div className="card">
          <h3>Nine tools, and what keeps them safe</h3>
          <p>
            Search the model, describe a topic, look up values, run a query, create a field, read the schema, run SQL,
            set the chart, add to a dashboard. Whoever writes the SQL, it runs on a read-only connection whose
            authorizer allows only reads (no writes, PRAGMA or ATTACH), one statement, at most 5,000 rows and 5 seconds.
            Errors go back to the model, so it fixes its own query. The chart is set from the returned columns, and a
            tile keeps its query, so a dashboard runs it again. About a fifth of a cent a question on Haiku.
          </p>
        </div>
      </div>
      <div className="grid2" style={{ marginTop: 14 }}>
        <div className="card">
          <h3>Row-level security, below the model</h3>
          <p>
            Telling the model &ldquo;filter by company&rdquo; is not security: it writes the SQL, so it can leave the
            filter out, or be talked out of it. Here the company comes from the sign-in, never from the model or the
            request body. Every query, compiled or hand-written, runs on a copy of the warehouse that holds only that
            company&apos;s rows, so there is nothing else to reach. The compiler also adds <code>company_id = ?</code>{' '}
            to every semantic query, and the cache, workbooks and dashboards are kept per company. The prompt only names
            the company, so the agent can explain why it cannot compare with others.
          </p>
        </div>
        <div className="card">
          <h3>Why not a filtered view?</h3>
          <p>
            The first version tried temporary views named like the tables, each filtered to one company, with the
            authorizer refusing direct reads. It leaked:{' '}
            <code>WITH pull_requests AS (SELECT * FROM main.pull_requests)</code> names a CTE after the view, and the
            authorizer reports it under the same name. SQLite has no row policies. On a database that does, use them:
            Postgres <code>CREATE POLICY</code> with the company set per connection (and a role that cannot bypass it),
            Snowflake row access policies, BigQuery row-level access policies, Azure SQL security policies. Otherwise
            give each company its own schema or database.
          </p>
        </div>
      </div>
      <table className="da-table" style={{ marginTop: 14 }}>
        <thead>
          <tr>
            <th>Choice</th>
            <th>Why</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>The semantic model comes first</td>
            <td>Agreed definitions, no made-up columns, no wrong joins. SQL is the fallback, not the default.</td>
          </tr>
          <tr>
            <td>New fields are tried once before they are kept</td>
            <td>A bad expression fails as a tool error the model can fix, not as a broken chart later.</td>
          </tr>
          <tr>
            <td>The database refuses, not just the prompt</td>
            <td>A read-only connection and an authorizer stop a write even if the SQL check were fooled.</td>
          </tr>
          <tr>
            <td>The company comes from the sign-in, not the prompt</td>
            <td>No tool takes a company. A question, a prompt injection or a hand-written query cannot widen it.</td>
          </tr>
          <tr>
            <td>The cache key includes the company</td>
            <td>
              The same SQL gives different rows for each company; a shared cache would serve one&apos;s rows to another.
            </td>
          </tr>
          <tr>
            <td>Someone else&apos;s session starts a new workbook</td>
            <td>The old conversation holds the other company&apos;s rows, so it is never carried over.</td>
          </tr>
          <tr>
            <td>Look up values before filtering</td>
            <td>
              &ldquo;the harbour repo&rdquo; becomes the exact value <code>harbour</code>, not a guess.
            </td>
          </tr>
          <tr>
            <td>The model sees the first 40 rows and a summary</td>
            <td>Long results do not fill the context; the page shows them all.</td>
          </tr>
          <tr>
            <td>&ldquo;check&rdquo; queries leave the chart alone</td>
            <td>The agent can look up the top weeks without replacing what you asked to see.</td>
          </tr>
          <tr>
            <td>The field list and SQL tab run the same checks</td>
            <td>A person can correct the agent&apos;s query, or its SQL, without asking again.</td>
          </tr>
        </tbody>
      </table>
      <p className="small muted">
        Tools such as this one (a semantic layer, an agent that searches it, a workbook beside the chat) are common in
        business-intelligence products; this is a small, open version to learn from, on invented data.
      </p>
    </main>
  );
}
