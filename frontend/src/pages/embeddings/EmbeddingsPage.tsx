import { useRef } from 'react';
import { useEngine } from '@/lib/useEngine';
import { mount } from './engine';
import { CodeBlock } from '@/components/CodeBlock';
import * as S from './snippets';
import './embeddings.css';

export default function EmbeddingsPage() {
  const root = useRef<HTMLElement>(null);
  useEngine(root, mount);
  return (
    <main ref={root} className="page-embeddings">
      <div className="kicker">Lab 5 · Embeddings and retrieval</div>
      <h1>Search by meaning, then answer from your own documents</h1>
      <p className="lede">
        An embedding model turns a piece of text into a list of numbers, so that texts with similar meaning end up close
        together. That is the engine behind semantic search and retrieval-augmented generation (RAG): find the relevant
        passages first, then give only those to the LLM.
      </p>
      <div id="gate" />
      <section className="needs-model locked" id="lab">
        <h2>A map of meaning</h2>
        <p>
          Fifteen sentences about three topics, each turned into 384 numbers and squashed onto two dimensions so you can
          see them. Type a query to find its nearest neighbours. Compare the meaning score with the word-overlap score
          that keyword search would use.
        </p>
        <div className="row" style={{ marginBottom: '8px' }}>
          <input
            type="text"
            id="query"
            defaultValue="My puppy will not touch his food."
            style={{ flex: '1 1 320px' }}
            aria-label="Query"
          />{' '}
          <button className="btn primary" id="search">
            Search
          </button>{' '}
          <button className="btn" id="addSent" title="Add this sentence to the map">
            Add to map
          </button>
        </div>
        <div className="chips" id="qPresets" style={{ marginBottom: '10px' }} />
        <div className="map-wrap">
          <div>
            <svg id="map" viewBox="0 0 600 420" role="img" aria-label="Sentences projected onto two dimensions" />
            <div className="legend" id="mapLegend" />
            <p className="small muted" style={{ marginTop: '6px' }}>
              Squashing 384 dimensions onto 2 loses detail, so the map is approximate. The table uses the exact
              similarity.
            </p>
          </div>
          <div className="table-wrap">
            <table className="t nn" id="nnTable">
              <thead>
                <tr>
                  <th>Nearest sentences</th>
                  <th className="num">Meaning</th>
                  <th className="num">Shared words</th>
                </tr>
              </thead>
              <tbody />
            </table>
          </div>
        </div>
        <h2>Retrieval-augmented generation, step by step</h2>
        <p>
          Below is a made-up company handbook. It is split into chunks, every chunk is embedded once, and each question
          is matched against them. The best chunks are pasted into the prompt for the LLM. Change the chunking and watch
          which passages get retrieved.
        </p>
        <p>
          There are two ways to find candidates. Meaning search compares embeddings, so it matches vacation with annual
          leave. Keyword search, here the classic BM25 formula, scores chunks by the words they share with the question
          and gives rare words more weight. It finds exact amounts, codes and names that embeddings blur. Hybrid search
          runs both and merges the two rankings.
        </p>
        <div className="card">
          <div className="rag-controls">
            <label>
              Chunking <span />
              <select id="mode">
                <option value="fixed">Fixed size, by word count</option>
                <option value="section">By section heading</option>
              </select>
            </label>{' '}
            <label>
              Chunk size, words <span className="mono" id="vSize" />
              <input type="range" id="size" min="15" max="200" step="5" defaultValue="60" />
            </label>{' '}
            <label>
              Overlap <span className="mono" id="vOv" />
              <input type="range" id="overlap" min="0" max="50" step="5" defaultValue="15" />
            </label>{' '}
            <label>
              Chunks to retrieve <span className="mono" id="vK" />
              <input type="range" id="topk" min="1" max="6" defaultValue="3" />
            </label>{' '}
            <label id="thLabel">
              Minimum similarity <span className="mono" id="vTh" />
              <input type="range" id="thresh" min="0" max="0.8" step="0.02" defaultValue="0.3" />
            </label>{' '}
            <label>
              Retrieval method <span />
              <select id="method">
                <option value="embed">Embeddings only</option>
                <option value="bm25">Keywords only, BM25</option>
                <option value="hybrid">Hybrid, both fused by rank</option>
              </select>
            </label>
          </div>
          <p className="rule" id="ruleNote" />
          <div className="row" style={{ marginBottom: '6px' }}>
            <input
              type="text"
              id="ragQ"
              defaultValue="How many vacation days do I get?"
              style={{ flex: '1 1 320px' }}
              aria-label="Question"
            />{' '}
            <button className="btn primary" id="ragGo">
              Retrieve
            </button>
          </div>
          <div className="chips" id="ragPresets" />
          <p className="small muted" style={{ margin: '10px 0 0' }}>
            Try this: ask "Can I work from Spain for a month?" with fixed-size chunks, then switch to chunking by
            section heading. Then ask about the World Cup and watch the threshold stop an off-topic question.
          </p>
          <p className="small muted" style={{ margin: '6px 0 0' }}>
            Then compare methods: ask "Is there a £35 limit?" with embeddings only. Meaning search puts the travel
            section first, because an amount carries little meaning. Switch to keywords or hybrid and the expenses chunk
            that contains £35 wins. Now ask about vacation days with keywords only. The handbook says annual leave,
            never vacation, so keyword search grabs the wrong section.
          </p>
        </div>
        <div className="card" style={{ marginTop: '14px' }}>
          <h3 style={{ marginTop: '0' }}>Reranking the shortlist</h3>
          <p>
            A reranker is a second model that reads the question and one chunk together, then scores how well the chunk
            answers it. An embedding model reads them separately, so chunk vectors are computed once, ahead of time, and
            comparing them is cheap. A reranker must run once for every question and chunk pair. It is slower but more
            precise, which is why it only reorders a shortlist: here, the top 8 chunks that pass the rule above.
          </p>
          <label>
            <input type="checkbox" id="rerank" /> Rerank the top candidates with a cross-encoder
          </label>
          <div id="rrGate" hidden />
          <p className="small muted" id="rrInfo" style={{ margin: '8px 0 0' }} />
          <p className="small muted" style={{ margin: '6px 0 0' }}>
            Try this: use fixed-size chunks, ask about vacation days, and turn reranking on. The chunk that holds the
            annual leave rule moves to the top.
          </p>
        </div>
        <div className="grid2" style={{ marginTop: '14px' }}>
          <div>
            <h3 style={{ marginTop: '0' }}>The document and its chunks</h3>
            <div className="doc" id="doc" />
            <p className="small muted" style={{ marginTop: '6px' }}>
              Shading alternates between chunks. Purple marks retrieved chunks, numbered by rank.
            </p>
          </div>
          <div>
            <h3 style={{ marginTop: '0' }} id="scoreTitle">
              Every chunk, by similarity
            </h3>
            <div className="scores" id="scores" />
          </div>
        </div>
        <h3>What gets sent to the LLM</h3>
        <div className="assembled" id="assembled" />
        <p className="small muted" id="assembledInfo" style={{ marginTop: '6px' }} />
      </section>
      <div className="takeaways">
        <h3>Engineering takeaways</h3>
        <ul>
          <li>
            <b>Chunking decides what can be found.</b> Chunks that are too small split an answer in half. Chunks that
            are too large dilute the match. Splitting on the document's own structure, such as headings, is a strong
            default, and some overlap protects answers that cross a boundary.
          </li>
          <li>
            <b>Test retrieval on its own.</b> Write questions with known answer passages and measure how often the right
            passage appears in the top results. If retrieval misses, no prompt can fix the answer.
          </li>
          <li>
            <b>Use hybrid search.</b> Embeddings handle synonyms, such as vacation and annual leave. Keyword search
            handles exact amounts, codes and names, such as £35 or extension 4400. Reciprocal rank fusion merges the two
            rankings by position, so you never have to compare scores that live on different scales.
          </li>
          <li>
            <b>Rerank a shortlist.</b> A cross-encoder reads the question and each passage together, so it judges
            relevance more precisely than comparing vectors. It is too slow to run over a whole collection. Retrieve a
            few dozen candidates cheaply, then rerank only those.
          </li>
          <li>
            <b>Set a threshold and allow "I don't know".</b> Off-topic questions still get a "nearest" chunk. A minimum
            score, plus an instruction to say when the documents don't contain the answer, prevents confident nonsense.
            A fixed minimum suits cosine similarity. BM25 and fused scores have no fixed scale, so give them their own
            rule, such as requiring a shared keyword.
          </li>
          <li>
            <b>Keep sources attached.</b> Store a source id with every chunk so answers can cite it and users can check
            it.
          </li>
          <li>
            <b>Vectors only compare within one model.</b> If you change embedding models, re-embed everything.
          </li>
        </ul>
        <CodeBlock html={S.s1} />
        <p className="small" style={{ margin: '10px 0 0' }}>
          Runnable version with embeddings, BM25 and a "not found" path: <code>python/05_rag.py</code>. Setup is in{' '}
          <code>python/README.md</code>.
        </p>
      </div>
    </main>
  );
}
