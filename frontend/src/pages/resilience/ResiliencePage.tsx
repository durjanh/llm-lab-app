import { useMemo, useState, type ReactNode } from 'react';
import { CodeBlock } from '@/components/CodeBlock';
import { Plot, type Frame } from '../deep-learning/Plot';
import {
  BATCH,
  DEADLINE_S,
  DURATION_S,
  HANG_S,
  LADDER,
  OUTAGE,
  SPIKE,
  sameStrategy,
  simulate,
  type Counting,
  type Retry,
  type Strategy,
  type Workload,
} from './simulate';
import * as S from './snippets';
import './resilience.css';

const START: Workload = {
  rpm: 40,
  spike: 3,
  promptTokens: 2000,
  maxTokens: 2000,
  outputTokens: 400,
  batchRpm: 20,
  primaryTpm: 200_000,
  secondaryTpm: 100_000,
  smallTpm: 300_000,
  counting: 'max_tokens',
  outage: true,
};

const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : '–');
const secs = (v: number) => (Number.isFinite(v) ? `${v.toFixed(v < 10 ? 1 : 0)} s` : '–');
const k = (v: number) => `${(v / 1000).toLocaleString('en-GB')}K`;
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  show,
  onChange,
}: {
  label: ReactNode;
  value: number;
  min: number;
  max: number;
  step?: number;
  show: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="rs-slider">
      <span>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(+e.target.value)} />
      <b className="mono">{show(value)}</b>
    </label>
  );
}

/** Shades the spike and the outage behind a chart's lines. */
function shade(f: Frame, top: number, outage: boolean) {
  const band = (from: number, to: number, colour: string) => {
    f.ctx.save();
    f.ctx.globalAlpha = 0.1;
    f.ctx.fillStyle = colour;
    f.ctx.fillRect(f.x(from / 60), f.y(top), f.x(to / 60) - f.x(from / 60), f.y(0) - f.y(top));
    f.ctx.restore();
  };
  band(SPIKE[0], SPIKE[1], f.c.s4);
  if (outage) band(OUTAGE[0], OUTAGE[1], f.c.bad);
}

/** Lab 34: what happens when the tokens run out, and what each defence buys. */
export default function ResiliencePage() {
  const [w, setW] = useState<Workload>(START);
  const [s, setS] = useState<Strategy>(LADDER[LADDER.length - 1].strategy);
  const set =
    <K extends keyof Workload>(key: K) =>
    (v: Workload[K]) =>
      setW((old) => ({ ...old, [key]: v }));
  const toggle = (key: Exclude<keyof Strategy, 'retry'>) => setS((old) => ({ ...old, [key]: !old[key] }));

  const result = useMemo(() => simulate(w, s), [w, s]);
  const ladder = useMemo(() => LADDER.map((r) => ({ ...r, res: simulate(w, r.strategy) })), [w]);
  const sr = result.series;
  const counted = w.promptTokens + (w.counting === 'max_tokens' ? w.maxTokens : w.outputTokens);
  const peakTpm = w.rpm * w.spike * counted + w.batchRpm * counted;
  const yReq = Math.max(4, ...sr.arrived) * 1.1;
  const yCalls = Math.max(4, ...sr.calls) * 1.1;

  return (
    <main className="page-resilience">
      <div className="kicker">Lab 34 · Rate limits and resilience</div>
      <h1>Keep running when the tokens run out</h1>
      <p className="lede">
        Every model API caps how much you can send. When a spike, a batch job or an outage pushes you past the cap, the
        requests you send get a 429 and your users get an error, unless the application was built to expect it. This lab
        simulates ten minutes of traffic against rate-limited deployments, lets you switch each defence on and off, and
        shows what each one buys.
      </p>

      <h2>First, which tokens ran out?</h2>
      <p>
        "Running out of tokens" covers four different failures. Each needs a different fix, so name it before choosing
        one.
      </p>
      <div className="table-wrap">
        <table className="t">
          <thead>
            <tr>
              <th>What ran out</th>
              <th>What you see</th>
              <th>Wait and retry?</th>
              <th>The fix</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <b>Rate limit</b>: tokens or requests per minute
              </td>
              <td>
                429 with <code>retry-after</code>
              </td>
              <td>Yes, after the wait</td>
              <td>Backoff, spread load, cut tokens per request. This lab.</td>
            </tr>
            <tr>
              <td>
                <b>Quota</b>: the capacity assigned to a deployment or region
              </td>
              <td>429s that keep coming while traffic stays high</td>
              <td>Not in the same place</td>
              <td>Another region or deployment, provisioned capacity, a quota increase. This lab.</td>
            </tr>
            <tr>
              <td>
                <b>Context window</b>: one request is too long
              </td>
              <td>
                400, or an answer cut off at <code>max_tokens</code>
              </td>
              <td>No: it fails the same way</td>
              <td>
                Send less: retrieve passages, summarise history, split the job. See{' '}
                <a href="/context-engineering">Context engineering</a>.
              </td>
            </tr>
            <tr>
              <td>
                <b>Budget</b>: your own cap or the account's spend limit
              </td>
              <td>
                Your own error, or a 429 with no <code>retry-after</code>
              </td>
              <td>No: every retry fails until it is raised</td>
              <td>A business decision. Alert before it happens.</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2>How the limits count</h2>
      <div className="grid2">
        <div className="card">
          <h3>Azure OpenAI</h3>
          <ul className="small">
            <li>
              Quota belongs to a <b>subscription, per region, per model, per deployment type</b>. You assign part of it
              to each deployment as tokens per minute (TPM); a requests-per-minute limit comes with it (for older chat
              models, 6 RPM per 1,000 TPM).
            </li>
            <li>
              The limiter counts the{' '}
              <b>
                prompt plus <code>max_tokens</code>
              </b>{' '}
              when a request arrives, not the tokens actually written. A generous <code>max_tokens</code> uses up quota
              you never spend.
            </li>
            <li>
              Requests are checked over 1 or 10 seconds, so a burst gets 429s even when the minute's total is fine.
            </li>
            <li>
              A 429 carries <code>retry-after-ms</code> and <code>retry-after</code>. Some 429s mean the service is
              short of capacity, and more quota will not fix those.
            </li>
          </ul>
        </div>
        <div className="card">
          <h3>Claude API</h3>
          <ul className="small">
            <li>
              Limits are per organisation, per model: requests, input tokens and output tokens per minute, raised by
              usage tier.
            </li>
            <li>
              A token bucket: capacity refills continuously rather than resetting each minute, but 60 RPM may be
              enforced as 1 a second.
            </li>
            <li>
              For most models, <b>cache reads do not count</b> towards input tokens per minute, and{' '}
              <code>max_tokens</code> does not count towards output tokens per minute. Prompt caching raises your
              effective limit.
            </li>
            <li>
              A 429 carries <code>retry-after</code>, and every response carries <code>anthropic-ratelimit-*</code>{' '}
              headers with what is left. A 429 for a spent monthly cap has no <code>retry-after</code>: do not retry it.
            </li>
          </ul>
        </div>
      </div>

      <h2>The simulation</h2>
      <p>
        Interactive requests arrive all the time, and triple from {mmss(SPIKE[0])} to {mmss(SPIKE[1])} (shaded amber). A
        background job runs from {mmss(BATCH[0])} to {mmss(BATCH[1])}. Each deployment's limiter holds ten seconds'
        worth of its TPM and refills continuously. A person waits up to {DEADLINE_S} seconds. If you switch on the
        outage, the primary region stops answering from {mmss(OUTAGE[0])} to {mmss(OUTAGE[1])} (shaded red), and each
        call to it hangs for {HANG_S} seconds before it times out. Every number here comes from this simulation;
        arrivals are random but the same on every run.
      </p>

      <div className="grid2">
        <div className="card">
          <h3>Traffic</h3>
          <div className="rs-controls">
            <Slider
              label="Interactive requests per minute"
              value={w.rpm}
              min={5}
              max={120}
              show={String}
              onChange={set('rpm')}
            />
            <Slider
              label="Spike"
              value={w.spike}
              min={1}
              max={5}
              step={0.5}
              show={(v) => `× ${v}`}
              onChange={set('spike')}
            />
            <Slider
              label="Background job, requests per minute"
              value={w.batchRpm}
              min={0}
              max={60}
              show={(v) => (v ? String(v) : 'off')}
              onChange={set('batchRpm')}
            />
            <Slider
              label="Prompt tokens"
              value={w.promptTokens}
              min={250}
              max={8000}
              step={250}
              show={(v) => v.toLocaleString('en-GB')}
              onChange={set('promptTokens')}
            />
            <Slider
              label="max_tokens"
              value={w.maxTokens}
              min={250}
              max={8000}
              step={250}
              show={(v) => v.toLocaleString('en-GB')}
              onChange={(v) => setW((o) => ({ ...o, maxTokens: v, outputTokens: Math.min(o.outputTokens, v) }))}
            />
            <Slider
              label="Tokens actually written"
              value={w.outputTokens}
              min={50}
              max={w.maxTokens}
              step={50}
              show={(v) => v.toLocaleString('en-GB')}
              onChange={set('outputTokens')}
            />
          </div>
        </div>
        <div className="card">
          <h3>Capacity</h3>
          <div className="rs-controls">
            <Slider
              label="Primary region, TPM"
              value={w.primaryTpm}
              min={50_000}
              max={600_000}
              step={10_000}
              show={k}
              onChange={set('primaryTpm')}
            />
            <Slider
              label="Second region, TPM"
              value={w.secondaryTpm}
              min={0}
              max={400_000}
              step={10_000}
              show={k}
              onChange={set('secondaryTpm')}
            />
            <Slider
              label="Smaller model, TPM"
              value={w.smallTpm}
              min={0}
              max={600_000}
              step={10_000}
              show={k}
              onChange={set('smallTpm')}
            />
            <label className="rs-field">
              <span>The limiter counts</span>
              <select value={w.counting} onChange={(e) => set('counting')(e.target.value as Counting)}>
                <option value="max_tokens">prompt + max_tokens (Azure OpenAI)</option>
                <option value="actual">prompt + tokens written (simplified Claude API)</option>
              </select>
            </label>
            <label className="rs-check">
              <input type="checkbox" checked={w.outage} onChange={() => set('outage')(!w.outage)} /> Primary region
              outage
            </label>
          </div>
          <p className="small muted rs-derived">
            Each request counts as {counted.toLocaleString('en-GB')} tokens. At the spike, demand is about{' '}
            <b>{k(Math.round(peakTpm / 1000) * 1000)} TPM</b> against{' '}
            {k(w.primaryTpm + (s.failover ? w.secondaryTpm : 0))} of same-model capacity you are using.
          </p>
        </div>
      </div>

      <div className="card rs-strategy">
        <h3>Your defences</h3>
        <div className="rs-toggles">
          <label className="rs-field">
            <span>On a 429</span>
            <select value={s.retry} onChange={(e) => setS((o) => ({ ...o, retry: e.target.value as Retry }))}>
              <option value="none">give up</option>
              <option value="immediate">retry at once</option>
              <option value="backoff">back off, honouring Retry-After</option>
            </select>
          </label>
          <label className="rs-check">
            <input type="checkbox" checked={s.failover} onChange={() => toggle('failover')} /> Fail over to the second
            region
          </label>
          <label className="rs-check">
            <input type="checkbox" checked={s.smallModel} onChange={() => toggle('smallModel')} /> Smaller model as a
            last resort
          </label>
          <label className="rs-check">
            <input type="checkbox" checked={s.breaker} onChange={() => toggle('breaker')} /> Circuit breaker per
            deployment
          </label>
          <label className="rs-check">
            <input type="checkbox" checked={s.priority} onChange={() => toggle('priority')} /> Background job waits for
            headroom
          </label>
        </div>
        <div className="stats">
          <div className="stat">
            <div className="v">{pct(result.liveOk, result.live)}</div>
            <div className="k">interactive answered within {DEADLINE_S} s</div>
          </div>
          <div className="stat">
            <div className="v">{pct(result.liveSmall, result.live)}</div>
            <div className="k">of them by the smaller model</div>
          </div>
          <div className="stat">
            <div className="v">
              {secs(result.p50)} / {secs(result.p95)}
            </div>
            <div className="k">wait, median / 95th percentile</div>
          </div>
          <div className="stat">
            <div className="v">{pct(result.batchDone, result.batch)}</div>
            <div className="k">background job done</div>
          </div>
          <div className="stat">
            <div className="v">{result.calls.toLocaleString('en-GB')}</div>
            <div className="k">calls sent ({result.limited.toLocaleString('en-GB')} got 429)</div>
          </div>
          <div className="stat">
            <div className="v">{result.hung.toLocaleString('en-GB')}</div>
            <div className="k">calls hung on a dead region</div>
          </div>
        </div>

        <p className="rs-chart-title">Interactive requests per 10 seconds, by when they arrived</p>
        <Plot
          x={[0, DURATION_S / 60]}
          y={[0, yReq]}
          height={220}
          xLabel="minutes"
          ariaLabel="Interactive requests arriving, answered and failed over time"
          draw={(f) => {
            shade(f, yReq, w.outage);
            f.line(sr.t, sr.arrived, f.c.muted, 1.5, [4, 3]);
            f.line(sr.t, sr.served, f.c.s3, 2);
            f.line(sr.t, sr.servedSmall, f.c.s4, 2);
            f.line(sr.t, sr.failed, f.c.bad, 2);
          }}
        />
        <div className="rs-legend small">
          <span>
            <i style={{ background: 'var(--muted)' }} /> arrived
          </span>
          <span>
            <i style={{ background: 'var(--s3)' }} /> answered
          </span>
          <span>
            <i style={{ background: 'var(--s4)' }} /> answered by the smaller model
          </span>
          <span>
            <i style={{ background: 'var(--bad)' }} /> no answer in time
          </span>
        </div>

        <div className="grid2 rs-charts">
          <div>
            <p className="rs-chart-title">Calls and 429s per 10 seconds</p>
            <Plot
              x={[0, DURATION_S / 60]}
              y={[0, yCalls]}
              height={190}
              xLabel="minutes"
              ariaLabel="Calls sent and 429 responses over time"
              draw={(f) => {
                shade(f, yCalls, w.outage);
                f.line(sr.t, sr.calls, f.c.s1, 2);
                f.line(sr.t, sr.limited, f.c.s2, 2);
              }}
            />
            <div className="rs-legend small">
              <span>
                <i style={{ background: 'var(--s1)' }} /> calls
              </span>
              <span>
                <i style={{ background: 'var(--s2)' }} /> 429 responses
              </span>
            </div>
          </div>
          <div>
            <p className="rs-chart-title">Wait for an answer, 95th percentile</p>
            <Plot
              x={[0, DURATION_S / 60]}
              y={[0, DEADLINE_S * 1.1]}
              height={190}
              xLabel="minutes"
              yLabel="seconds"
              ariaLabel="95th percentile wait over time"
              draw={(f) => {
                shade(f, DEADLINE_S * 1.1, w.outage);
                f.hline(DEADLINE_S, f.c.bad);
                f.line(sr.t, sr.p95, f.c.brand, 2);
              }}
            />
            <div className="rs-legend small">
              <span>
                <i style={{ background: 'var(--brand)' }} /> 95th percentile wait
              </span>
              <span>
                <i style={{ background: 'var(--bad)' }} /> the {DEADLINE_S} s a person waits
              </span>
            </div>
          </div>
        </div>
      </div>

      <h2>Each defence, added in turn</h2>
      <p>The same traffic with each defence added to the ones above it. Select a row to chart it.</p>
      <div className="table-wrap">
        <table className="t rs-ladder">
          <thead>
            <tr>
              <th>Defences</th>
              <th className="num">Answered</th>
              <th className="num">By smaller model</th>
              <th className="num">Median / p95 wait</th>
              <th className="num">Background done</th>
              <th className="num">Calls</th>
              <th className="num">429s</th>
              <th className="num">Hung</th>
            </tr>
          </thead>
          <tbody>
            {ladder.map(({ label, what, strategy, res }) => (
              <tr key={label} className={sameStrategy(strategy, s) ? 'on' : undefined} onClick={() => setS(strategy)}>
                <td>
                  <button type="button" className="rs-row">
                    {label}
                  </button>
                  <div className="small muted">{what}</div>
                </td>
                <td className="num">{pct(res.liveOk, res.live)}</td>
                <td className="num">{pct(res.liveSmall, res.live)}</td>
                <td className="num">
                  {secs(res.p50)} / {secs(res.p95)}
                </td>
                <td className="num">{pct(res.batchDone, res.batch)}</td>
                <td className="num">{res.calls.toLocaleString('en-GB')}</td>
                <td className="num">{res.limited.toLocaleString('en-GB')}</td>
                <td className="num">{res.hung.toLocaleString('en-GB')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>What each defence does, and what it cannot do</h2>
      <div className="grid2">
        <div className="card">
          <h3>Retries spread a spike; they cannot create capacity</h3>
          <p className="small">
            Retrying at once multiplies calls and 429s and answers almost nobody extra: watch the calls column. Backoff
            with jitter waits at least as long as the server's Retry-After, so clients stop retrying in step. It smooths
            a short spike, but when demand stays above the limit for minutes, waiting only moves the failures later. The
            SDKs already retry (two retries by default on the Claude SDK), so tune that rather than write a loop on top
            of it.
          </p>
          <CodeBlock html={S.backoff} />
        </div>
        <div className="card">
          <h3>A circuit breaker stops paying for a dead deployment</h3>
          <p className="small">
            Without one, during the outage every request first waits {HANG_S} seconds for the dead region to time out.
            With one, a few failures open the circuit, traffic goes straight elsewhere, and one trial request every so
            often checks whether the region is back. On a 429 it stays open for the Retry-After, so no one calls a
            deployment that has just said no. On a single deployment under steady overload it can lower the share of
            interactive answers, because everyone waits the full time and the patient background job takes the slots.
            Its job is to route around trouble, so pair it with somewhere else to go.
          </p>
        </div>
        <div className="card">
          <h3>More capacity: another region, provisioned throughput</h3>
          <p className="small">
            Quota is per region, so a second deployment of the same model in another region doubles what you can send
            without changing the answers. On Azure, Global and Data Zone deployments route across many regions and
            usually come with higher default quota; Data Zone keeps data in the EU or the US. Provisioned throughput
            (PTU) reserves capacity for your base load, and spillover sends the overflow to a pay-as-you-go deployment.
            Raise quota requests before you need them.
          </p>
        </div>
        <div className="card">
          <h3>A smaller model, only where it is good enough</h3>
          <p className="small">
            A smaller model has its own limit and is faster, so it absorbs what the large one cannot. It also gives
            different answers. Route only the kinds of task your <a href="/evals">evals</a> show it handles, mark the
            answers it gave, and compare cost per correct answer on the <a href="/routing">Routing</a> lab.
          </p>
        </div>
        <div className="card">
          <h3>Let background work wait</h3>
          <p className="small">
            A batch job does not need an answer in seconds; a person does. Hold background requests while a deployment
            is near its limit, give them a separate deployment, or send them through a batch API, which has its own
            limits and costs about half. On the Claude API, Message Batches are processed asynchronously at half the
            price; <code>python/14_batch_api.py</code> sends the review classification that way.
          </p>
        </div>
        <div className="card">
          <h3>Send fewer tokens</h3>
          <p className="small">
            Every defence above manages a shortage; this one shrinks it. Set <code>max_tokens</code> close to what
            answers need (it counts in full on Azure OpenAI: try the slider), cache the stable prefix of each prompt,
            retrieve passages rather than whole documents, and trim old conversation turns.
          </p>
        </div>
      </div>

      <h2>The same pattern in code</h2>
      <p>
        <code>python/resilience.py</code> puts these together: an ordered list of endpoints, each with its own circuit
        breaker, backoff with full jitter that honours <code>retry-after-ms</code> and <code>retry-after</code>, and an
        error that tells you to queue the work when the deadline would pass. <code>python/13_rate_limits.py</code> runs
        it against fake rate-limited endpoints on your machine, through the real SDK, without an API key.
      </p>
      <CodeBlock html={S.caller} />

      <h2>On Azure: a gateway in front</h2>
      <p>
        With several applications sharing deployments, put these rules in an API Management AI gateway rather than in
        every client:
      </p>
      <ul>
        <li>
          <b>A backend pool with priority groups.</b> Send to the provisioned deployment first; lower groups are used
          only when every backend in the higher group has its circuit breaker tripped.
        </li>
        <li>
          <b>A circuit breaker on each backend</b> that accepts the backend's Retry-After as its trip duration. Azure
          OpenAI can send a long Retry-After, so the breaker should honour it instead of retrying.
        </li>
        <li>
          <b>
            The <code>llm-token-limit</code> policy
          </b>
          , with a tokens-per-minute limit or a quota per application or subscription key, so one application cannot use
          everyone's quota.
        </li>
        <li>
          <b>Metrics and alerts</b> on token use per deployment, the 429 rate and cost, so capacity is raised before
          people notice.
        </li>
      </ul>

      <div className="takeaways">
        <h3>Helps you decide</h3>
        <ul>
          <li>
            Which failure you have: a short spike (backoff), sustained demand (more capacity), one deployment down
            (circuit breaker and failover), or a request too large or a budget spent (do not retry).
          </li>
          <li>Whether a smaller model is an acceptable fallback, and for which tasks: measure it first.</li>
          <li>Which work can wait, so the people waiting are served first.</li>
          <li>
            Whether to set <code>max_tokens</code> lower and cache prompts before buying more quota.
          </li>
        </ul>
      </div>
    </main>
  );
}
