import { useEffect, useState } from 'react';
import {
  searchlabService as svc,
  type AskResult,
  type Health,
  type IngestReport,
  type QueryResult,
  type RelevanceResult,
  type SearchLabInfo,
  type SearchMode,
} from '@/services';
import { Chips, Panel, Problem, useCall, usd } from '@/pages/ai103/shared';

const MODE_LABEL: Record<SearchMode, string> = {
  keyword: 'Keyword (BM25)',
  vector: 'Vector (HNSW, cosine)',
  hybrid: 'Hybrid (both, merged by RRF)',
  semantic: 'Hybrid + semantic ranker',
};
const kb = (n: number) => `${(n / 1024).toFixed(0)} KB`;

export default function SearchLabPage() {
  const [info, setInfo] = useState<SearchLabInfo | null>(null);
  const [problem, setProblem] = useState('');
  const [text, setText] = useState('How long do I have to report the damage?');
  const [question, setQuestion] = useState('Is the kitchen leak covered, and what will the customer pay?');
  const [results, setResults] = useState<Partial<Record<SearchMode, QueryResult>>>({});
  const [comparing, setComparing] = useState(false);
  const [compareError, setCompareError] = useState('');
  const ing = useCall<IngestReport & { spent_usd: number }>();
  const rel = useCall<RelevanceResult>();
  const health = useCall<Health>();
  const ask = useCall<AskResult>();

  useEffect(() => {
    svc
      .info()
      .then(setInfo)
      .catch((e: Error) => setProblem(e.message));
  }, []);
  useEffect(() => {
    if (ing.result) {
      void svc.info().then(setInfo);
      window.setTimeout(() => void health.run(() => svc.health()), 4000); // index statistics lag behind uploads
    }
  }, [ing.result]); // eslint-disable-line react-hooks/exhaustive-deps

  const report = ing.result ?? info?.report ?? null;
  async function compare() {
    setComparing(true);
    setCompareError('');
    try {
      const all = await Promise.all((info?.modes ?? []).map((m) => svc.query(text, m)));
      setResults(Object.fromEntries(all.map((r) => [r.mode, r])));
    } catch (e) {
      setCompareError((e as Error).message);
    } finally {
      setComparing(false);
    }
  }

  return (
    <main className="page-searchlab">
      <div className="kicker">Lab 41 · AI-103: retrieval and grounding pipelines</div>
      <h1>From files to a search index, and how well it finds things</h1>
      <p className="lede">
        One index for a whole insurance claim: the policy wording, an invoice, a claim form, three photos and a narrated
        video. Content Understanding turns each file into text (OCR, layout, descriptions, transcripts). The text is
        chunked, enriched with key phrases, embedded, and indexed in Azure AI Search. Then the same questions are asked
        four ways, keyword, vector, hybrid and hybrid with the semantic ranker, and scored against the source that
        should come first.
      </p>
      <div className="az-stack small">
        <span>
          <b>Index</b> {info?.index ?? '…'} {info?.indexed ? '(built)' : '(not built yet)'}
        </span>
        <span>
          <b>Embeddings</b> {info?.embedding} · {info?.dimensions} dimensions
        </span>
        <span>
          <b>Search tier</b> Free: 3 indexes, 50 MB, the semantic ranker&apos;s free plan of 1,000 queries a month
        </span>
      </div>
      <Problem error={problem} />

      <Panel title="1. Ingest and enrich">
        <div className="az-chips">
          {(info?.sources ?? []).map((s) => (
            <span key={s.id} className="az-chip" title={s.analyzer}>
              {s.modality} · {s.title}
            </span>
          ))}
        </div>
        <button
          className="btn primary"
          disabled={ing.busy || !info?.configured}
          onClick={() => void ing.run(() => svc.ingest())}
        >
          {ing.busy ? 'Running the pipeline…' : info?.indexed ? 'Rebuild the index' : 'Run the pipeline'}
        </button>{' '}
        <span className="small muted">
          The first run analyses six files with Content Understanding (about a minute, $0.04); later runs reuse that.
        </span>
        <Problem error={ing.error} />
        {report && (
          <div className="az-result">
            <ol className="az-stages">
              {report.steps.map((s) => (
                <li key={s.step} className="pass">
                  <b>{s.step}</b> <span className="small muted">{(s.ms / 1000).toFixed(1)} s</span>
                  <div className="small">{s.detail}</div>
                </li>
              ))}
            </ol>
            <p className="small">
              {report.chunks} chunks from {report.sources} sources at {report.at} · {usd(report.cost_usd)}
              {report.problems.length > 0 && <span className="az-bad"> · Problems: {report.problems.join('; ')}</span>}
            </p>
          </div>
        )}
      </Panel>

      <Panel title="2. One question, four ways">
        <Chips items={info?.queries ?? []} label={(q) => q.question} onPick={(q) => setText(q.question)} />
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          style={{ width: '100%' }}
          aria-label="Search query"
        />
        <div className="az-row">
          <button className="btn primary" disabled={comparing || !info?.indexed} onClick={() => void compare()}>
            {comparing ? 'Searching…' : 'Search in all four modes'}
          </button>
          {!info?.indexed && <span className="small muted">Build the index first.</span>}
        </div>
        <Problem error={compareError} />
        {Object.keys(results).length > 0 && (
          <div className="az-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 250px), 1fr))' }}>
            {(info?.modes ?? []).map((m) => {
              const r = results[m];
              const expect = info?.queries.find((q) => q.question === text)?.expect;
              return (
                <div key={m} className="az-result" style={{ marginTop: 0 }}>
                  <b className="small">{MODE_LABEL[m]}</b> <span className="small muted">{r?.ms} ms</span>
                  {r?.answer && (
                    <div className="az-quote small">
                      <b>Semantic answer:</b> {r.answer}
                    </div>
                  )}
                  <ol className="small" style={{ paddingLeft: 18 }}>
                    {r?.hits.map((h) => (
                      <li key={h.id} style={{ marginBottom: 6 }}>
                        <span style={{ fontWeight: h.source === expect ? 700 : 400 }}>
                          {h.source === expect && '✓ '}
                          {h.title}
                        </span>{' '}
                        <span className="muted">
                          {h.modality} ·{' '}
                          {h.reranker !== null ? `reranker ${h.reranker.toFixed(2)}` : `score ${h.score?.toFixed(3)}`}
                        </span>
                        {h.caption && <div className="muted">{h.caption.slice(0, 140)}</div>}
                      </li>
                    ))}
                  </ol>
                </div>
              );
            })}
          </div>
        )}
      </Panel>

      <Panel title="3. Relevance on labelled questions">
        <p className="small muted">
          {info?.queries.length ?? 12} questions, each with the source that should come first. Hit@1: it came first.
          Hit@3: in the top three. MRR: the mean of 1/rank, so first is 1, second is 0.5, missing is 0.
        </p>
        <button
          className="btn primary"
          disabled={rel.busy || !info?.indexed}
          onClick={() => void rel.run(() => svc.evaluate())}
        >
          {rel.busy ? 'Scoring…' : 'Score all four modes'}
        </button>
        <Problem error={rel.error} />
        {rel.result && (
          <div className="az-result">
            <div className="az-table-wrap">
              <table className="az-table">
                <thead>
                  <tr>
                    <th>Mode</th>
                    <th>Hit@1</th>
                    <th>Hit@3</th>
                    <th>MRR</th>
                    <th>Mean latency</th>
                  </tr>
                </thead>
                <tbody>
                  {(Object.keys(rel.result.summary) as SearchMode[]).map((m) => {
                    const s = rel.result!.summary[m];
                    return (
                      <tr key={m}>
                        <td>{MODE_LABEL[m]}</td>
                        <td>
                          {s.hit1} / {rel.result!.n}
                        </td>
                        <td>
                          {s.hit3} / {rel.result!.n}
                        </td>
                        <td>
                          <b>{s.mrr.toFixed(2)}</b>
                        </td>
                        <td>{s.ms} ms</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <details>
              <summary className="small">Rank of the right source, question by question</summary>
              <table className="az-table">
                <thead>
                  <tr>
                    <th>Question</th>
                    <th>Keyword</th>
                    <th>Vector</th>
                    <th>Hybrid</th>
                    <th>Semantic</th>
                  </tr>
                </thead>
                <tbody>
                  {rel.result.rows.map((r) => (
                    <tr key={r.question}>
                      <td className="small">
                        {r.question} <span className="muted">→ {r.expect}</span>
                      </td>
                      {(['keyword', 'vector', 'hybrid', 'semantic'] as SearchMode[]).map((m) => (
                        <td key={m} className={r[m].rank === 1 ? '' : 'az-bad'}>
                          {r[m].rank ?? '—'}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          </div>
        )}
      </Panel>

      <Panel title="4. Index health">
        <button className="btn" disabled={health.busy} onClick={() => void health.run(() => svc.health())}>
          {health.busy ? 'Reading…' : 'Read the statistics'}
        </button>
        <Problem error={health.error} />
        {health.result && (
          <div className="az-result small">
            {health.result.index ? (
              <p>
                <b>{info?.index}</b>: {health.result.index.documentCount} documents,{' '}
                {kb(health.result.index.storageSize)} stored, {kb(health.result.index.vectorIndexSize)} of vectors.
                {health.result.report &&
                  health.result.index.documentCount !== health.result.report.chunks &&
                  ` The pipeline uploaded ${health.result.report.chunks}: statistics catch up a few seconds after an upload.`}
              </p>
            ) : (
              <p>The index has not been built.</p>
            )}
            <table className="az-table">
              <tbody>
                {Object.entries(health.result.counters).map(([k, v]) => (
                  <tr key={k}>
                    <td>{k}</td>
                    <td>{k.includes('ize') ? kb(v.usage) : v.usage}</td>
                    <td className="muted">
                      {v.quota === null ? 'no limit' : `of ${k.includes('ize') ? kb(v.quota) : v.quota}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="5. Retrieval as an agent's tool">
        <p className="small muted">
          gpt-5.4-mini gets one function, <code>search_claim_file</code>, which runs hybrid search with the semantic
          ranker. It decides what to search for, then answers with citations.
        </p>
        <input
          type="text"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          style={{ width: '100%' }}
          aria-label="Question for the agent"
        />
        <div className="az-row">
          <button
            className="btn primary"
            disabled={ask.busy || !info?.indexed}
            onClick={() => void ask.run(() => svc.ask(question))}
          >
            {ask.busy ? 'Searching and answering…' : 'Ask the agent'}
          </button>
        </div>
        <Problem error={ask.error} />
        {ask.result && (
          <div className="az-result">
            <ol className="small">
              {ask.result.steps.map((s, i) => (
                <li key={i}>
                  searched <code>{s.query}</code> → {s.sources.join(', ')}
                </li>
              ))}
            </ol>
            <div className="az-quote">{ask.result.answer}</div>
            <p className="small muted">{usd(ask.result.cost_usd)}</p>
          </div>
        )}
      </Panel>

      <Panel title="6. The same pipeline as an indexer and skillset">
        <p className="small">
          Here the pipeline is pushed: the backend extracts, chunks, enriches and embeds, then uploads. Azure AI Search
          can pull instead. An <b>indexer</b> reads a data source (Blob storage, SharePoint, a database) on a schedule
          and runs a <b>skillset</b>: built-in skills for OCR, layout, splitting, key phrases and embeddings, and custom
          skills that call your own endpoint. Index projections write one search document per chunk. It needs a data
          source, which this lab does not create, so the definition is shown rather than run.
        </p>
        <pre className="az-code">{JSON.stringify(info?.skillset, null, 2)}</pre>
        <p className="small muted">
          <b>Integrated vectorization</b> (a vectorizer on the index, so the service embeds each query itself) needs the
          search service&apos;s managed identity to reach Azure OpenAI, because keys are off on the AI resource. Here
          the backend embeds the query, which is the same vector by another route.
        </p>
      </Panel>

      <h2>What this covers in AI-103</h2>
      <ul className="small">
        <li>
          Ingest and index documents, images, audio and video (section 1), with OCR and layout from Content
          Understanding.
        </li>
        <li>Configure semantic, hybrid and vector search (sections 2 and 3), and measure relevance performance.</li>
        <li>Implement enrichment with built-in and custom skills (section 1 by push, section 6 as a skillset).</li>
        <li>Monitor data ingestion quality and search index health (sections 1 and 4).</li>
        <li>Connect retrieval pipelines to agent tools (section 5).</li>
      </ul>
      <h2>What to take away</h2>
      <ul>
        <li>
          Measure before you choose. On these questions keyword search missed wordings the policy does not use
          (&ldquo;report the damage&rdquo; against &ldquo;tell us about a claim&rdquo;), and vectors found them. Exact
          codes like an invoice number suit keywords.
        </li>
        <li>
          The semantic ranker is not always better. It put the right source first most often, but dropped the video, a
          long transcript chunk, out of the top five for a question vector search answered first.
        </li>
        <li>Extraction is the costly, slow step. Cache its output and re-chunk or re-embed from the cache.</li>
        <li>
          Index statistics lag behind uploads by a few seconds: check counts against what the pipeline reported, not
          straight after.
        </li>
      </ul>
    </main>
  );
}
