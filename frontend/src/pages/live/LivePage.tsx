import { useRef } from 'react';
import { useEngine } from '@/lib/useEngine';
import { mount } from './engine';
import './live.css';

export default function LivePage() {
  const root = useRef<HTMLElement>(null);
  useEngine(root, mount);
  return (
    <main ref={root} className="page-live">
      <div className="kicker">Lab 12 · Live Claude</div>
      <h1>Measure real Claude calls</h1>
      <p className="lede">
        The other labs use small local models and estimates. This page sends real requests to Claude through a small
        server on your machine, then shows what each call actually cost in time and tokens. Your API key stays in the
        server and never reaches the browser.
      </p>
      <div className="status-card" id="status">
        Checking for the local server…
      </div>
      <section className="needs-model locked" id="lab">
        <h2>1. Run a prompt and measure it</h2>
        <p>
          The answer streams in as it is written. Time to first text includes any thinking the model does before it
          starts writing. Output tokens include that thinking, which you pay for even though it is not shown.
        </p>
        <div className="card">
          <div className="form">
            <label>
              Model
              <select id="m1" />
            </label>{' '}
            <label>
              Effort
              <select id="e1" defaultValue="medium">
                <option>low</option>
                <option>medium</option>
                <option>high</option>
                <option>xhigh</option>
                <option>max</option>
              </select>
            </label>{' '}
            <label>
              Max tokens
              <input type="number" id="mt1" defaultValue="4096" min="64" max="32000" step="64" />
            </label>{' '}
            <label className="wide">
              System prompt, optional
              <textarea id="sys1" rows={2} defaultValue={'You are a concise assistant for software engineers.'} />
            </label>{' '}
            <label className="wide">
              Prompt
              <textarea
                id="p1"
                rows={3}
                defaultValue={'Explain the difference between a process and a thread in three sentences.'}
              />
            </label>
          </div>
          <button className="btn primary" id="run1">
            Run
          </button>
          <div className="out" id="out1" aria-live="polite" />
          <div className="err" id="err1" />
          <div className="stats" id="stats1" />
        </div>
        <h3>Your calls</h3>
        <div className="table-wrap">
          <table className="t" id="hist">
            <thead>
              <tr>
                <th>Model</th>
                <th>Effort</th>
                <th className="num">First text</th>
                <th className="num">Total</th>
                <th className="num">Input</th>
                <th className="num">Output</th>
                <th className="num">Cost</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td colSpan={7} className="muted">
                  No calls yet.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <h2>2. Effort against quality and spend</h2>
        <p>
          Effort controls how hard the model thinks. Run the same question at several effort levels and compare
          correctness, output tokens, time and cost. Easy questions rarely need high effort; hard ones may.
        </p>
        <div className="card">
          <div className="form">
            <label>
              Model
              <select id="m2" />
            </label>{' '}
            <label className="wide">
              Question
              <select id="q2" />
            </label>{' '}
            <label className="wide" id="customWrap" hidden>
              Your question
              <textarea id="cq2" rows={2} />
            </label>{' '}
            <label id="customAns" hidden>
              Expected answer
              <input type="text" id="ca2" />
            </label>
          </div>
          <div className="modes" id="efforts2">
            <label>
              <input type="checkbox" defaultValue="low" defaultChecked /> low
            </label>{' '}
            <label>
              <input type="checkbox" defaultValue="medium" defaultChecked /> medium
            </label>{' '}
            <label>
              <input type="checkbox" defaultValue="high" defaultChecked /> high
            </label>{' '}
            <label>
              <input type="checkbox" defaultValue="xhigh" /> xhigh
            </label>{' '}
            <label>
              <input type="checkbox" defaultValue="max" /> max
            </label>
          </div>
          <button className="btn primary" id="run2">
            Run at each effort
          </button>
          <div className="err" id="err2" />
          <div className="table-wrap" style={{ marginTop: '10px' }}>
            <table className="t" id="effTable" />
          </div>
          <svg className="chart" id="effChart" viewBox="0 0 640 200" role="img" aria-label="Output tokens by effort" />
          <p className="small muted">
            Bars show output tokens, which is mostly thinking. One run per level is a single sample, so repeat before
            drawing conclusions.
          </p>
        </div>
        <h2>3. Prompt caching, done right and done wrong</h2>
        <p>
          Three separate questions share the same long handbook in the system prompt. Compare three ways of caching it.
          The explicit breakpoint marks the end of the shared part, so later calls read it from the cache. Automatic
          caching puts its breakpoint at the end of each request, after the question that changes every time, so it
          writes a new entry on every call and never reads one back.
        </p>
        <div className="card">
          <div className="form">
            <label>
              Model
              <select id="m3" />
            </label>
          </div>
          <div className="modes" id="cacheModes">
            <label>
              <input type="radio" name="cm" defaultValue="explicit" defaultChecked /> Explicit breakpoint on the system
              prompt
            </label>{' '}
            <label>
              <input type="radio" name="cm" defaultValue="auto" /> Automatic caching
            </label>{' '}
            <label>
              <input type="radio" name="cm" defaultValue="off" /> No caching
            </label>
          </div>
          <button className="btn primary" id="run3">
            Run three questions
          </button>
          <div className="err" id="err3" />
          <div className="table-wrap" style={{ marginTop: '10px' }}>
            <table className="t" id="cacheTable" />
          </div>
          <p className="small muted">
            Order matters. Caches last about five minutes, and an entry written by one mode can be read by the next. If
            you run the explicit breakpoint first, automatic caching will find that entry and look as good. To see
            automatic caching on its own, run it first, or wait five minutes after the last run.
          </p>
        </div>
        <h2>4. Count tokens exactly</h2>
        <p>The token counting endpoint uses Claude's own tokenizer, so it gives the real number, not an estimate.</p>
        <div className="card">
          <div className="form">
            <label>
              Model
              <select id="m4" />
            </label>
            <label className="wide">
              Text
              <textarea id="t4" rows={4} defaultValue={'Paste a prompt, a document or some code here.'} />
            </label>
          </div>
          <button className="btn primary" id="run4">
            Count
          </button>
          <div className="err" id="err4" />
          <div className="stats" id="stats4" />
        </div>
      </section>
      <div className="takeaways">
        <h3>Engineering takeaways</h3>
        <ul>
          <li>
            <b>Measure on your own prompts.</b> Latency, token counts and cost depend heavily on the task, the model and
            the effort level. Published averages are a starting point at best.
          </li>
          <li>
            <b>Thinking is billed as output.</b> Higher effort means more hidden output tokens, more time and more cost.
            Use the lowest effort that keeps quality on your eval.
          </li>
          <li>
            <b>Put the cache breakpoint where the shared part ends.</b> For a fixed document with changing questions,
            mark the system prompt. For a growing conversation, automatic caching works well. Check{' '}
            <code>cache_read_input_tokens</code> to prove it.
          </li>
          <li>
            <b>Keep keys on the server.</b> Never put an API key in browser code. A small backend that holds the key and
            enforces limits is the pattern this page uses.
          </li>
          <li>
            <b>Set a spending cap while experimenting.</b> The local server stops after a set amount per session, which
            you choose with <code>--budget</code>.
          </li>
        </ul>
        <p className="small">
          Runnable scripts in the <code>python</code> folder cover the same ground from the command line:{' '}
          <code>04_caching_and_latency.py</code>, <code>02_self_consistency.py</code>, <code>01_count_tokens.py</code>,
          and the FastAPI backend that serves this page is in <code>backend/</code>.
        </p>
      </div>
    </main>
  );
}
