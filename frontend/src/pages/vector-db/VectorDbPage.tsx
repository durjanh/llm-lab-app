import { useCallback, useEffect, useMemo, useState } from 'react';
import { modelName } from '@/lib/models';
import { statusService } from '@/services/statusService';
import {
  vectorDbService,
  type VectorAdded,
  type VectorAnswer,
  type VectorDbStatus,
  type VectorList,
  type VectorRow,
  type VectorSearchResult,
} from '@/services/vectorDbService';
import './vector-db.css';

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const usd = (v: number) => `$${v < 0.1 ? v.toFixed(4) : v.toFixed(2)}`;
const kb = (bytes: number) => `${Math.round(bytes / 1024).toLocaleString('en-GB')} KB`;
const NAME = /^[\w .,()'&-]{1,80}$/;
const TRUSTED = 'The server (sees everything)';
/** Comma-separated tags, as the API wants them: lower case, letters, digits and hyphens. */
const tagList = (raw: string) =>
  raw
    .split(',')
    .map((t) =>
      t
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-'),
    )
    .filter(Boolean)
    .slice(0, 8);
const readerOrNull = (r: string) => (r === TRUSTED ? null : r);

const LISTS = [
  {
    key: 'semantic',
    title: 'By meaning',
    help: 'Cosine similarity between the question’s vector and each chunk’s: 1 is the same direction.',
  },
  {
    key: 'keyword',
    title: 'By words',
    help: 'Postgres full-text search: the chunks that share a word with the question (after stemming), ranked by how many and how close.',
  },
  {
    key: 'hybrid',
    title: 'Both, fused',
    help: 'Reciprocal rank fusion: each list gives 1/(60 + place), so a chunk near the top of either list rises.',
  },
] as const;

function score(list: (typeof LISTS)[number]['key'], r: VectorRow): string {
  if (list === 'semantic') return (r.similarity ?? 0).toFixed(3);
  if (list === 'keyword') return (r.rank ?? 0).toFixed(2);
  return (r.score ?? 0).toFixed(4);
}

/** One ranked list of chunks. Hovering a chunk marks it in the other lists too. */
function Results({
  list,
  data,
  hover,
  setHover,
}: {
  list: (typeof LISTS)[number];
  data: VectorList;
  hover: number | null;
  setHover: (id: number | null) => void;
}) {
  return (
    <div className="vd-list">
      <div className="vd-list-head">
        <b>{list.title}</b> <span className="mono small muted">{data.ms} ms</span>
      </div>
      <p className="small muted">{list.help}</p>
      {data.rows.length === 0 && <p className="small muted">Nothing matched.</p>}
      <ol>
        {data.rows.map((r) => (
          <li
            key={r.id}
            className={hover === r.id ? 'on' : ''}
            onMouseEnter={() => setHover(r.id)}
            onMouseLeave={() => setHover(null)}
          >
            <div className="vd-meta">
              <span className="mono vd-score">{score(list.key, r)}</span>
              <span className="small muted">
                {r.source} · chunk {r.chunk}
              </span>
              {r.access && r.access !== 'everyone' && <span className={`vd-access a-${r.access}`}>{r.access}</span>}
              {list.key === 'hybrid' && (
                <span className="small muted">
                  meaning {r.semantic_place ? `#${r.semantic_place}` : '–'}, words{' '}
                  {r.keyword_place ? `#${r.keyword_place}` : '–'}
                </span>
              )}
            </div>
            <div className="vd-text">{r.content}</div>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** An answer with its [n] citations shown as chips; a number it was not given is marked. */
function Cited({ answer, unknown }: { answer: string; unknown: number[] }) {
  const parts = answer.split(/(\[\d{1,3}\])/);
  return (
    <p className="vd-answer">
      {parts.map((p, i) => {
        const m = /^\[(\d+)\]$/.exec(p);
        if (!m) return <span key={i}>{p}</span>;
        const bad = unknown.includes(Number(m[1]));
        return (
          <span
            key={i}
            className={`vd-cite${bad ? ' bad' : ''}`}
            title={bad ? 'Not one of the passages it was given' : ''}
          >
            {m[1]}
          </span>
        );
      })}
    </p>
  );
}

/** A vector database you run yourself: PostgreSQL with pgvector, filled and searched with the local embedding model. */
export default function VectorDbPage() {
  const [status, setStatus] = useState<VectorDbStatus | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [collection, setCollection] = useState('handbook');
  const [source, setSource] = useState('');
  const [text, setText] = useState('');
  const [added, setAdded] = useState<VectorAdded | null>(null);
  const [query, setQuery] = useState('How many days of holiday do I get?');
  const [k, setK] = useState(5);
  const [found, setFound] = useState<VectorSearchResult | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState('');
  const [answer, setAnswer] = useState<VectorAnswer | null>(null);
  const [cost, setCost] = useState(0);
  const [access, setAccess] = useState('everyone');
  const [docTags, setDocTags] = useState('');
  const [reader, setReader] = useState<string>('Sam (staff)');
  const [filterTags, setFilterTags] = useState('');

  const refresh = useCallback(async () => {
    try {
      setStatus(await vectorDbService.status());
    } catch (err) {
      setError(errorText(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    statusService
      .status()
      .then((s) => {
        setModels(s.models || []);
        setModel(s.default_model || s.models?.[0] || '');
      })
      .catch(() => undefined);
  }, [refresh]);

  const collections = useMemo(() => {
    const names = new Set((status?.sources ?? []).map((s) => s.collection));
    return [...names].sort();
  }, [status]);

  useEffect(() => {
    if (collections.length && !collections.includes(collection)) setCollection(collections[0]);
  }, [collections]); // only when what is stored changes

  const ready = !!status?.embedder.has_model && !!status?.database.running && !status.database.error;

  async function work<T>(label: string, task: () => Promise<T>): Promise<T | undefined> {
    setBusy(label);
    setError('');
    try {
      return await task();
    } catch (err) {
      setError(errorText(err));
      return undefined;
    } finally {
      setBusy('');
    }
  }

  async function loadSample(key: string) {
    const r = await work('Embedding and storing the sample…', () => vectorDbService.addSamples(key));
    if (r) {
      setCollection(r.collection);
      await refresh();
    }
  }

  async function addDocument() {
    const r = await work('Chunking, embedding and storing…', () =>
      vectorDbService.add(collection.trim(), source.trim(), text, access, tagList(docTags)),
    );
    if (r) {
      setAdded(r);
      setText('');
      await refresh();
    }
  }

  async function remove(c: string, s?: string) {
    const what = s ? `“${s}” from ${c}` : `every document in ${c}`;
    if (!window.confirm(`Delete ${what}?`)) return;
    if (await work('Deleting…', () => vectorDbService.remove(c, s))) await refresh();
  }

  async function search() {
    setAnswer(null);
    const r = await work('Searching…', () =>
      vectorDbService.search(collection, query.trim(), k, readerOrNull(reader), tagList(filterTags)),
    );
    if (r) setFound(r);
  }

  async function ask() {
    const r = await work(`Asking ${modelName(model)}…`, () =>
      vectorDbService.answer(collection, query.trim(), k, model, readerOrNull(reader), tagList(filterTags)),
    );
    if (r) {
      setAnswer(r);
      setCost((c) => c + r.cost_usd);
    }
  }

  const addProblem =
    !NAME.test(collection.trim()) || !NAME.test(source.trim())
      ? "Name the collection and the document (letters, numbers, spaces and . , ( ) ' & -)."
      : !text.trim()
        ? 'Paste some text, or open a .md or .txt file.'
        : '';

  const db = status?.database;
  const bySource = status?.sources ?? [];

  return (
    <main className="page-vector-db">
      <div className="kicker">Building · Vector database</div>
      <h1>A vector database you run yourself</h1>
      <p className="lede">
        PostgreSQL with the pgvector extension, in Docker on this machine. Each document is cut into chunks, the open
        embedding model turns each chunk into a list of numbers, and Postgres keeps the text, the numbers and a word
        index side by side. A question is then matched by meaning, by words, or both. Everything here is free and stays
        on this machine; only the optional answer at the end calls a model.
      </p>

      {status && !status.embedder.has_model && (
        <div className="vd-setup small">
          The local embedding model is not ready. From the repo root run <code>./tools/local-model.sh --embed</code>,
          add <code>LLM_LAB_LOCAL_EMBED_MODEL=ai/nomic-embed-text-v1.5</code> to <code>.env</code> and restart the
          backend.
        </div>
      )}
      {db && (!db.running || db.error) && (
        <div className="vd-setup small">
          {db.error || 'PostgreSQL is not running.'} From the repo root run <code>./tools/vector-db.sh</code>, then{' '}
          <button className="btn small" onClick={() => void refresh()}>
            check again
          </button>
        </div>
      )}
      {db?.running && (
        <div className="vd-strip small">
          <span>
            <b>PostgreSQL</b> {db.server?.split(' ')[0]}
          </span>
          <span>
            <b>pgvector</b> {db.pgvector}
          </span>
          <span className="mono">{db.where}</span>
          <span>
            <b>Embeddings</b> {status?.embedder.model?.replace(/^ai\//, '')}
            {status?.dims ? `, ${status.dims} numbers each` : ''}
          </span>
          {(db.tables ?? []).map((t) => (
            <span key={t.name}>
              <span className="mono">{t.name}</span>: {t.rows.toLocaleString('en-GB')} rows, {kb(t.bytes)}
            </span>
          ))}
        </div>
      )}
      {error && <p className="vd-bad small">{error}</p>}
      {busy && (
        <p className="small" aria-live="polite">
          <span className="vd-pulse" /> {busy}
        </p>
      )}

      <section className="card vd-step">
        <h2>1. Put documents in</h2>
        <div className="vd-row">
          {Object.entries(status?.samples ?? {}).map(([key, s]) => (
            <button
              key={key}
              className="btn small"
              disabled={!ready || !!busy}
              onClick={() => void loadSample(key)}
              title={`${s.documents} invented document${s.documents === 1 ? '' : 's'}, into the “${s.collection}” collection`}
            >
              Load: {s.title}
            </button>
          ))}
        </div>
        <div className="vd-form">
          <label>
            Collection
            <input
              list="vd-collections"
              value={collection}
              onChange={(e) => setCollection(e.target.value)}
              maxLength={80}
            />
            <datalist id="vd-collections">
              {collections.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </label>
          <label>
            Document name
            <input value={source} onChange={(e) => setSource(e.target.value)} maxLength={80} placeholder="e.g. notes" />
          </label>
          <label>
            Who may read it
            <select value={access} onChange={(e) => setAccess(e.target.value)}>
              {(status?.access ?? ['everyone']).map((a) => (
                <option key={a}>{a}</option>
              ))}
            </select>
          </label>
          <label>
            Tags
            <input value={docTags} onChange={(e) => setDocTags(e.target.value)} placeholder="e.g. policy, pay" />
          </label>
          <label className="btn small vd-file">
            Open a .md or .txt file
            <input
              type="file"
              accept=".md,.markdown,.txt,text/plain,text/markdown"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (!f) return;
                if (f.size > 200_000) return setError('A document can be up to 200,000 characters.');
                setText(await f.text());
                if (!source.trim()) setSource(f.name.replace(/\.[^.]+$/, '').slice(0, 80));
              }}
            />
          </label>
        </div>
        <textarea
          className="vd-textarea"
          rows={6}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Paste text here. Markdown headings (## …) start a new chunk and are kept on each chunk under them."
        />
        <div className="vd-row">
          <button
            className="btn primary"
            disabled={!ready || !!busy || !!addProblem}
            onClick={() => void addDocument()}
          >
            Add to the database
          </button>
          {addProblem && text && <span className="small muted">{addProblem}</span>}
          <span className="small muted">
            Chunks of up to {status?.chunk_chars ?? 700} characters. Adding a document with a name already used in the
            collection replaces it.
          </span>
        </div>

        {added && (
          <div className="vd-added">
            <p className="small">
              <b>{added.source}</b>: {added.chunks} chunk{added.chunks === 1 ? '' : 's'}, embedded in {added.embed_ms}{' '}
              ms and stored in {added.store_ms} ms. The first few, with the start of each vector:
            </p>
            <div className="vd-chunks">
              {added.preview.map((p) => (
                <div key={p.chunk} className="vd-chunk">
                  <div className="small muted">chunk {p.chunk}</div>
                  <div className="vd-text">{p.content}</div>
                  <div className="mono small vd-vec">
                    [{p.head.join(', ')}, … {added.dims - p.head.length} more]
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {bySource.length > 0 && (
          <div className="table-wrap">
            <table className="t vd-sources">
              <thead>
                <tr>
                  <th>Collection</th>
                  <th>Document</th>
                  <th>Chunks</th>
                  <th>Characters</th>
                  <th>Who may read</th>
                  <th>Tags</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {bySource.map((s, i) => (
                  <tr key={`${s.collection}/${s.source}`}>
                    <td>
                      {(i === 0 || bySource[i - 1].collection !== s.collection) && (
                        <>
                          <b>{s.collection}</b>{' '}
                          <button
                            className="vd-link small"
                            disabled={!!busy}
                            onClick={() => void remove(s.collection)}
                            title="Delete every document in this collection"
                          >
                            empty
                          </button>
                        </>
                      )}
                    </td>
                    <td>{s.source}</td>
                    <td className="mono">{s.chunks}</td>
                    <td className="mono">{s.characters?.toLocaleString('en-GB')}</td>
                    <td>
                      <span className={`vd-access a-${s.access ?? 'everyone'}`}>{s.access ?? 'everyone'}</span>
                    </td>
                    <td className="small">{(s.tags ?? []).join(', ')}</td>
                    <td>
                      <button
                        className="vd-link small"
                        disabled={!!busy}
                        onClick={() => void remove(s.collection, s.source)}
                      >
                        delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card vd-step">
        <h2>2. Search it three ways</h2>
        <form
          className="vd-row"
          onSubmit={(e) => {
            e.preventDefault();
            void search();
          }}
        >
          <select value={collection} onChange={(e) => setCollection(e.target.value)} disabled={!!busy}>
            {(collections.length ? collections : [collection]).map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
          <input
            className="vd-query"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            maxLength={500}
            placeholder="Ask in your own words"
          />
          <select value={reader} onChange={(e) => setReader(e.target.value)} title="Search as this person">
            {Object.entries(status?.readers ?? {}).map(([name, groups]) => (
              <option key={name} value={name}>
                as {name}: {groups.join(', ')}
              </option>
            ))}
            <option value={TRUSTED}>as {TRUSTED}</option>
          </select>
          <input
            className="vd-tags"
            value={filterTags}
            onChange={(e) => setFilterTags(e.target.value)}
            placeholder="only tags…"
            title="Only chunks with any of these tags, comma separated"
          />
          <select value={k} onChange={(e) => setK(Number(e.target.value))} title="How many chunks each list returns">
            {[3, 5, 8, 10].map((n) => (
              <option key={n} value={n}>
                top {n}
              </option>
            ))}
          </select>
          <button className="btn primary" disabled={!ready || !!busy || !query.trim()}>
            Search
          </button>
        </form>
        <p className="small muted">
          Try a question that uses different words from the text (“time off a year” against “annual leave”), then one
          that names an exact term. By meaning finds the first; by words finds the second; fused tends to find both.
        </p>

        {found && (
          <>
            {found.reader !== undefined && (
              <p className={`small vd-rls${found.hidden ? ' some' : ''}`}>
                {found.reader ? (
                  <>
                    Searched as <b>{found.reader}</b> (groups: {found.groups?.join(', ')}). Row-level security showed{' '}
                    {found.visible} of {(found.visible ?? 0) + (found.hidden ?? 0)} chunks in this collection
                    {found.hidden ? `; PostgreSQL hid ${found.hidden} before any search ran` : ''}.
                  </>
                ) : (
                  <>Searched as the trusted server: every chunk is visible.</>
                )}
              </p>
            )}
            <p className="small muted">
              The question became {found.dims} numbers in {found.embed_ms} ms:{' '}
              <span className="mono">[{found.query_head.join(', ')}, …]</span>
            </p>
            <div className="vd-lists">
              {LISTS.map((l) => (
                <Results key={l.key} list={l} data={found[l.key]} hover={hover} setHover={setHover} />
              ))}
            </div>
            <details className="vd-sql">
              <summary>The SQL each list ran</summary>
              {LISTS.map((l) => (
                <div key={l.key}>
                  <h3>{l.title}</h3>
                  <pre>{found[l.key].sql}</pre>
                </div>
              ))}
              <p className="small muted">
                %(vector)s is the question’s {found.dims} numbers, sent as a parameter like any other value, never
                pasted into the SQL.
              </p>
            </details>
            <details className="vd-sql">
              <summary>How PostgreSQL ran the search by meaning (EXPLAIN)</summary>
              <pre>{found.plan}</pre>
              <p className="small muted">
                With a few hundred chunks, Postgres usually finds the collection’s rows by the ordinary index and sorts
                them by distance: exact, and quick enough. With many thousands, the plan switches to{' '}
                <span className="mono">Index Scan using chunks_{found.dims}_embedding</span>, the HNSW graph, which
                looks at a small part of the table and is approximate: it can miss a close match now and then in
                exchange for speed.
              </p>
            </details>
          </>
        )}
      </section>

      {found && (
        <section className="card vd-step">
          <h2>3. Answer from what was found (optional)</h2>
          <p className="small">
            Retrieval-augmented generation: the fused chunks go to a model with the question, and it answers from them
            only, citing each by number. Code checks every citation is one it was given.
          </p>
          <div className="vd-row">
            <select value={model} onChange={(e) => setModel(e.target.value)} disabled={!!busy}>
              {models.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
            <button className="btn primary" disabled={!!busy || !model} onClick={() => void ask()}>
              Answer
            </button>
            <span className="small muted">Model calls on this page: {usd(cost)}</span>
          </div>
          {answer && (
            <div className="vd-answer-box">
              <Cited answer={answer.answer} unknown={answer.unknown} />
              {answer.unknown.length > 0 && (
                <p className="vd-bad small">
                  It cited {answer.unknown.map((n) => `[${n}]`).join(', ')}, which it was not given.
                </p>
              )}
              <ol className="vd-passages">
                {answer.passages.map((p, i) => (
                  <li key={p.id} className={answer.cited.includes(i + 1) ? 'cited' : ''}>
                    <span className="small muted">
                      {p.source} · chunk {p.chunk}
                      {answer.cited.includes(i + 1) ? ' · cited' : ''}
                    </span>
                    <div className="vd-text">{p.content}</div>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </section>
      )}

      <h2>How it works</h2>
      <ul className="vd-facts">
        <li>
          <b>Chunks.</b> A whole document is too broad to match one question, and a sentence too narrow to make sense
          alone. Here chunks are whole paragraphs up to about 150 words, each starting with its heading.
        </li>
        <li>
          <b>Embeddings.</b> nomic-embed-text turns each chunk into {status?.dims ?? 768} numbers, so that texts with
          similar meaning point in similar directions. Chunks are embedded as documents and questions as queries: the
          model was trained with a different prefix for each.
        </li>
        <li>
          <b>The table.</b> One row per chunk: the text, a <span className="mono">vector</span> column, and a{' '}
          <span className="mono">tsvector</span> column Postgres builds from the text for word search. Every row records
          the embedding model, because vectors from two models cannot be compared.
        </li>
        <li>
          <b>Metadata and permissions.</b> Each chunk keeps who may read it and its tags. A search runs as the reader:
          the transaction switches to an unprivileged role and sets their groups, and a PostgreSQL row-level security
          policy hides every other row from every query, including the one that builds the model’s prompt. The filter
          lives in the database, so a forgotten WHERE clause cannot leak a salary band. Superusers skip these policies,
          which is why searches never run as one. A graph or a cache built from restricted chunks needs the same care.
        </li>
        <li>
          <b>The indexes.</b> HNSW (a graph of near neighbours) answers “closest vectors” without reading every row. GIN
          answers “rows with these words”. An ordinary index narrows to a collection.
        </li>
        <li>
          <b>Why fuse.</b> Meaning catches paraphrases but can miss an exact code, name or number; words catch those but
          miss paraphrases. Fusing the two ranked lists is a cheap, robust way to get both.
        </li>
        <li>
          <b>In Azure.</b> Azure Database for PostgreSQL (Flexible Server) runs the same SQL: allow{' '}
          <span className="mono">VECTOR</span> in its <span className="mono">azure.extensions</span> setting and sign in
          with Entra. Azure AI Search (the search pipeline page) is the managed alternative, with built-in hybrid search
          and semantic reranking; Postgres is the better fit when the vectors belong next to data you already keep
          there.
        </li>
      </ul>
      {status?.create_sql && (
        <details className="vd-sql">
          <summary>The table and its indexes</summary>
          <pre>{status.create_sql}</pre>
        </details>
      )}
      <p className="small muted">
        Look at the tables yourself with <code>./tools/vector-db.sh --psql</code>. Stop the database with{' '}
        <code>--stop</code> (the data is kept) or delete it with <code>--remove</code>.
      </p>
    </main>
  );
}
