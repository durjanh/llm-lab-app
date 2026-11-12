import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import {
  observabilityService,
  type CallTotals,
  type Overview,
  type Scope,
  type Trace,
} from '@/services/observabilityService';
import './observability.css';

const REFRESH_MS = 4000;
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const usd = (v: number) =>
  v === 0 ? '$0' : v < 0.01 ? `$${v.toFixed(5)}` : v < 1 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`;
const count = (v: number) => v.toLocaleString('en-GB');
const ms = (v: number | null) => (v === null ? '–' : v < 1000 ? `${v} ms` : `${(v / 1000).toFixed(1)} s`);
const clock = (t: number) => new Date(t * 1000).toLocaleTimeString('en-GB');

/** A row of totals for one area or model, with a bar for its share of the spend. */
function GroupTable<K extends 'area' | 'model'>({
  rows,
  name,
  label,
}: {
  rows: (CallTotals & Record<K, string>)[];
  name: K;
  label: string;
}) {
  const most = Math.max(...rows.map((r) => r.cost_usd), 0);
  return (
    <div className="table-wrap">
      <table className="t ob-table">
        <thead>
          <tr>
            <th>{label}</th>
            <th>Calls</th>
            <th>Spend</th>
            <th>Tokens in</th>
            <th>Tokens out</th>
            <th>p50</th>
            <th>p95</th>
            <th>Errors</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={String(r[name])}>
              <td>
                <b>{String(r[name])}</b>
              </td>
              <td>{count(r.calls)}</td>
              <td>
                <div className="ob-share" title={`${usd(r.cost_usd)} of ${usd(most)} (the largest)`}>
                  <span>{usd(r.cost_usd)}</span>
                  <i style={{ width: `${most ? Math.max(2, (r.cost_usd / most) * 100) : 0}%` }} />
                </div>
              </td>
              <td>{count(r.input_tokens)}</td>
              <td>{count(r.output_tokens)}</td>
              <td>{ms(r.p50_ms)}</td>
              <td>{ms(r.p95_ms)}</td>
              <td>{r.errors ? `✗ ${r.errors}` : '0'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** One request's model calls on a timeline: each bar starts when its call started and is as long as it took. */
function TraceRow({ trace, open, onToggle }: { trace: Trace; open: boolean; onToggle: () => void }) {
  const length = Math.max(trace.duration_ms, 1);
  return (
    <li className="ob-trace">
      <button className="ob-trace-head" onClick={onToggle} aria-expanded={open}>
        <span className="ob-trace-what">
          <b>{trace.area}</b> <span className="muted">{trace.route}</span>
        </span>
        <span className="ob-trace-meta">
          {clock(trace.started)} · {trace.spans.length} call{trace.spans.length === 1 ? '' : 's'} ·{' '}
          {ms(trace.duration_ms)} · {usd(trace.cost_usd)}
          {trace.errors > 0 && <span className="ob-flag bad"> ✗ {trace.errors} failed</span>}
        </span>
        <span className="ob-track" aria-hidden="true">
          {trace.spans.map((s) => (
            <i
              key={s.id}
              className={s.status === 'error' ? 'bad' : s.latency_ms === null ? 'tick' : ''}
              style={{
                left: `${(s.offset_ms / length) * 100}%`,
                width: s.latency_ms === null ? undefined : `${Math.max(0.6, (s.latency_ms / length) * 100)}%`,
              }}
              title={`${s.model} · starts at ${ms(s.offset_ms)} · takes ${ms(s.latency_ms)} · ${count(s.input_tokens)} in, ${count(s.output_tokens)} out`}
            />
          ))}
        </span>
      </button>
      {open && (
        <table className="t ob-table ob-spans">
          <thead>
            <tr>
              <th>#</th>
              <th>Starts at</th>
              <th>Takes</th>
              <th>Model</th>
              <th>Tokens in</th>
              <th>Tokens out</th>
              <th>Cost</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {trace.spans.map((s, i) => (
              <tr key={s.id}>
                <td>{i + 1}</td>
                <td>{ms(s.offset_ms)}</td>
                <td>{ms(s.latency_ms)}</td>
                <td>{s.model}</td>
                <td>{count(s.input_tokens)}</td>
                <td>{count(s.output_tokens)}</td>
                <td>{usd(s.cost_usd)}</td>
                <td>{s.status === 'error' ? `✗ ${s.error}` : s.fallback ? '↪ fallback' : '✓ ok'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </li>
  );
}

/** Monitoring: every model call the backend makes, as totals, a log and traces. */
export default function ObservabilityPage() {
  const [data, setData] = useState<Overview | null>(null);
  const [scope, setScope] = useState<Scope>('session');
  const [live, setLive] = useState(true);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [updated, setUpdated] = useState('');
  const latest = useRef(0); // a slow answer must not overwrite a newer one

  useEffect(() => {
    let stopped = false;
    const load = () => {
      const mine = ++latest.current;
      observabilityService
        .overview(scope)
        .then((d) => {
          if (stopped || mine !== latest.current) return;
          setData(d);
          setError('');
          setUpdated(new Date().toLocaleTimeString('en-GB'));
        })
        .catch((err) => !stopped && setError(errorText(err)));
    };
    load();
    const timer = live ? window.setInterval(load, REFRESH_MS) : 0;
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [scope, live]);

  const t = data?.totals;

  return (
    <main className="page-observability">
      <div className="kicker">Cost and operations · Monitoring</div>
      <h1>Monitoring and traces</h1>
      <p className="lede">
        Every model call this lab makes is recorded here: when, which model answered, how many tokens, what it cost, how
        long it took and which page asked. Open another lab page, send something, and watch it arrive. This is the
        “monitor” half of evaluate and monitor: evals tell you whether the answers are right, monitoring tells you what
        the system is doing.
      </p>
      <p className="ob-notice small">
        Counts and timings only. No prompt or reply text is stored, and the log keeps route shapes such as{' '}
        <code>/diet/chats/{'{id}'}/stream</code>, not ids or names. It lives on this machine in{' '}
        <code>generated/observability/calls.jsonl</code>, capped at {data ? count(data.kept.limit) : '2,000'} calls.
      </p>
      {error && <p className="ob-bad small">{error}</p>}

      <div className="ob-bar">
        <div className="ob-toggle" role="group" aria-label="Which calls to show">
          <button className={`btn small${scope === 'session' ? ' primary' : ''}`} onClick={() => setScope('session')}>
            Since the server started
          </button>
          <button className={`btn small${scope === 'all' ? ' primary' : ''}`} onClick={() => setScope('all')}>
            Everything kept{data ? ` (${count(data.kept.calls)})` : ''}
          </button>
        </div>
        <label className="small">
          <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} /> Refresh every{' '}
          {REFRESH_MS / 1000} seconds
        </label>
        <span className="small muted">{updated && `Updated ${updated}`}</span>
        <button
          className="btn small"
          onClick={() =>
            void observabilityService
              .clear()
              .then(setData)
              .catch((err) => setError(errorText(err)))
          }
        >
          Clear the log
        </button>
      </div>

      {t && data && (
        <>
          <h2>Metrics</h2>
          <div className="ob-tiles">
            <div className="ob-tile">
              <span>Model calls</span>
              <b>{count(t.calls)}</b>
            </div>
            <div className="ob-tile">
              <span>Spend</span>
              <b>{usd(t.cost_usd)}</b>
              <small>
                session {usd(data.session.spent_usd)} of ${data.session.budget_usd.toFixed(2)} budget
              </small>
            </div>
            <div className="ob-tile">
              <span>Tokens in</span>
              <b>{count(t.input_tokens)}</b>
              {t.cache_read_tokens > 0 && <small>plus {count(t.cache_read_tokens)} read from cache</small>}
            </div>
            <div className="ob-tile">
              <span>Tokens out</span>
              <b>{count(t.output_tokens)}</b>
            </div>
            <div className="ob-tile">
              <span>Latency p50</span>
              <b>{ms(t.p50_ms)}</b>
              <small>half of calls are faster</small>
            </div>
            <div className="ob-tile">
              <span>Latency p95</span>
              <b>{ms(t.p95_ms)}</b>
              <small>
                over {count(t.timed)} timed call{t.timed === 1 ? '' : 's'}
              </small>
            </div>
            <div className="ob-tile">
              <span>Errors</span>
              <b>{t.errors ? `✗ ${count(t.errors)}` : '0'}</b>
              <small>calls that raised</small>
            </div>
            <div className="ob-tile">
              <span>Fallbacks</span>
              <b>{t.fallbacks ? `↪ ${count(t.fallbacks)}` : '0'}</b>
              <small>answered by another model</small>
            </div>
          </div>

          {t.calls === 0 ? (
            <p className="ob-empty">
              No model calls yet{scope === 'session' ? ' since the server started' : ''}. Try the{' '}
              <Link to="/whiteboard">AI whiteboard</Link> or the <Link to="/diet">diet planner</Link>, then come back.
            </p>
          ) : (
            <>
              <h2>By lab area</h2>
              <GroupTable rows={data.by_area} name="area" label="Area" />
              <h2>By model</h2>
              <GroupTable rows={data.by_model} name="model" label="Model that answered" />

              <h2>Traces</h2>
              <p className="small muted">
                A trace is everything one request did. An agent turn is several model calls: the model asks for a tool,
                code runs it, and the model is called again. Each bar is one call, placed when it started; the gaps are
                the lab’s own code running tools. Click a trace for its calls.
              </p>
              <ol className="ob-traces">
                {data.traces.map((tr) => (
                  <TraceRow
                    key={tr.trace}
                    trace={tr}
                    open={open === tr.trace}
                    onToggle={() => setOpen(open === tr.trace ? null : tr.trace)}
                  />
                ))}
              </ol>

              <h2>Log: the last {data.calls.length} calls</h2>
              <div className="table-wrap">
                <table className="t ob-table">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Area</th>
                      <th>Route</th>
                      <th>Model</th>
                      <th>In</th>
                      <th>Out</th>
                      <th>Cost</th>
                      <th>Took</th>
                      <th>Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.calls.map((c) => (
                      <tr key={c.id}>
                        <td>{clock(c.at)}</td>
                        <td>{c.area}</td>
                        <td className="muted">{c.route || '–'}</td>
                        <td>
                          {c.model}
                          {c.fallback && <div className="muted">asked {c.asked}</div>}
                        </td>
                        <td>{count(c.input_tokens)}</td>
                        <td>{count(c.output_tokens)}</td>
                        <td>{usd(c.cost_usd)}</td>
                        <td>{ms(c.latency_ms)}</td>
                        <td>{c.status === 'error' ? `✗ ${c.error}` : c.fallback ? '↪ fallback' : '✓ ok'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}

      <h2>Logs, metrics and traces</h2>
      <div className="ob-three">
        <div className="card">
          <h3>Logs</h3>
          <p>
            One record per event, with its details. Here: one line per model call. You read logs to answer “what
            happened at 14:02?”
          </p>
        </div>
        <div className="card">
          <h3>Metrics</h3>
          <p>
            Numbers summed over many events: calls, spend, tokens, the p50 and p95 latency. You watch metrics to answer
            “is it getting slower or dearer?” and you alert on them.
          </p>
        </div>
        <div className="card">
          <h3>Traces</h3>
          <p>
            The events of one request, joined by an id and laid on a timeline. You open a trace to answer “why did this
            one turn take 40 seconds?”
          </p>
        </div>
      </div>

      <h2>How the lab records a call</h2>
      <div className="table-wrap">
        <table className="t">
          <thead>
            <tr>
              <th>Step</th>
              <th>Where</th>
              <th>What it adds</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>A request arrives</td>
              <td>A small middleware</td>
              <td>The area, the route’s shape and a new trace id, held for everything the request goes on to do</td>
            </tr>
            <tr>
              <td>The model is called</td>
              <td>A wrapper round the SDK client</td>
              <td>The start time and how long the call took; a call that raises is logged as an error</td>
            </tr>
            <tr>
              <td>The reply is charged</td>
              <td>The spend tracker every service already uses</td>
              <td>The model that answered, the tokens and the cost, written as one line</td>
            </tr>
            <tr>
              <td>This page asks</td>
              <td>Code over the log</td>
              <td>Sums, nearest-rank percentiles and traces. No model is called, so watching is free</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2>The same thing in OpenTelemetry</h2>
      <p>
        Production systems send this data to a collector in a standard format, OpenTelemetry, rather than to a local
        file. Its conventions for generative AI name the same fields this page shows.
      </p>
      <div className="table-wrap">
        <table className="t">
          <thead>
            <tr>
              <th>On this page</th>
              <th>In OpenTelemetry</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>A trace: one request’s calls</td>
              <td>A trace, with a trace id carried through every service the request touches</td>
            </tr>
            <tr>
              <td>One bar: a model call with a start and a length</td>
              <td>
                A span, named after the operation, such as <code>chat claude-haiku-5-5</code>
              </td>
            </tr>
            <tr>
              <td>Model asked, model that answered</td>
              <td>
                <code>gen_ai.request.model</code>, <code>gen_ai.response.model</code>
              </td>
            </tr>
            <tr>
              <td>Tokens in, tokens out</td>
              <td>
                <code>gen_ai.usage.input_tokens</code>, <code>gen_ai.usage.output_tokens</code>
              </td>
            </tr>
            <tr>
              <td>A failed call</td>
              <td>
                A span with an error status and <code>error.type</code>
              </td>
            </tr>
            <tr>
              <td>Calls, spend and latency percentiles</td>
              <td>Metrics, usually histograms the backend sums into p50 and p95</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        Microsoft Foundry collects these spans for agents it hosts and shows them in Application Insights:{' '}
        <Link to="/foundry-operations">Foundry operations</Link> has a trace from the lab’s Foundry agent. For whether
        the answers are right, see <Link to="/evals">Evals</Link>; for what a long conversation costs, see{' '}
        <Link to="/context">Context and cost</Link>.
      </p>
    </main>
  );
}
