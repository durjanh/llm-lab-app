import { useRef } from 'react';
import { useEngine } from '@/lib/useEngine';
import { mount } from './engine';
import { CodeBlock } from '@/components/CodeBlock';
import * as S from './snippets';
import './context-engineering.css';

export default function ContextEngineeringPage() {
  const root = useRef<HTMLElement>(null);
  useEngine(root, mount);
  return (
    <main ref={root} className="page-context-engineering">
      <div className="kicker">Lab 15 · Context engineering</div>
      <h1>Decide what the model sees</h1>
      <p className="lede">
        On every call, the context window is the model's entire world: it knows nothing else about your user, your data
        or the conversation so far. Context engineering is the job of choosing what goes in, in what order, and what
        gets left out, so the model has everything it needs and as little else as possible.
      </p>
      <h2>1. Build the context for one request</h2>
      <p>
        A customer writes:{' '}
        <i>
          "Order 1042 arrived damaged. Can I get a replacement before my trip on Friday, and will you pay for the return
          postage?"
        </i>{' '}
        To answer well, the support agent needs four facts. Choose what to put in the context and watch tokens, cost and
        coverage change. The sizes are illustrative.
      </p>
      <div className="row" style={{ marginBottom: '10px' }}>
        <span className="small muted">Presets:</span>
        <button className="btn small" data-preset="stuff">
          Stuff everything in
        </button>
        <button className="btn small" data-preset="engineered">
          Engineered
        </button>
        <button className="btn small" data-preset="lean">
          Too lean
        </button>
      </div>
      <div className="builder">
        <div id="groups" />
        <div>
          <div className="card">
            <h3 style={{ marginTop: '0' }}>This request</h3>
            <div className="stats" id="ctxStats" />
            <div className="stack" id="ctxStack" role="img" aria-label="Context composition" />
            <div className="legend" id="ctxLegend" />
            <h3>Facts the answer needs</h3>
            <div id="facts" />
            <div className="verdict" id="ctxVerdict" />
          </div>
        </div>
      </div>
      <h2>2. Order it so the cache can help</h2>
      <p>
        Prompt caching reuses work only for an identical prefix: the request has to match the previous one byte for byte
        from the start. One changing detail near the top breaks the cache for everything after it. Pick a layout.
      </p>
      <div className="chips" id="layoutPick" style={{ marginBottom: '6px' }} />
      <div className="grid2">
        <div className="layout" id="layout" />
        <div className="card">
          <div className="stats" id="layoutStats" />
          <p className="small" id="layoutNote" />
        </div>
      </div>
      <h2>3. Long conversations: what to keep</h2>
      <p>
        Every call resends the conversation, so it grows until it no longer fits. Four common strategies over a 50-turn
        support conversation, with an illustrative 20,000-token window. In turn 2 the customer gave their account
        number; the question is whether the model still has it at the end.
      </p>
      <div className="card">
        <svg
          className="chart"
          id="convChart"
          viewBox="0 0 720 280"
          role="img"
          aria-label="Tokens sent per turn for four strategies"
        />
        <div className="legend" id="convLegend" />
        <div className="table-wrap" style={{ marginTop: '10px' }}>
          <table className="t" id="convTable" />
        </div>
      </div>
      <h2>4. Tool results are context too</h2>
      <p>
        Whatever a tool returns is pasted into the next request, every time. A raw API response is often mostly noise.
        Shape tool output for the model: return the fields it needs, summarise long lists, and paginate.
      </p>
      <div className="grid2">
        <div>
          <b className="small">Raw order API response</b> <span className="small muted" id="rawTok" />
          <pre className="json" id="rawJson" />
        </div>
        <div>
          <b className="small">What the tool should return</b> <span className="small muted" id="slimTok" />
          <pre className="json" id="slimJson" />
        </div>
      </div>
      <p className="small muted">
        Token counts here are estimates at four characters per token. Use your provider's token counter for real
        numbers.
      </p>
      <div className="takeaways">
        <h3>Engineering takeaways</h3>
        <ul>
          <li>
            <b>Include what the task needs, and little else.</b> Missing facts make the model guess. Irrelevant text
            costs money and latency, and buries the details that matter.
          </li>
          <li>
            <b>Retrieve and look up; don't dump.</b> Fetch the relevant policy sections and the one order, instead of
            pasting the whole handbook or the whole database.
          </li>
          <li>
            <b>Offer only the tools this task needs.</b> Tool definitions are sent on every call, and a long list of
            similar tools makes the right choice harder.
          </li>
          <li>
            <b>Stable first, volatile last.</b> Tools, instructions and fixed documents go at the start so they can be
            cached. Timestamps, IDs and the user's question go at the end. Anthropic's long-context guidance also
            recommends putting long documents before the question.
          </li>
          <li>
            <b>Plan for long conversations.</b> Summarise older turns or keep a notes file of key facts. A sliding
            window is cheap but silently forgets.
          </li>
          <li>
            <b>Keep history append-only and trim at the source.</b> On recent Claude models, editing earlier turns can
            invalidate the model's earlier reasoning, and newer accounts get an error. Shape tool output when you create
            it, rather than editing old messages later. The Claude API also offers server-side compaction and context
            editing in beta.
          </li>
        </ul>
        <CodeBlock html={S.s1} />
      </div>
    </main>
  );
}
