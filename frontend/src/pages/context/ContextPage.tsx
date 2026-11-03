import type { CSSProperties } from 'react';
import { useRef } from 'react';
import { useEngine } from '@/lib/useEngine';
import { mount } from './engine';
import { CodeBlock } from '@/components/CodeBlock';
import * as S from './snippets';
import './context.css';

export default function ContextPage() {
  const root = useRef<HTMLElement>(null);
  useEngine(root, mount);
  return (
    <main ref={root} className="page-context">
      <div className="kicker">Lab 4 · Context, latency and cost</div>
      <h1>Where the time and money go</h1>
      <p className="lede">
        Three mechanics explain most LLM latency and cost: the model reads your prompt in one fast pass and then writes
        the answer one token at a time; a cache keeps it from re-reading old tokens; and every API call resends the
        whole conversation.
      </p>
      <h2>1. Reading is fast, writing is slow</h2>
      <p>
        Generation has two phases. <b>Prefill</b> processes the whole prompt in parallel. <b>Decode</b> then produces
        output tokens strictly one after another. The speeds below are illustrative starting values; measure your own
        provider and model.
      </p>
      <div className="card">
        <div className="sliders">
          <label>
            Prompt tokens <span className="mono" id="vP" />
            <input type="range" id="P" min="100" max="100000" step="100" defaultValue="3000" />
          </label>{' '}
          <label>
            Output tokens <span className="mono" id="vG" />
            <input type="range" id="G" min="10" max="4000" step="10" defaultValue="400" />
          </label>{' '}
          <label>
            Prefill speed, tokens per second <span className="mono" id="vPS" />
            <input type="range" id="PS" min="500" max="20000" step="500" defaultValue="5000" />
          </label>{' '}
          <label>
            Decode speed, tokens per second <span className="mono" id="vDS" />
            <input type="range" id="DS" min="10" max="300" step="5" defaultValue="60" />
          </label>{' '}
          <label>
            Network and queueing, ms <span className="mono" id="vOV" />
            <input type="range" id="OV" min="0" max="2000" step="50" defaultValue="300" />
          </label>
        </div>
        <div className="stats">
          <div className="stat">
            <div className="v" id="tTTFT" />
            <div className="k">time to first token</div>
          </div>
          <div className="stat">
            <div className="v" id="tDec" />
            <div className="k">writing the answer</div>
          </div>
          <div className="stat">
            <div className="v" id="tTot" />
            <div className="k">total</div>
          </div>
        </div>
        <div className="timebar" id="timebar" role="img" aria-label="Time breakdown" />
        <div className="legend">
          <span style={{ '--c': 'var(--s1)' } as CSSProperties}>Network and queueing</span>
          <span style={{ '--c': 'var(--s2)' } as CSSProperties}>Prefill, reading the prompt</span>
          <span style={{ '--c': 'var(--s3)' } as CSSProperties}>Decode, writing the answer</span>
        </div>
        <h3>What the user sees</h3>
        <div className="lane">
          <span>Streaming</span>
          <div className="track" id="laneS">
            <div className="txt" />
            <div className="cursor" />
          </div>
        </div>
        <div className="lane">
          <span>Not streaming</span>
          <div className="track" id="laneN">
            <div className="txt" />
            <div className="cursor" />
          </div>
        </div>
        <div className="row">
          <button className="btn primary" id="playT">
            Play
          </button>
          <span className="small muted" id="playNote">
            Plays in real time, sped up for anything longer than 8 seconds.
          </span>
        </div>
      </div>
      <h2>2. The KV cache: don't re-read what you've read</h2>
      <p>
        To write each new token, attention needs the keys and values of every earlier token. Without a cache the model
        would recompute them all at every step. With the <b>KV cache</b> it stores them once and only processes the
        newest token. Each row below is one decode step; dark cells are tokens processed in that step.
      </p>
      <div className="card">
        <div className="row" style={{ marginBottom: '10px' }}>
          <label>
            <input type="checkbox" id="kvOn" defaultChecked /> KV cache on
          </label>{' '}
          <button className="btn small" id="kvPlay">
            Replay
          </button>
        </div>
        <canvas id="kvGrid" width="640" height="300" />
        <div className="stats">
          <div className="stat">
            <div className="v" id="kvWith" />
            <div className="k">token passes with the cache, for the prompt and output above</div>
          </div>
          <div className="stat">
            <div className="v" id="kvWithout" />
            <div className="k">token passes without it</div>
          </div>
          <div className="stat">
            <div className="v" id="kvRatio" />
            <div className="k">work saved</div>
          </div>
        </div>
      </div>
      <h3>The cache costs memory, and that limits serving</h3>
      <p>
        The KV cache grows with every token in context. For models you host, it is often what limits how many users or
        how long a context one GPU can serve. Models with grouped-query attention share keys and values across heads to
        shrink it.
      </p>
      <div className="card">
        <div className="sliders">
          <label>
            Model <span />
            <select id="mPreset" style={{ gridColumn: '1/-1' }} />
          </label>{' '}
          <label>
            Layers <span />
            <input type="number" id="mL" min="1" />
          </label>{' '}
          <label>
            Key and value heads <span />
            <input type="number" id="mKV" min="1" />
          </label>{' '}
          <label>
            Head size <span />
            <input type="number" id="mHD" min="1" />
          </label>{' '}
          <label>
            Precision <span />
            <select id="mB" style={{ gridColumn: '1/-1' }}>
              <option value="2">16-bit</option>
              <option value="1">8-bit</option>
              <option value="0.5">4-bit</option>
            </select>
          </label>{' '}
          <label>
            Context length <span className="mono" id="vCtx" />
            <input type="range" id="mCtx" min="10" max="20" step="0.25" defaultValue="17" />
          </label>{' '}
          <label>
            Sequences served at once <span className="mono" id="vSeq" />
            <input type="range" id="mSeq" min="1" max="64" defaultValue="8" />
          </label>
        </div>
        <div className="stats">
          <div className="stat">
            <div className="v" id="kvTok" />
            <div className="k">per token</div>
          </div>
          <div className="stat">
            <div className="v" id="kvSeqM" />
            <div className="k">per sequence</div>
          </div>
          <div className="stat">
            <div className="v" id="kvAll" />
            <div className="k">all sequences</div>
          </div>
          <div className="stat">
            <div className="v" id="attnOps" />
            <div className="k">attention scores per head per layer in prefill</div>
          </div>
        </div>
        <div id="kvBarWrap" />
        <p className="small muted">
          Formula: 2 for keys and values × layers × key and value heads × head size × bytes per number × tokens ×
          sequences. Model weights need memory on top of this.
        </p>
      </div>
      <h2>3. Every call resends the whole conversation</h2>
      <p>
        APIs are stateless. On turn 20 of a chat or an agent loop, you send the system prompt, the tool definitions and
        all 19 previous turns again. Input per call grows every turn, so total cost grows roughly with the square of the
        number of turns. Prompt caching bills the repeated prefix at a fraction of the price.
      </p>
      <div className="card">
        <div className="sliders">
          <label>
            Prices <span />
            <select id="cPreset" style={{ gridColumn: '1/-1' }}>
              <option value="opus">Claude Opus 5.5</option>
              <option value="sonnet">Claude Sonnet 5.5</option>
              <option value="custom">Custom</option>
            </select>
          </label>{' '}
          <label>
            Input $ per million tokens <span />
            <input type="number" id="pIn" step="0.01" />
          </label>{' '}
          <label>
            Output $ per million tokens <span />
            <input type="number" id="pOut" step="0.01" />
          </label>{' '}
          <label>
            Cache read $ per million tokens <span />
            <input type="number" id="pRead" step="0.01" />
          </label>{' '}
          <label>
            System prompt and tools, tokens <span className="mono" id="vPre" />
            <input type="range" id="cPre" min="0" max="50000" step="500" defaultValue="6000" />
          </label>{' '}
          <label>
            User message per turn <span className="mono" id="vU" />
            <input type="range" id="cU" min="10" max="2000" step="10" defaultValue="150" />
          </label>{' '}
          <label>
            Tool results per turn <span className="mono" id="vR" />
            <input type="range" id="cR" min="0" max="10000" step="100" defaultValue="1500" />
          </label>{' '}
          <label>
            Model output per turn <span className="mono" id="vA" />
            <input type="range" id="cA" min="10" max="4000" step="10" defaultValue="400" />
          </label>{' '}
          <label>
            Turns <span className="mono" id="vT" />
            <input type="range" id="cT" min="1" max="60" defaultValue="25" />
          </label>{' '}
          <label style={{ alignSelf: 'end' }}>
            <span>
              <input type="checkbox" id="cCache" defaultChecked /> Prompt caching on
            </span>
            <span />
          </label>
        </div>
        <div className="stats">
          <div className="stat">
            <div className="v" id="cTokIn" />
            <div className="k">input tokens sent in total</div>
          </div>
          <div className="stat">
            <div className="v" id="cNo" />
            <div className="k">cost without caching</div>
          </div>
          <div className="stat">
            <div className="v" id="cYes" />
            <div className="k">cost with caching</div>
          </div>
          <div className="stat">
            <div className="v" id="cSave" />
            <div className="k">saved</div>
          </div>
        </div>
        <svg className="chart" id="costChart" viewBox="0 0 900 300" role="img" aria-label="Input tokens per call" />
        <div className="legend" id="costLegend" />
        <details>
          <summary>Show the numbers as a table</summary>
          <div className="table-wrap">
            <table className="t" id="costTable" />
          </div>
        </details>
        <p className="small muted">
          Assumes each call starts within the cache's 5-minute lifetime, the prefix is long enough to cache, cache
          writes cost 1.25 times the input price, and output prices apply to the model's visible and thinking output
          alike. Prices are Anthropic list prices as of October 2026; check the pricing page.
        </p>
      </div>
      <div className="takeaways">
        <h3>Engineering takeaways</h3>
        <ul>
          <li>
            <b>Output length drives latency.</b> Writing is far slower than reading, so a shorter answer is usually the
            biggest speed-up. Ask for concise output and set <code>max_tokens</code> deliberately.
          </li>
          <li>
            <b>Stream anything a person waits for.</b> Total time stays the same, but the first words arrive after the
            time to first token instead of at the end.
          </li>
          <li>
            <b>Put stable content first.</b> Prompt caching matches the exact prefix: tools, then system prompt, then
            messages. A timestamp or a reordered tool list near the top invalidates everything after it.
          </li>
          <li>
            <b>Check the cache is working.</b> <code>usage.cache_read_input_tokens</code> should be large on repeat
            calls. If it stays at zero, something in your prefix changes every time.
          </li>
          <li>
            <b>Long sessions need a plan.</b> Summarise or compact old turns, trim large tool results, or retrieve what
            is needed rather than keeping everything in context.
          </li>
          <li>
            <b>When self-hosting, size for the KV cache.</b> Context length times concurrency, not just model size,
            decides how much GPU memory you need.
          </li>
        </ul>
        <CodeBlock html={S.s1} />
        <p className="small" style={{ margin: '10px 0 0' }}>
          Runnable version: <code>python/04_caching_and_latency.py</code>. Setup is in <code>python/README.md</code>.
        </p>
      </div>
    </main>
  );
}
