import { useRef } from 'react';
import { useEngine } from '@/lib/useEngine';
import { mount } from './engine';
import { CodeBlock } from '@/components/CodeBlock';
import * as S from './snippets';
import './routing.css';

export default function RoutingPage() {
  const root = useRef<HTMLElement>(null);
  useEngine(root, mount);
  return (
    <main ref={root} className="page-routing">
      <div className="kicker">Lab 11 · Routing</div>
      <h1>Pay for correct answers, not requests</h1>
      <p className="lede">
        You can send every task to a large model, send every task to a small one, try the small one first and escalate,
        or let a router decide up front. This calculator compares the four on what decides the choice: cost per correct
        answer, accuracy and latency.
      </p>
      <div className="note">
        <b>Prices are Anthropic list prices as of October 2026.</b> Check the pricing page before relying on them.{' '}
        <b>Accuracy and latency values are illustrative placeholders.</b> Measure your own with an eval on your real
        tasks, because the answer depends almost entirely on them.
      </div>
      <h2>1. Your two models</h2>
      <p>
        Split your tasks into easy and hard, and give each model's accuracy on both. "Hard" can mean any group the small
        model often gets wrong. The gap between the two models on hard tasks is what routing tries to exploit.
      </p>
      <div className="grid2">
        <div className="card model-card" data-m="s">
          <h3>
            <span>Small model</span>
          </h3>
          <div className="fields">
            <label className="wide">
              <span>Prices</span>
              <select id="s_preset" />
            </label>{' '}
            <label>
              <span>Input $ per million tokens</span>
              <input type="number" id="s_pin" min="0" step="0.01" />
            </label>{' '}
            <label>
              <span>Output $ per million tokens</span>
              <input type="number" id="s_pout" min="0" step="0.01" />
            </label>{' '}
            <label>
              <span>Input tokens per task</span>
              <input type="number" id="s_tin" min="0" step="100" />
            </label>{' '}
            <label>
              <span>Output tokens per task</span>
              <input type="number" id="s_tout" min="0" step="50" />
            </label>{' '}
            <label>
              <span>
                Accuracy on easy tasks, % <span className="placeholder-tag">placeholder</span>
              </span>
              <input type="number" id="s_accE" min="0" max="100" step="1" />
            </label>{' '}
            <label>
              <span>
                Accuracy on hard tasks, % <span className="placeholder-tag">placeholder</span>
              </span>
              <input type="number" id="s_accH" min="0" max="100" step="1" />
            </label>{' '}
            <label className="wide">
              <span>
                Latency per call, seconds <span className="placeholder-tag">placeholder</span>
              </span>
              <input type="number" id="s_lat" min="0" step="0.1" />
            </label>
          </div>
          <p className="derived" id="s_derived" />
          <p className="warnline" id="s_warn" hidden />
        </div>
        <div className="card model-card" data-m="l">
          <h3>
            <span>Large model</span>
          </h3>
          <div className="fields">
            <label className="wide">
              <span>Prices</span>
              <select id="l_preset" />
            </label>{' '}
            <label>
              <span>Input $ per million tokens</span>
              <input type="number" id="l_pin" min="0" step="0.01" />
            </label>{' '}
            <label>
              <span>Output $ per million tokens</span>
              <input type="number" id="l_pout" min="0" step="0.01" />
            </label>{' '}
            <label>
              <span>Input tokens per task</span>
              <input type="number" id="l_tin" min="0" step="100" />
            </label>{' '}
            <label>
              <span>Output tokens per task</span>
              <input type="number" id="l_tout" min="0" step="50" />
            </label>{' '}
            <label>
              <span>
                Accuracy on easy tasks, % <span className="placeholder-tag">placeholder</span>
              </span>
              <input type="number" id="l_accE" min="0" max="100" step="1" />
            </label>{' '}
            <label>
              <span>
                Accuracy on hard tasks, % <span className="placeholder-tag">placeholder</span>
              </span>
              <input type="number" id="l_accH" min="0" max="100" step="1" />
            </label>{' '}
            <label className="wide">
              <span>
                Latency per call, seconds <span className="placeholder-tag">placeholder</span>
              </span>
              <input type="number" id="l_lat" min="0" step="0.1" />
            </label>
          </div>
          <p className="derived" id="l_derived" />
          <p className="warnline" id="l_warn" hidden />
        </div>
      </div>
      <p className="small muted" style={{ marginTop: '8px' }}>
        Preset prices: Claude Opus 5.5 $4 input and $20 output per million tokens, Claude Sonnet 5.5 $2 and $10, Claude
        Haiku 5.5 $0.10 and $0.50 for prompts up to 100K tokens. Anthropic list prices as of October 2026; check the
        pricing page.
      </p>
      <h2>2. Your workload and the two mixed strategies</h2>
      <p>
        The share of hard tasks decides how much a mixed strategy can save. A cascade lives or dies by its check. A
        router pays its cost on every task, and each routing mistake costs either money or accuracy.
      </p>
      <div className="grid3">
        <div className="card strat-card">
          <h3>Workload</h3>
          <p>What you run, and the accuracy you can accept.</p>
          <div className="sliders">
            <label>
              Share of hard tasks <span className="mono" id="v_hard" />
              <input type="range" id="hard" min="0" max="100" step="1" defaultValue="30" />
            </label>{' '}
            <label>
              Tasks per month <span />
              <input type="number" id="volume" min="0" step="1000" defaultValue="100000" />
            </label>{' '}
            <label>
              Accuracy you need <span className="mono" id="v_target" />
              <input type="range" id="target" min="50" max="100" step="0.5" defaultValue="90" />
            </label>
          </div>
        </div>
        <div className="card strat-card">
          <h3>Cascade</h3>
          <p>
            Every task goes to the small model first. A check passes its answer or escalates the task to the large
            model.
          </p>
          <div className="sliders">
            <label>
              <span>
                Check catches a wrong answer <span className="placeholder-tag">placeholder</span>
              </span>
              <span className="mono" id="v_catch" />
              <input type="range" id="catch" min="0" max="100" step="1" defaultValue="80" />
            </label>{' '}
            <label>
              <span>
                Check wrongly escalates a correct one <span className="placeholder-tag">placeholder</span>
              </span>
              <span className="mono" id="v_fesc" />
              <input type="range" id="fesc" min="0" max="100" step="1" defaultValue="10" />
            </label>{' '}
            <label>
              Check cost per task, $ <span />
              <input type="number" id="checkCost" min="0" step="0.0001" defaultValue="0.0001" />
            </label>{' '}
            <label>
              <span>
                Check latency, seconds <span className="placeholder-tag">placeholder</span>
              </span>
              <input type="number" id="checkLat" min="0" step="0.1" defaultValue="0" />
            </label>
          </div>
        </div>
        <div className="card strat-card">
          <h3>Router</h3>
          <p>A classifier reads each task first and sends the ones it thinks are hard to the large model.</p>
          <div className="sliders">
            <label>
              <span>
                Routing accuracy <span className="placeholder-tag">placeholder</span>
              </span>
              <span className="mono" id="v_route" />
              <input type="range" id="route" min="50" max="100" step="1" defaultValue="85" />
            </label>{' '}
            <label>
              Router cost per task, $ <span />
              <input type="number" id="routerCost" min="0" step="0.0001" defaultValue="0.0002" />
            </label>{' '}
            <label>
              <span>
                Router latency, seconds <span className="placeholder-tag">placeholder</span>
              </span>
              <input type="number" id="routerLat" min="0" step="0.1" defaultValue="0.3" />
            </label>
          </div>
        </div>
      </div>
      <h2>3. Compare the four strategies</h2>
      <p>
        Cost per correct answer is the number to compare. It is what you pay for each answer you can actually use, so a
        cheap strategy that is often wrong does not look cheaper than it is.
      </p>
      <div className="card">
        <p className="verdict" id="verdict" aria-live="polite" />
        <div className="stats">
          <div className="stat">
            <div className="v" id="tBest" />
            <div className="k">cheapest strategy that meets your accuracy</div>
          </div>
          <div className="stat">
            <div className="v" id="tCpc" />
            <div className="k">its cost per correct answer</div>
          </div>
          <div className="stat">
            <div className="v" id="tMonthly" />
            <div className="k">its monthly cost</div>
          </div>
          <div className="stat">
            <div className="v" id="tLat" />
            <div className="k">its average latency</div>
          </div>
        </div>
        <div className="legend" id="legend" />
        <p className="chart-title">Cost per correct answer</p>
        <p className="chart-sub">US dollars. Shorter is better.</p>
        <svg className="chart" id="cpcChart" role="img" aria-label="Cost per correct answer by strategy" />
        <p className="chart-title">Accuracy</p>
        <p className="chart-sub">Share of tasks answered correctly. The vertical line is the accuracy you need.</p>
        <svg className="chart" id="accChart" role="img" aria-label="Accuracy by strategy" />
        <h3>The numbers</h3>
        <div className="table-wrap">
          <table className="t" id="resTable" />
        </div>
        <p className="small muted" style={{ marginTop: '8px' }}>
          Hover over a chart row for details. The shaded table row is the cheapest strategy that meets your accuracy
          target.
        </p>
      </div>
      <h2>4. How the numbers are worked out</h2>
      <ul className="formula">
        <li>
          <b>Cost per call</b> is input tokens times the input price, plus output tokens times the output price, with
          prices per million tokens.
        </li>
        <li>
          <b>Accuracy of one model</b> is the easy share times its easy accuracy, plus the hard share times its hard
          accuracy.
        </li>
        <li>
          <b>Cascade.</b> Every task pays for the small model and the check. The check escalates a wrong answer at the
          catch rate, and a correct answer at the false escalation rate. Escalated tasks also pay for the large model
          and take its answer.
        </li>
        <li>
          <b>Router.</b> Every task pays for the router. It sends a hard task to the large model, and an easy task to
          the small one, with a probability equal to the routing accuracy. Its mistakes go the other way.
        </li>
        <li>
          <b>Cost per correct answer</b> is cost per task divided by accuracy. <b>Monthly cost</b> is cost per task
          times tasks per month.
        </li>
        <li>
          <b>Assumptions.</b> Within a task type, the two models make mistakes independently. The check and the router
          are equally good on easy and hard tasks. Caching, retries and rate limits are not modelled.
        </li>
      </ul>
      <div className="takeaways">
        <h3>Engineering takeaways</h3>
        <ul>
          <li>
            <b>Judge cost per completed task, not per request.</b> A cheaper request that needs retries is not cheaper.
            Compare strategies on what you pay for each answer you can use.
          </li>
          <li>
            <b>Before building a cascade, try the capable model at a lower effort setting.</b> Measure it on the same
            tasks first. It can match a cheaper model's cost with less complexity.
          </li>
          <li>
            <b>Prompt caches are per model.</b> A cascade splits traffic across models, so it gives up cache reuse
            between them. This calculator ignores caching, so check that effect before trusting a saving.
          </li>
          <li>
            <b>The check is the cascade.</b> Its catch rate sets your accuracy, and its false escalations set your cost.
            Measure both on labelled examples before you ship.
          </li>
          <li>
            <b>A router pays on every task.</b> It wins when hard tasks are rare and easy to spot. Every hard task it
            sends to the small model costs accuracy.
          </li>
          <li>
            <b>Escalation adds latency.</b> Escalated tasks wait for two calls in a row, so look at the slow cases, not
            only the average.
          </li>
          <li>
            <b>Measure, then decide.</b> The defaults here are placeholders. Run an eval with your own tasks, then put
            the real numbers in.
          </li>
        </ul>
        <CodeBlock html={S.s1} />
      </div>
    </main>
  );
}
