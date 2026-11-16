import { useEffect, useMemo, useRef, useState } from 'react';
import { sampleService } from '@/services/sampleService';
import { statusService, type CacheFacts, type LiveStatus } from '@/services/statusService';

/** The three questions of python/10_rag_vs_cag_vs_kag.py, with the handbook sections a complete answer needs. */
const QUESTIONS = [
  {
    text: 'How many days of annual leave do I get, and how many can I carry over?',
    needs: ['Annual leave'],
  },
  {
    text: 'List everything the handbook says I must tell my line manager or get their agreement on.',
    needs: ['Sickness absence', 'Remote working', 'Learning and development', 'Code of conduct'],
  },
  {
    text: 'Which things do I need to tell HR about, and how far in advance?',
    needs: ['Annual leave', 'Parental leave', 'Remote working'],
  },
];
// The scripts' system prompts, so the token estimates include them.
const RAG_SYSTEM =
  "Answer using only the documents provided and cite document numbers like [1]. Be concise. If the information given does not contain the answer, say you don't know.";
const CAG_SYSTEM = "Answer from the handbook below. Be concise. If it does not contain the answer, say you don't know.";
const READ_SYSTEM =
  'Quote anything in this section that answers the question, word for word. If nothing does, say none.';
const READ_OUTPUT = 40; // an assumed note per section: a short quote, or "none"
const NOTE_TOKENS = 60; // what each relevant section's note adds to the combining call
const THRESHOLD = 0.35; // RAG's other rule: every section scoring at least this share of the best one
const OUTPUT_TOKENS = 150; // an assumed answer length, the same for both
const SCALES = [1, 10, 100, 1000];
const STAGES_RAG = ['Question', 'Search', 'Prompt', 'Model', 'Answer'];
const STAGES_CAG = ['Question', 'Cache', 'Prompt', 'Model', 'Answer'];
const STAGES_READ = ['Question', 'Split', 'Read each', 'Combine', 'Answer'];
const LANES = [
  { id: 'rag', title: 'RAG: retrieve, then generate', stages: STAGES_RAG },
  { id: 'cag', title: 'CAG: cache, then generate', stages: STAGES_CAG },
  { id: 'read', title: 'Read every section', stages: STAGES_READ },
] as const;
const STEP_MS = 900;
const CACHE_TTL_MS = 5 * 60 * 1000; // a cache entry lives 5 minutes after its last use
const DEFAULT_CACHE: CacheFacts = { write_multiplier: 1.25, min_tokens: 512, claude_context_tokens: 1_000_000 };
const STOP = new Set(
  'a an and are as at be by can do does for from get how i if in is it me my of on or so that the this to what when which with you your about any every everything things need must tell says list many'.split(
    ' ',
  ),
);

interface Section {
  title: string;
  text: string;
}

const tokens = (text: string) => Math.ceil(text.length / 4); // about four characters a token, in English
const words = (text: string) => (text.toLowerCase().match(/[a-z0-9£]+/g) ?? []).filter((w) => !STOP.has(w));

/** BM25 over the sections: rarer words that match count for more, and long sections are not favoured. */
function bm25(sections: Section[], query: string, k1 = 1.2, b = 0.75): number[] {
  const docs = sections.map((s) => words(`${s.title} ${s.text}`));
  const avg = docs.reduce((n, d) => n + d.length, 0) / Math.max(1, docs.length);
  const q = [...new Set(words(query))];
  return docs.map((d) =>
    q.reduce((score, term) => {
      const tf = d.filter((w) => w === term).length;
      if (!tf) return score;
      const df = docs.filter((x) => x.includes(term)).length;
      const idf = Math.log(1 + (docs.length - df + 0.5) / (df + 0.5));
      return score + (idf * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * d.length) / avg));
    }, 0),
  );
}

function parse(handbook: string): Section[] {
  return handbook
    .split(/\n## /)
    .slice(1)
    .map((block) => {
      const [title, ...body] = block.split('\n');
      return { title: title.trim(), text: body.join(' ').trim() };
    });
}

const fmtTokens = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000).toLocaleString()}k` : n.toLocaleString());
const fmtUsd = (v: number) => (v < 0.01 ? `$${v.toFixed(5)}` : `$${v.toFixed(4)}`);

/**
 * RAG against CAG, animated on the same questions: RAG searches the handbook and sends the best few sections; CAG
 * (cache-augmented generation) sends the whole handbook every time, cached after the first request. The numbers are
 * estimates from the handbook's length and the lab's prices; python/10_rag_vs_cag_vs_kag.py measures them for real.
 */
export default function RagVsCag() {
  const [handbook, setHandbook] = useState<Section[]>([]);
  const [status, setStatus] = useState<LiveStatus | null>(null);
  const [error, setError] = useState('');
  const [model, setModel] = useState('');
  const [k, setK] = useState(3);
  const [rule, setRule] = useState<'top' | 'threshold'>('top');
  const [scale, setScale] = useState(1);
  // Questions in the order asked, with when, and whether CAG's cache was still warm from the one before.
  const [asked, setAsked] = useState<{ qi: number; at: number; warm: boolean }[]>([]);
  const [current, setCurrent] = useState<number | null>(null);
  const [stage, setStage] = useState(-1);
  const queue = useRef<number[]>([]);

  useEffect(() => {
    let alive = true; // a reply after the page has gone changes nothing
    sampleService
      .getHandbook()
      .then((text) => alive && setHandbook(parse(text)))
      .catch((e: Error) => alive && setError(e.message));
    statusService.status().then((s) => {
      if (!alive) return;
      setStatus(s);
      const claude = (s.claude_models ?? []).filter((m) => s.prices?.[m]);
      setModel(claude.includes('claude-haiku-5-5') ? 'claude-haiku-5-5' : (claude[0] ?? ''));
      if (!s.available) setError(s.reason ?? 'The lab backend is not running.');
    });
    return () => {
      alive = false;
    };
  }, []);

  // One question plays through its stages; when it ends it is counted and the next queued one starts.
  useEffect(() => {
    if (current === null) return;
    if (stage >= STAGES_RAG.length - 1) {
      const t = window.setTimeout(() => {
        const at = Date.now();
        setAsked((a) => [...a, { qi: current, at, warm: a.length > 0 && at - a[a.length - 1].at < CACHE_TTL_MS }]);
        const next = queue.current.shift();
        if (next === undefined) setCurrent(null);
        else {
          setCurrent(next);
          setStage(0);
        }
      }, STEP_MS * 1.6);
      return () => window.clearTimeout(t);
    }
    const t = window.setTimeout(() => setStage((s) => s + 1), STEP_MS);
    return () => window.clearTimeout(t);
  }, [current, stage]);

  const ask = (indexes: number[]) => {
    if (current !== null || !indexes.length) return;
    queue.current = indexes.slice(1);
    setCurrent(indexes[0]);
    setStage(0);
  };
  const reset = () => {
    queue.current = [];
    setCurrent(null);
    setStage(-1);
    setAsked([]);
  };

  const cache = status?.cache ?? DEFAULT_CACHE;
  const price = status?.prices?.[model];
  const handbookTokens = useMemo(
    () => handbook.reduce((n, s) => n + tokens(`## ${s.title}\n${s.text}\n`), 0),
    [handbook],
  );
  const cagPrefix = tokens(CAG_SYSTEM) + handbookTokens * scale;
  const cacheable = cagPrefix >= cache.min_tokens;
  const fits = cagPrefix + 200 <= cache.claude_context_tokens;

  /** What each approach sends for one question, and whether everything the answer needs is in it. */
  const plan = (qi: number, warm: boolean) => {
    const q = QUESTIONS[qi];
    const scores = bm25(handbook, q.text);
    const order = scores.map((s, i) => [s, i] as const).sort((a, b) => b[0] - a[0]);
    const best = order[0]?.[0] ?? 0;
    const matched = order.filter(([sc]) => sc > 0); // a section sharing no word with the question is not found
    const picked = (rule === 'top' ? matched.slice(0, k) : matched.filter(([sc]) => sc >= best * THRESHOLD)).map(
      ([, i]) => i,
    );
    const sent = picked.map((i) => handbook[i].title);
    const missing = q.needs.filter((n) => !sent.includes(n));
    const ragIn =
      tokens(RAG_SYSTEM) + picked.reduce((n, i) => n + tokens(handbook[i].text) + 12, 0) + tokens(q.text) + 10;
    const qTokens = tokens(q.text) + 10;
    const cagWrite = cacheable && !warm ? cagPrefix : 0;
    const cagRead = cacheable && warm ? cagPrefix : 0;
    const cagPlain = (cacheable ? 0 : cagPrefix) + qTokens;
    const cost = (inp: number, write: number, read: number) =>
      price
        ? (inp * price.input +
            write * price.input * cache.write_multiplier +
            read * price.cache_read +
            OUTPUT_TOKENS * price.output) /
          1e6
        : 0;
    // Read every section: one call per section (they can run side by side), then one call to combine the notes.
    const sectionsRead = handbook.length * scale;
    const readCalls = sectionsRead + 1;
    const readIn =
      handbook.reduce((n, sec) => n + tokens(READ_SYSTEM) + tokens(sec.text) + tokens(q.text) + 12, 0) * scale +
      tokens(q.text) +
      q.needs.length * NOTE_TOKENS +
      20;
    const readOut = sectionsRead * READ_OUTPUT + OUTPUT_TOKENS;
    const readCost = price ? (readIn * price.input + readOut * price.output) / 1e6 : 0;
    return {
      scores,
      picked,
      missing,
      read: { input: readIn, calls: readCalls, sections: sectionsRead, cost: readCost },
      rag: { input: ragIn, cost: cost(ragIn, 0, 0) },
      cag: fits
        ? { input: cagPlain, write: cagWrite, read: cagRead, cost: cost(cagPlain, cagWrite, cagRead) }
        : { input: 0, write: 0, read: 0, cost: 0 },
    };
  };

  const totals = (() => {
    const t = {
      rag: { input: 0, cost: 0, complete: 0, calls: 0 },
      cag: { input: 0, write: 0, read: 0, cost: 0, complete: 0, calls: 0 },
      read: { input: 0, cost: 0, complete: 0, calls: 0 },
    };
    asked.forEach(({ qi, warm }) => {
      const p = plan(qi, warm);
      t.rag.input += p.rag.input;
      t.rag.cost += p.rag.cost;
      t.rag.complete += p.missing.length === 0 ? 1 : 0;
      t.rag.calls += 1;
      t.cag.calls += fits ? 1 : 0;
      t.read.input += p.read.input;
      t.read.cost += p.read.cost;
      t.read.calls += p.read.calls;
      t.read.complete += 1;
      t.cag.input += p.cag.input;
      t.cag.write += p.cag.write;
      t.cag.read += p.cag.read;
      t.cag.cost += p.cag.cost;
      t.cag.complete += fits ? 1 : 0;
    });
    return t;
  })();

  const last = asked[asked.length - 1];
  const shown = current ?? last?.qi ?? null;
  const warmNow = !!last && Date.now() - last.at < CACHE_TTL_MS;
  const now = current === null ? STAGES_RAG.length : stage; // a finished question stays on its answer
  const p = shown === null || !handbook.length ? null : plan(shown, current === null ? !!last?.warm : warmNow);
  const readShare = price ? `${+(price.cache_read / price.input).toFixed(2)}×` : 'a fraction of';
  const maxScore = p ? Math.max(...p.scores, 0.0001) : 1;
  const claudeModels = (status?.claude_models ?? []).filter((m) => status?.prices?.[m]);

  return (
    <section className="rc">
      <h2>RAG or CAG: search for the right parts, or send it all and cache it</h2>
      <p>
        RAG searches the handbook for each question and sends only the best few sections. CAG (cache-augmented
        generation) skips the search: it sends the whole handbook with every question, and the prompt cache stores the
        processed handbook after the first request, so later questions pay a tenth of the input price for it, or less.
        Ask the questions and watch what each one sends.
      </p>
      {error && <p className="rc-error small">{error}</p>}

      <div className="rc-controls">
        <div className="rc-questions">
          {QUESTIONS.map((q, i) => (
            <button key={i} className="btn" onClick={() => ask([i])} disabled={current !== null || !handbook.length}>
              Q{i + 1}: {q.text}
            </button>
          ))}
        </div>
        <div className="rc-settings">
          <button
            className="btn primary"
            onClick={() => ask([0, 1, 2])}
            disabled={current !== null || !handbook.length}
          >
            Ask all three
          </button>
          <button className="btn ghost" onClick={reset} disabled={!asked.length && current === null}>
            Start again
          </button>
          <label>
            RAG sends
            <select value={rule} onChange={(e) => setRule(e.target.value as 'top' | 'threshold')}>
              <option value="top">a fixed number of sections</option>
              <option value="threshold">
                every section scoring at least {Math.round(THRESHOLD * 100)}% of the best
              </option>
            </select>
          </label>
          {rule === 'top' && (
            <label>
              Top
              <select value={k} onChange={(e) => setK(Number(e.target.value))}>
                {[1, 2, 3, 4, 5, 6].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            Knowledge base
            <select value={scale} onChange={(e) => setScale(Number(e.target.value))}>
              {SCALES.map((s) => (
                <option key={s} value={s}>
                  {s === 1 ? 'this handbook' : `${s.toLocaleString()} times bigger`}
                </option>
              ))}
            </select>
          </label>
          {claudeModels.length > 0 && (
            <label>
              Model
              <select value={model} onChange={(e) => setModel(e.target.value)}>
                {claudeModels.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      </div>

      <div className="rc-lanes">
        {LANES.map(({ id: lane, title, stages }) => {
          const detail = Math.min(now, stages.length - 1);
          return (
            <div key={lane} className={`rc-lane rc-lane-${lane}`}>
              <h3>{title}</h3>
              <ol className="rc-stages">
                {stages.map((s, i) => (
                  <li key={s} className={p && i < now ? 'done' : p && i === now ? 'on' : ''}>
                    {s}
                  </li>
                ))}
              </ol>
              <div className="rc-detail small">
                {!p && <p className="muted">Ask a question to see what is sent.</p>}
                {p && detail === 0 && <p>“{QUESTIONS[shown!].text}”</p>}

                {p && lane === 'rag' && detail === 1 && (
                  <>
                    <p>
                      Keyword search (BM25) scores every section;{' '}
                      {rule === 'top'
                        ? `the top ${k} go in`
                        : `every one scoring ${Math.round(THRESHOLD * 100)}% of the best or more goes in`}
                      . Dashed: what a complete answer needs.
                    </p>
                    <ul className="rc-scores">
                      {handbook.map((s, i) => (
                        <li
                          key={s.title}
                          className={`${p.picked.includes(i) ? 'picked' : ''} ${QUESTIONS[shown!].needs.includes(s.title) ? 'needed' : ''}`}
                        >
                          <span>{s.title}</span>
                          <i style={{ width: `${(p.scores[i] / maxScore) * 100}%` }} />
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {p && lane === 'rag' && detail === 2 && (
                  <>
                    <p>
                      The prompt: {p.picked.length} section{p.picked.length === 1 ? '' : 's'} and the question, ≈{' '}
                      {fmtTokens(p.rag.input)} tokens.
                    </p>
                    <div className="rc-chips">
                      {p.picked.map((i) => (
                        <span key={i} className="rc-chip">
                          {handbook[i].title}
                        </span>
                      ))}
                      <span className="rc-chip q">question</span>
                    </div>
                  </>
                )}

                {p && lane === 'cag' && detail === 1 && (
                  <p>
                    {!fits
                      ? `The knowledge base is ≈ ${fmtTokens(cagPrefix)} tokens, more than the model's ${fmtTokens(cache.claude_context_tokens)}-token window. CAG cannot send it at all.`
                      : !cacheable
                        ? `≈ ${fmtTokens(cagPrefix)} tokens is under the ${cache.min_tokens}-token minimum, so nothing is cached: every question pays for all of it.`
                        : p.cag.write
                          ? `First request: the handbook (≈ ${fmtTokens(cagPrefix)} tokens) is written to the cache, at ${cache.write_multiplier}× the input price. It stays for 5 minutes after its last use.`
                          : `Cache hit: the handbook (≈ ${fmtTokens(cagPrefix)} tokens) is read from the cache, at ${readShare} the input price.`}
                  </p>
                )}
                {p && lane === 'cag' && detail === 2 && (
                  <>
                    <p>
                      The prompt: the whole handbook{scale > 1 ? ` (× ${scale.toLocaleString()})` : ''} and the
                      question, ≈ {fmtTokens(cagPrefix + tokens(QUESTIONS[shown!].text))} tokens.
                    </p>
                    <div className="rc-chips">
                      <span className={`rc-chip all ${p.cag.read ? 'cached' : ''}`}>
                        all {handbook.length * scale} sections{p.cag.read ? ' (cached)' : ''}
                      </span>
                      <span className="rc-chip q">question</span>
                    </div>
                  </>
                )}

                {p && lane === 'read' && detail === 1 && (
                  <p>
                    {p.read.sections.toLocaleString()} sections, one small call each with the question, run side by
                    side. No search: nothing is skipped.
                  </p>
                )}
                {p && lane === 'read' && detail === 2 && (
                  <>
                    <p>Each call quotes what its section says about the question, or says none.</p>
                    <ul className="rc-read">
                      {handbook.map((sec) => (
                        <li key={sec.title} className={QUESTIONS[shown!].needs.includes(sec.title) ? 'found' : ''}>
                          {sec.title}
                        </li>
                      ))}
                      {scale > 1 && (
                        <li className="more">… and {((scale - 1) * handbook.length).toLocaleString()} more</li>
                      )}
                    </ul>
                  </>
                )}
                {p && lane === 'read' && detail === 3 && (
                  <p>
                    One more call joins the notes from the {QUESTIONS[shown!].needs.length} section
                    {QUESTIONS[shown!].needs.length === 1 ? '' : 's'} that said something, and writes the answer.
                  </p>
                )}
                {p && lane === 'read' && detail === 4 && (
                  <p className="rc-good">
                    Every section was read, so nothing can be missed, at any size (given the time and the rate limits
                    for that many calls). {p.read.calls.toLocaleString()} calls
                    {price ? `, ≈ ${fmtUsd(p.read.cost)}` : ''}.
                  </p>
                )}
                {p && detail === 3 && lane !== 'read' && (
                  <p>
                    {model || 'The model'} reads the prompt and writes an answer (≈ {OUTPUT_TOKENS} tokens, assumed the
                    same for both).
                  </p>
                )}
                {p && detail === 4 && lane === 'rag' && (
                  <p className={p.missing.length ? 'rc-bad' : 'rc-good'}>
                    {p.missing.length
                      ? `Missing: ${p.missing.join(', ')}. The model never saw ${p.missing.length > 1 ? 'them' : 'it'}, so the answer leaves ${p.missing.length > 1 ? 'them' : 'it'} out, or says there is nothing more.`
                      : 'Every section the answer needs was sent.'}{' '}
                    {price && `This question cost ≈ ${fmtUsd(p.rag.cost)}.`}
                  </p>
                )}
                {p && detail === 4 && lane === 'cag' && (
                  <p className={fits ? 'rc-good' : 'rc-bad'}>
                    {fits
                      ? `Every section was there, so nothing can be missed.${price ? ` This question cost ≈ ${fmtUsd(p.cag.cost)}.` : ''}`
                      : 'No answer: the knowledge base does not fit. Past this size, retrieval is the only way.'}
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="table-wrap">
        <table className="t rc-totals">
          <thead>
            <tr>
              <th>
                After {asked.length} question{asked.length === 1 ? '' : 's'}
              </th>
              <th>Calls</th>
              <th>Input tokens sent</th>
              <th>Of which cached</th>
              <th>Cost</th>
              <th>Complete answers</th>
              <th>Text certain to be seen?</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>{rule === 'top' ? `RAG, top ${k}` : `RAG, ${Math.round(THRESHOLD * 100)}% of the best`}</td>
              <td className="mono">{totals.rag.calls}</td>
              <td className="mono">≈ {fmtTokens(totals.rag.input)}</td>
              <td className="mono">none</td>
              <td className="mono">{price ? fmtUsd(totals.rag.cost) : '–'}</td>
              <td className="mono">
                {totals.rag.complete} of {asked.length}
              </td>
              <td>No: only what the search found</td>
            </tr>
            <tr>
              <td>CAG</td>
              <td className="mono">{totals.cag.calls}</td>
              <td className="mono">≈ {fmtTokens(totals.cag.input + totals.cag.write + totals.cag.read)}</td>
              <td className="mono">
                {totals.cag.write || totals.cag.read
                  ? `${fmtTokens(totals.cag.write)} written, ${fmtTokens(totals.cag.read)} read`
                  : 'none'}
              </td>
              <td className="mono">{price ? fmtUsd(totals.cag.cost) : '–'}</td>
              <td className="mono">
                {totals.cag.complete} of {asked.length}
              </td>
              <td>{fits ? 'Yes, while it fits in the window' : 'It does not fit'}</td>
            </tr>
            <tr>
              <td>Read every section</td>
              <td className="mono">{totals.read.calls.toLocaleString()}</td>
              <td className="mono">≈ {fmtTokens(totals.read.input)}</td>
              <td className="mono">none</td>
              <td className="mono">{price ? fmtUsd(totals.read.cost) : '–'}</td>
              <td className="mono">
                {totals.read.complete} of {asked.length}
              </td>
              <td>Yes, at any size, given time and rate limits</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="small muted">
        Estimates: tokens are the text's length ÷ 4, answers are taken as {OUTPUT_TOKENS} tokens, and prices are{' '}
        {price ? `${model}'s list prices from the lab` : 'not shown: the lab backend has no Claude prices to give'}. A
        cache entry lasts 5 minutes after its last use, so a question asked later pays to write it again. The search
        here is keywords only; the script adds embeddings. For real counts, real answers and real cache hits, run{' '}
        <code>python python/10_rag_vs_cag_vs_kag.py</code>.
      </p>
      <div className="rc-luck">
        <h3>Not leaving it to luck</h3>
        <p>
          With RAG, the model only sees what the search returns, so a fact that is in the documents can still be missed:
          try Q2, which needs four sections, with the top 3. A threshold, hybrid search, a reranker or splitting the
          question into parts all make a miss less likely, and measuring retrieval on questions with known answers shows
          how often it still happens. None of them makes it impossible.
        </p>
        <p>
          Only two ways make sure the model sees every word: send all of it (CAG, while it fits in the window), or have
          the model read all of it, one piece per call, and combine what each piece said. When the answer must be there
          if the text is, use one of those two, and make the answer quote its source so it can be checked.
        </p>
      </div>
      <div className="rc-when">
        <div>
          <h3>CAG fits when</h3>
          <ul>
            <li>The knowledge fits comfortably in the window, with room for the conversation.</li>
            <li>Many questions hit the same text within minutes, so the cache stays warm.</li>
            <li>Answers draw on several parts at once, where a search would miss pieces.</li>
          </ul>
        </div>
        <div>
          <h3>RAG fits when</h3>
          <ul>
            <li>The knowledge is far bigger than the window, or grows every day.</li>
            <li>Questions are rare or spread out, so a cache would expire between them.</li>
            <li>You need to show which passage each answer came from, or keep some documents from some users.</li>
          </ul>
        </div>
        <div>
          <h3>Reading every section fits when</h3>
          <ul>
            <li>A missed fact is not acceptable: audits, compliance checks, "list every…" questions.</li>
            <li>The knowledge is too big for the window, so CAG is out.</li>
            <li>The extra calls are worth it: they run side by side, and a small model can do the reading.</li>
          </ul>
        </div>
      </div>
    </section>
  );
}
