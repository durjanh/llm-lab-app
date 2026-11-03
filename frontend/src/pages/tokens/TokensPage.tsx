import { useRef } from 'react';
import { useEngine } from '@/lib/useEngine';
import { mount } from './engine';
import { CodeBlock } from '@/components/CodeBlock';
import * as S from './snippets';
import './tokens.css';

export default function TokensPage() {
  const root = useRef<HTMLElement>(null);
  useEngine(root, mount);
  return (
    <main ref={root} className="page-tokens">
      <div className="kicker">Lab 1 · Tokens</div>
      <h1>Models read tokens, not words</h1>
      <p className="lede">
        Before a model sees your prompt, a tokenizer chops it into pieces from a fixed vocabulary. Tokens are what you
        pay for, what fills the context window, and the reason models are oddly bad at spelling and arithmetic.
      </p>
      <div id="gate" />
      <section className="needs-model locked" id="lab">
        <h2>Tokenizer playground</h2>
        <p>
          Type anything. Each coloured block is one token, and the small number is its id in GPT-2's vocabulary of
          50,257 tokens. Notice that a leading space usually belongs to the word that follows it.
        </p>
        <div className="chips" id="presets" style={{ marginBottom: '10px' }} />
        <textarea id="text" rows={5} spellCheck="false" />
        <div className="row" style={{ margin: '8px 0' }}>
          <label>
            <input type="checkbox" id="showIds" defaultChecked /> Show ids
          </label>{' '}
          <label>
            <input type="checkbox" id="showSpaces" defaultChecked /> Show spaces as ·
          </label>
        </div>
        <div className="stats">
          <div className="stat">
            <div className="v" id="sTokens">
              0
            </div>
            <div className="k">tokens</div>
          </div>
          <div className="stat">
            <div className="v" id="sChars">
              0
            </div>
            <div className="k">characters</div>
          </div>
          <div className="stat">
            <div className="v" id="sRatio">
              0
            </div>
            <div className="k">characters per token</div>
          </div>
          <div className="stat">
            <div className="v" id="sWords">
              0
            </div>
            <div className="k">words</div>
          </div>
        </div>
        <div className="tok-out" id="out" aria-live="polite" />
        <p className="small muted" style={{ marginTop: '8px' }}>
          English prose usually runs at about 4 characters per token. Code, numbers, rare words and non-English text use
          more tokens for the same length, so they cost more and fill the context faster. The � blocks are pieces of a
          character that needs several bytes, such as an emoji or a Japanese character.
        </p>
        <h2>Same data, different formats</h2>
        <p>
          Six employee records, written six ways. The information is identical, but the token bill is not. Click a row
          to load it into the playground.
        </p>
        <div className="table-wrap">
          <table className="t" id="fmtTable">
            <thead>
              <tr>
                <th>Format</th>
                <th className="num">Characters</th>
                <th className="num">Tokens</th>
                <th style={{ width: '38%' }}>Relative to cheapest</th>
              </tr>
            </thead>
            <tbody />
          </table>
        </div>
        <h2>Why models trip up on some tasks</h2>
        <p>
          The model never sees letters or digits one by one. It sees the chunks below. That is why counting the letters
          in a word, reversing a string, or adding long numbers is hard without a tool.
        </p>
        <div className="card" id="quirks" />
      </section>
      <section>
        <h2>Will it fit? Plan your context budget</h2>
        <p>
          Everything you send shares one context window: system prompt, tool definitions, the conversation so far,
          retrieved documents, and the room you reserve for the answer. Enter your own numbers.
        </p>
        <div className="card">
          <div className="budget-inputs" id="budgetInputs" />
          <div style={{ marginTop: '14px' }} className="budget" id="budgetBar" role="img" aria-label="Context budget" />
          <div className="legend" id="budgetLegend" />
          <p id="budgetMsg" style={{ marginTop: '10px' }} />
        </div>
      </section>
      <div className="takeaways">
        <h3>Engineering takeaways</h3>
        <ul>
          <li>
            <b>Every model family has its own tokenizer.</b> This page shows GPT-2's, so treat its counts as a guide to
            the patterns, not to your bill. For Claude, count with the API's <code>count_tokens</code> endpoint. Don't
            use OpenAI's <code>tiktoken</code>; it undercounts Claude tokens, especially on code and non-English text.
          </li>
          <li>
            <b>Output tokens cost more than input tokens.</b> On current Claude models, output is 5 times the input
            price. Asking for a shorter answer is often the cheapest optimisation there is.
          </li>
          <li>
            <b>Pick compact formats for bulk data.</b> Minified JSON or CSV can carry the same records for far fewer
            tokens than pretty-printed JSON. Measure, because the model also needs the structure to stay readable.
          </li>
          <li>
            <b>Hand character-level work to code.</b> Counting, exact string manipulation and long arithmetic belong in
            a tool call, not in the model's head.
          </li>
          <li>
            <b>Watch whitespace in templates.</b> A trailing space or an extra newline changes the tokens the model
            sees, and can change its answer.
          </li>
          <li>
            <b>Budget the whole window.</b> Reserve output room with <code>max_tokens</code>, and check your model's
            limit. For Claude, the Models API reports it as <code>max_input_tokens</code>.
          </li>
        </ul>
        <CodeBlock html={S.s1} />
        <p className="small" style={{ margin: '10px 0 0' }}>
          Runnable version: <code>python/01_count_tokens.py</code>. Setup is in <code>python/README.md</code>.
        </p>
      </div>
    </main>
  );
}
