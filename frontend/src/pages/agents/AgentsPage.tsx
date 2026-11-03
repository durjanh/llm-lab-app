import { useRef } from 'react';
import { useEngine } from '@/lib/useEngine';
import { mount } from './engine';
import { CodeBlock } from '@/components/CodeBlock';
import * as S from './snippets';
import './agents.css';

export default function AgentsPage() {
  const root = useRef<HTMLElement>(null);
  useEngine(root, mount);
  return (
    <main ref={root} className="page-agents">
      <div className="kicker">Lab 6 · Agents and tools</div>
      <h1>An agent is a loop you write</h1>
      <p className="lede">
        Tool use looks like the model acting in the world, but the model only ever writes text. It writes a structured
        request to call a tool; your code decides whether to run it, runs it, and sends the result back. Repeat until
        the model says it is done. Step through three scenarios to see exactly what crosses the wire.
      </p>
      <div className="card">
        <div className="row">
          <label>
            Scenario{' '}
            <select id="scenario">
              <option value="weather">1. One tool call</option>
              <option value="parallel">2. Two calls at once, one fails</option>
              <option value="order">3. Several steps with human approval</option>
            </select>
          </label>{' '}
          <span className="spacer" />{' '}
          <button className="btn" id="back">
            ‹ Back
          </button>{' '}
          <button className="btn primary" id="next">
            Next ›
          </button>{' '}
          <button className="btn" id="play">
            Play
          </button>{' '}
          <button className="btn" id="reset">
            Reset
          </button>
        </div>
        <div className="sim">
          <div>
            <svg id="diagram" viewBox="0 0 520 300" role="img" aria-label="Agent loop diagram" />
            <div className="explain-box" id="explain" aria-live="polite" />
            <h3>Input tokens sent per API call</h3>
            <svg
              className="chart"
              id="tokChart"
              viewBox="0 0 520 150"
              role="img"
              aria-label="Input tokens per API call"
            />
            <p className="small muted">
              Estimated at 4 characters per token, including the full tool schemas. Each call carries everything before
              it.
            </p>
          </div>
          <div>
            <div className="req-head">
              <span>The request your code sends on the next call</span>
              <span id="stepNo" />
            </div>
            <div className="req" id="req" />
          </div>
        </div>
      </div>
      <h2>Before you build one: should this be an agent?</h2>
      <p>
        An agent lets the model choose its own steps. That is powerful and expensive. A single call, or a fixed workflow
        where your code decides the steps, is simpler to test and cheaper to run. Reach for an agent only when all four
        of these hold.
      </p>
      <div className="crit">
        <div className="card">
          <h3>Complexity</h3>
          <p>
            The task is multi-step and hard to specify in advance, such as turning a design document into a pull
            request.
          </p>
        </div>
        <div className="card">
          <h3>Value</h3>
          <p>The outcome justifies more calls, more tokens and more latency.</p>
        </div>
        <div className="card">
          <h3>Viability</h3>
          <p>The model is actually good at this kind of task. Check with a small evaluation first.</p>
        </div>
        <div className="card">
          <h3>Cost of error</h3>
          <p>Mistakes can be caught and undone, through tests, review or rollback.</p>
        </div>
      </div>
      <div className="takeaways">
        <h3>Engineering takeaways</h3>
        <ul>
          <li>
            <b>Your code is in charge.</b> The model proposes a call; your code validates the input, decides whether to
            run it, and owns the side effects.
          </li>
          <li>
            <b>Tool definitions are prompt.</b> Names, descriptions and schemas are sent on every call and cost tokens
            every time. They are also your main lever on tool-use quality, so write them like documentation for a new
            colleague.
          </li>
          <li>
            <b>Return errors, don't crash.</b> Send failures back as a tool result with <code>is_error</code> set, so
            the model can correct itself. When several tools run at once, send all their results back in one message.
          </li>
          <li>
            <b>Gate anything with side effects.</b> Sending email, paying, deleting or deploying should pass a human or
            policy check first.
          </li>
          <li>
            <b>Bound the loop.</b> Cap the number of iterations, log every step, and stop on any stop reason other than
            a tool call.
          </li>
          <li>
            <b>Mind the growing context.</b> Every call resends the whole history, so cache the stable prefix and trim
            large tool results. The <a href="/context">Context &amp; cost lab</a> shows the effect.
          </li>
        </ul>
        <div className="tabs">
          <button className="chip-btn on" data-tab="manual">
            Manual loop
          </button>
          <button className="chip-btn" data-tab="runner">
            SDK tool runner
          </button>
        </div>
        <CodeBlock html={S.s1} data-panel="manual" />
        <CodeBlock html={S.s2} data-panel="runner" hidden />
        <p className="small" style={{ margin: '10px 0 0' }}>
          Runnable version: <code>python/06_agent_loop.py</code> and <code>python/07_tool_runner.py</code>. Setup is in{' '}
          <code>python/README.md</code>.
        </p>
      </div>
    </main>
  );
}
