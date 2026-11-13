import { useCallback, useEffect, useState } from 'react';
import { modelName } from '@/lib/models';
import { statusService } from '@/services/statusService';
import {
  semanticCacheService,
  type CachePair,
  type CacheReply,
  type CacheStatus,
} from '@/services/semanticCacheService';
import './semantic-cache.css';

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const usd = (v: number) => `$${v < 0.1 ? v.toFixed(5) : v.toFixed(2)}`;
const ms = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`);

const TRIES = [
  'How many days of annual leave do I get?',
  "What's my holiday allowance each year?",
  'Can I carry over 5 unused leave days?',
  'Can I carry over 10 unused leave days?',
  'How do I book annual leave?',
  'How do I cancel annual leave?',
  'Am I allowed to work remotely?',
  'Can I work from home?',
];

type Verdicts = Record<string, { same_answer: boolean; reason: string }>;

/** One preset pair: its similarity on a bar with the threshold marked, and what each check says. */
function PairRow({ p, threshold, verdict }: { p: CachePair; threshold: number; verdict?: Verdicts[string] }) {
  const sim = p.similarity ?? 0;
  const above = sim >= threshold;
  const wrongHit = above && !p.same;
  return (
    <tr className={wrongHit ? 'sc-wrong' : ''}>
      <td>
        <div>{p.a}</div>
        <div>{p.b}</div>
        <div className="small muted">{p.why}</div>
      </td>
      <td>{p.same ? 'Same answer' : <b>Different answer</b>}</td>
      <td>
        <div className="sc-bar" title={`Similarity ${sim.toFixed(3)}; threshold ${threshold.toFixed(2)}`}>
          <i style={{ width: `${Math.max(0, (sim - 0.5) / 0.5) * 100}%` }} className={above ? 'above' : ''} />
          <b style={{ left: `${((threshold - 0.5) / 0.5) * 100}%` }} />
        </div>
        <span className="mono small">{p.similarity === undefined ? '…' : sim.toFixed(3)}</span>{' '}
        <span className="small">
          {above ? (p.same ? 'hit (right)' : 'hit: wrong answer served') : p.same ? 'miss (a lost saving)' : 'miss'}
        </span>
      </td>
      <td className="small">
        {p.numbers_match === undefined ? '' : p.numbers_match ? 'match' : <b>differ: blocked</b>}
      </td>
      <td className="small">
        {verdict ? (
          <span title={verdict.reason}>{verdict.same_answer ? 'same' : <b>different: blocked</b>}</span>
        ) : (
          <span className="muted">–</span>
        )}
      </td>
    </tr>
  );
}

/** A semantic cache in front of a model, on pgvector: what it saves, and the wrong answers it can serve. */
export default function SemanticCachePage() {
  const [status, setStatus] = useState<CacheStatus | null>(null);
  const [pairs, setPairs] = useState<CachePair[]>([]);
  const [verdicts, setVerdicts] = useState<Verdicts>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState('');
  const [question, setQuestion] = useState(TRIES[0]);
  const [user, setUser] = useState('everyone');
  const [threshold, setThreshold] = useState(0.8);
  const [useCache, setUseCache] = useState(true);
  const [checkNumbers, setCheckNumbers] = useState(true);
  const [checkModel, setCheckModel] = useState(true);
  const [replies, setReplies] = useState<(CacheReply & { question: string })[]>([]);
  const [spent, setSpent] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const s = await semanticCacheService.status();
      setStatus(s);
      if (!pairs.length) setPairs(s.pairs);
    } catch (err) {
      setError(errorText(err));
    }
  }, [pairs.length]);

  const ready = !!status?.embedder.has_model && !!status?.database.running && !status.database.error;

  useEffect(() => {
    void refresh();
    statusService
      .status()
      .then((s) => {
        setModels(s.models || []);
        setModel(s.default_model || s.models?.[0] || '');
      })
      .catch(() => undefined);
    // once, on opening the page
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (ready && pairs.length && pairs[0].similarity === undefined) {
      semanticCacheService
        .pairs()
        .then((r) => setPairs(r.pairs))
        .catch((err) => setError(errorText(err)));
    }
  }, [ready, pairs]);

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

  async function ask(q = question) {
    const r = await work(`Looking in the cache, then asking ${modelName(model)} if it misses…`, () =>
      semanticCacheService.ask({
        question: q.trim(),
        model,
        user,
        threshold,
        use_cache: useCache,
        check_numbers: checkNumbers,
        check_model: checkModel,
      }),
    );
    if (r) {
      setReplies((list) => [{ ...r, question: q.trim() }, ...list].slice(0, 12));
      setSpent((s) => s + r.cost_usd);
      void refresh();
    }
  }

  async function verifyPairs() {
    const r = await work('Asking the small model about each pair…', () => semanticCacheService.verifyPairs());
    if (r) {
      setVerdicts(Object.fromEntries(r.pairs.map((p) => [`${p.a}|${p.b}`, p])));
      setSpent((s) => s + r.cost_usd);
    }
  }

  async function clear() {
    if (!window.confirm('Delete every cached answer?')) return;
    if (await work('Clearing…', () => semanticCacheService.clear())) {
      setReplies([]);
      void refresh();
    }
  }

  const stats = status?.stats;
  const wrongAtThreshold = pairs.filter((p) => !p.same && (p.similarity ?? 0) >= threshold).length;
  const wrongServed = pairs.filter(
    (p) =>
      !p.same &&
      (p.similarity ?? 0) >= threshold &&
      !(checkNumbers && p.numbers_match === false) &&
      !(checkModel && verdicts[`${p.a}|${p.b}`]?.same_answer === false),
  ).length;

  return (
    <main className="page-semantic-cache">
      <div className="kicker">Building · Semantic cache</div>
      <h1>Answer once, reuse it: a semantic cache, and where it goes wrong</h1>
      <p className="lede">
        A help desk for the invented Northwind handbook, with a cache in front of the model. Each answered question is
        stored in PostgreSQL with its vector. When a new question means nearly the same, the stored answer comes back in
        milliseconds, at no cost. The catch: two questions can be almost identical in wording and differ in the one
        detail that changes the answer, so a similarity score alone is not a safe reason to reuse one.
      </p>

      {status && !status.embedder.has_model && (
        <div className="sc-setup small">
          The local embedding model is not ready: run <code>./tools/local-model.sh --embed</code> and set{' '}
          <code>LLM_LAB_LOCAL_EMBED_MODEL</code> in <code>.env</code>.
        </div>
      )}
      {status && (!status.database.running || status.database.error) && (
        <div className="sc-setup small">
          {status.database.error || 'PostgreSQL is not running.'} Run <code>./tools/vector-db.sh</code>, then{' '}
          <button className="btn small" onClick={() => void refresh()}>
            check again
          </button>
        </div>
      )}
      {error && <p className="sc-bad small">{error}</p>}
      {busy && (
        <p className="small" aria-live="polite">
          <span className="sc-pulse" /> {busy}
        </p>
      )}

      <section className="card sc-step">
        <h2>1. Ask the help desk</h2>
        <form
          className="sc-row"
          onSubmit={(e) => {
            e.preventDefault();
            void ask();
          }}
        >
          <input
            className="sc-question"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            maxLength={500}
            placeholder="Ask about leave, expenses, remote working…"
          />
          <button className="btn primary" disabled={!ready || !!busy || !question.trim() || !model}>
            Ask
          </button>
        </form>
        <div className="sc-tries">
          {TRIES.map((t) => (
            <button
              key={t}
              className="btn small"
              disabled={!ready || !!busy}
              onClick={() => {
                setQuestion(t);
                void ask(t);
              }}
            >
              {t}
            </button>
          ))}
        </div>
        <div className="sc-controls">
          <label>
            Answering model
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              {models.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </label>
          <label>
            Asking as
            <select value={user} onChange={(e) => setUser(e.target.value)}>
              {(status?.users ?? ['everyone']).map((u) => (
                <option key={u} value={u}>
                  {u === 'everyone' ? 'everyone (shared answers)' : `${u} (own cache)`}
                </option>
              ))}
            </select>
          </label>
          <label className="sc-threshold">
            Similarity threshold <b className="mono">{threshold.toFixed(2)}</b>
            <input
              type="range"
              min={0.5}
              max={1}
              step={0.01}
              value={threshold}
              onChange={(e) => setThreshold(Number(e.target.value))}
            />
          </label>
          <label className="sc-check">
            <input type="checkbox" checked={useCache} onChange={(e) => setUseCache(e.target.checked)} /> Use the cache
          </label>
          <label className="sc-check" title="Code: the numbers in both questions must be the same">
            <input type="checkbox" checked={checkNumbers} onChange={(e) => setCheckNumbers(e.target.checked)} /> Check
            numbers match (code, free)
          </label>
          <label
            className="sc-check"
            title="A small model answers only: would these two questions have the same answer?"
          >
            <input type="checkbox" checked={checkModel} onChange={(e) => setCheckModel(e.target.checked)} /> Confirm
            with a small model (Haiku, a fraction of a cent)
          </label>
        </div>

        {stats && (
          <div className="sc-stats small">
            <span>
              <b>{stats.hits}</b> hits
            </span>
            <span>
              <b>{stats.misses}</b> misses
            </span>
            <span>
              hit rate{' '}
              <b>{stats.hits + stats.misses ? Math.round((stats.hits / (stats.hits + stats.misses)) * 100) : 0}%</b>
            </span>
            <span>
              saved <b>{usd(stats.saved_usd)}</b> and <b>{ms(stats.saved_ms)}</b> of waiting
            </span>
            <span>this page has spent {usd(spent)}</span>
          </div>
        )}

        {replies.map((r, i) => (
          <div key={replies.length - i} className={`sc-reply ${r.hit ? 'hit' : 'miss'}`}>
            <div className="sc-reply-head">
              <span className="sc-badge">{r.hit ? 'Cache hit' : 'Miss: the model answered'}</span>
              <b>{r.question}</b>
            </div>
            <p>{r.answer}</p>
            {r.hit && (
              <p className="small">
                Reused the answer to “{r.matched}” (similarity {r.similarity?.toFixed(3)}). Took {ms(r.total_ms)}{' '}
                instead of {ms(r.model_ms)}; saved {usd(r.saved_usd)}
                {r.cost_usd > 0 ? ` after the ${usd(r.cost_usd)} check` : ''}.
              </p>
            )}
            {!r.hit && (
              <p className="small muted">
                {r.similarity === null
                  ? 'Nothing cached yet for this scope.'
                  : `Closest cached question: similarity ${r.similarity.toFixed(3)}.`}{' '}
                The model took {ms(r.model_ms)} and cost {usd(r.cost_usd)}; the answer is now cached.
              </p>
            )}
            {r.checked.length > 0 && (
              <ul className="sc-checked small">
                {r.checked.map((c) => (
                  <li key={c.id} className={c.passed ? 'ok' : 'no'}>
                    “{r.neighbours.find((n) => n.id === c.id)?.question}”:{' '}
                    {c.passed ? 'passed' : `blocked by the ${c.by === 'numbers' ? 'number check' : 'model check'}`}.{' '}
                    {c.reason}
                  </li>
                ))}
              </ul>
            )}
            <p className="small muted mono">
              scope: {r.scope} · embed {ms(r.embed_ms)} · lookup {ms(r.lookup_ms)}
            </p>
          </div>
        ))}
      </section>

      <section className="card sc-step">
        <h2>2. Why the similarity score is not enough</h2>
        <p className="small">
          Seven pairs of questions, scored by the same embedding model the cache uses (free, on this machine). Move the
          threshold above and watch which pairs would share an answer. The trap pairs, where one word or number changes
          the answer, score <i>higher</i> than real paraphrases: no threshold separates them.
        </p>
        <div className="sc-row">
          <button className="btn small" disabled={!ready || !!busy} onClick={() => void verifyPairs()}>
            Run the small-model check on every pair
          </button>
          <span className="small">
            At {threshold.toFixed(2)}: <b>{wrongAtThreshold}</b> wrong answer{wrongAtThreshold === 1 ? '' : 's'} by
            similarity alone, <b>{wrongServed}</b> with the checks switched on
            {Object.keys(verdicts).length ? '' : ' (run the model check to count it)'}.
          </span>
        </div>
        <div className="table-wrap">
          <table className="t sc-pairs">
            <thead>
              <tr>
                <th>Questions</th>
                <th>Truth</th>
                <th>Similarity against the threshold</th>
                <th>Numbers</th>
                <th>Small model</th>
              </tr>
            </thead>
            <tbody>
              {pairs.map((p) => (
                <PairRow key={p.a + p.b} p={p} threshold={threshold} verdict={verdicts[`${p.a}|${p.b}`]} />
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card sc-step">
        <h2>3. What is in the cache</h2>
        {(status?.entries ?? []).length === 0 ? (
          <p className="small muted">Empty. Ask a question above.</p>
        ) : (
          <div className="table-wrap">
            <table className="t">
              <thead>
                <tr>
                  <th>Question</th>
                  <th>Scope</th>
                  <th>Hits</th>
                  <th>Cost to make</th>
                </tr>
              </thead>
              <tbody>
                {status?.entries?.map((e) => (
                  <tr key={e.id}>
                    <td title={e.answer}>{e.question}</td>
                    <td className="mono small">{e.scope}</td>
                    <td className="mono">{e.hits}</td>
                    <td className="mono">{usd(e.cost_usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="sc-row">
          <button className="btn small" disabled={!ready || !!busy} onClick={() => void clear()}>
            Clear the cache
          </button>
          <span className="small muted">
            Entries expire after {Math.round((status?.ttl_s ?? 86400) / 3600)} hours. The scope holds the answering
            model, the prompt version ({status?.prompt_version}) and the user: changing any of them starts afresh.
          </span>
        </div>
        {status?.lookup_sql && (
          <details className="sc-sql">
            <summary>The lookup, and the table</summary>
            <pre>{status.lookup_sql}</pre>
            <pre>{status.create_sql}</pre>
          </details>
        )}
      </section>

      <h2>Three caches with similar names</h2>
      <div className="table-wrap">
        <table className="t">
          <thead>
            <tr>
              <th />
              <th>What is stored</th>
              <th>Where</th>
              <th>Reused when</th>
              <th>Can it be wrong?</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <b>KV cache</b>
              </td>
              <td>Each token’s keys and values in every attention layer</td>
              <td>Inside the model, for one request</td>
              <td>Every new token, so earlier tokens are not recomputed</td>
              <td>No: exact</td>
            </tr>
            <tr>
              <td>
                <b>Prompt caching</b>
              </td>
              <td>The KV cache of a prompt’s opening part</td>
              <td>The provider, for minutes</td>
              <td>A later request starts with exactly the same tokens (system prompt, tools, documents)</td>
              <td>No: exact, the model still answers. See the context and cost page</td>
            </tr>
            <tr>
              <td>
                <b>Semantic cache</b>
              </td>
              <td>Whole answers, keyed by the question’s vector</td>
              <td>Your application’s database</td>
              <td>A new question is close enough in meaning</td>
              <td>Yes: it serves an old answer to a new question</td>
            </tr>
          </tbody>
        </table>
      </div>
      <ul className="sc-facts">
        <li>
          <b>Use it for</b> high-volume, repetitive questions with one right answer for everyone: FAQs, policy, product
          facts. Not for questions about a person’s own data, or anything that changes by the hour.
        </li>
        <li>
          <b>Scope every entry</b> by what changes the answer: the model, the prompt version, the user or tenant, and
          the documents behind it. A shared cache holding one person’s answer is a data leak.
        </li>
        <li>
          <b>Expire entries</b> and drop them when the source changes; a cached answer does not know the handbook was
          updated.
        </li>
        <li>
          <b>Check before serving.</b> Cheap code checks (numbers, negation, named entities) catch many traps; a small
          model or a cross-encoder reranker catches more, for a fraction of the cost of answering again.
        </li>
        <li>
          <b>Cache only good answers.</b> A wrong or refused answer, once cached, is served again and again.
        </li>
      </ul>
    </main>
  );
}
