import { useEffect, useState } from 'react';
import {
  foundryopsService as svc,
  type Deployment,
  type EvalReport,
  type MetricSeries,
  type OpsInfo,
  type Quota,
  type SecurityReport,
  type Span,
  type TraceReport,
} from '@/services';
import { Panel, Problem, useCall, usd } from '@/pages/ai103/shared';

const num = (n: number) => n.toLocaleString('en-GB', { maximumFractionDigits: 1 });

function Spark({ s }: { s: MetricSeries }) {
  const vals = s.points.map((p) => (s.aggregation === 'average' ? p.average : p.total) ?? 0);
  const max = Math.max(...vals, 1);
  const w = 160;
  const pts = vals.map((v, i) => `${(i / Math.max(1, vals.length - 1)) * w},${28 - (v / max) * 26}`).join(' ');
  return (
    <svg width={w} height={30} aria-hidden="true">
      <polyline points={pts} fill="none" stroke="var(--brand)" strokeWidth={1.5} />
    </svg>
  );
}

function Waterfall({ spans }: { spans: Span[] }) {
  const [open, setOpen] = useState<number | null>(null);
  const total = Math.max(...spans.map((s) => s.start_ms + s.ms), 1);
  const depth = (s: Span): number =>
    s.parent === null ? 0 : 1 + depth(spans.find((x) => x.id === s.parent) ?? { ...s, parent: null });
  return (
    <div>
      {spans.map((s) => (
        <div
          key={s.id}
          onClick={() => setOpen(open === s.id ? null : s.id)}
          style={{ cursor: 'pointer', marginBottom: 6 }}
        >
          <div className="small" style={{ paddingLeft: depth(s) * 16 }}>
            <b>{s.name}</b> <span className="muted">{s.ms} ms</span>
            {s.attributes['gen_ai.usage.input_tokens'] !== undefined && (
              <span className="muted">
                {' '}
                · {String(s.attributes['gen_ai.usage.input_tokens'])} in
                {s.attributes['gen_ai.usage.output_tokens'] !== undefined &&
                  ` / ${String(s.attributes['gen_ai.usage.output_tokens'])} out`}{' '}
                tokens
              </span>
            )}
          </div>
          <div style={{ position: 'relative', height: 10, background: 'var(--line)', borderRadius: 5 }}>
            <i
              style={{
                position: 'absolute',
                left: `${(s.start_ms / total) * 100}%`,
                width: `${Math.max(0.5, (s.ms / total) * 100)}%`,
                top: 0,
                bottom: 0,
                background: depth(s) ? 'var(--brand)' : 'var(--good)',
                borderRadius: 5,
              }}
            />
          </div>
          {open === s.id && <pre className="az-code">{JSON.stringify(s.attributes, null, 2)}</pre>}
        </div>
      ))}
    </div>
  );
}

export default function FoundryOpsPage() {
  const [info, setInfo] = useState<OpsInfo | null>(null);
  const [problem, setProblem] = useState('');
  const [question, setQuestion] = useState('Is the kitchen leak covered, and what is the excess?');
  const deps = useCall<{ deployments: Deployment[] }>();
  const quotas = useCall<{ quotas: Quota[] }>();
  const rate = useCall<{ headers: Record<string, string>; ms: number; cost_usd: number }>();
  const metrics = useCall<{ series: MetricSeries[]; hours: number; notes: string[] }>();
  const sec = useCall<SecurityReport>();
  const ev = useCall<EvalReport>();
  const tr = useCall<TraceReport>();

  useEffect(() => {
    svc
      .info()
      .then(setInfo)
      .catch((e: Error) => setProblem(e.message));
    void deps.run(() => svc.deployments());
    void quotas.run(() => svc.quotas());
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <main className="page-foundryops">
      <div className="kicker">Lab 43 · AI-103: plan, manage, monitor and secure</div>
      <h1>Running AI on Foundry: deployments, limits, monitoring, security and release</h1>
      <p className="lede">
        This lab&apos;s own Azure resources, read live from Azure Resource Manager and Azure Monitor: what is deployed
        and how, how much quota is left, the rate limit on every call, the metrics, and the security settings. Then the
        two things a release needs: an evaluation with a gate, and a trace of one request from end to end.
      </p>
      <Problem error={problem} />

      <Panel title="1. Deployment types, and what is deployed">
        <div className="az-table-wrap">
          <table className="az-table">
            <thead>
              <tr>
                <th>Type</th>
                <th>How it works</th>
                <th>Choose it for</th>
              </tr>
            </thead>
            <tbody>
              {info?.deployment_types.map(([t, how, when]) => (
                <tr key={t}>
                  <td>
                    <b>{t}</b>
                  </td>
                  <td className="small">{how}</td>
                  <td className="small">{when}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <h3>This lab&apos;s deployments</h3>
        <Problem error={deps.error} />
        <div className="az-table-wrap">
          <table className="az-table">
            <thead>
              <tr>
                <th>Resource</th>
                <th>Deployment</th>
                <th>Type · capacity</th>
                <th>Guardrail</th>
                <th>Lifecycle</th>
                <th>Retires</th>
              </tr>
            </thead>
            <tbody>
              {deps.result?.deployments.map((d) => (
                <tr key={d.resource + d.name}>
                  <td className="small">
                    {d.resource}
                    <div className="muted">{d.region}</div>
                  </td>
                  <td>
                    <b>{d.name}</b>
                    <div className="small muted">
                      {d.model} {d.version}
                    </div>
                  </td>
                  <td className="small">
                    {d.sku} · {d.capacity}
                  </td>
                  <td className="small">{d.guardrail}</td>
                  <td className="small">
                    <span className={`az-tag ${d.lifecycle === 'GenerallyAvailable' ? 'pass' : 'review'}`}>
                      {d.lifecycle}
                    </span>
                  </td>
                  <td className="small">{d.retires?.slice(0, 10)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="small muted">
          The upgrade policy on each is &ldquo;once a new default version is available&rdquo;. A model marked Legacy
          still runs but has a retirement date: plan the move before it.
        </p>
      </Panel>

      <Panel title="2. Quotas">
        <p className="small muted">
          Quota is per subscription, per region, per model and deployment type, in thousands of tokens a minute (images:
          requests). Every resource in the region draws on it.
        </p>
        <Problem error={quotas.error} />
        <table className="az-table">
          <thead>
            <tr>
              <th>Region</th>
              <th>Quota</th>
              <th>Used</th>
              <th>Limit</th>
              <th>This lab&apos;s deployments</th>
            </tr>
          </thead>
          <tbody>
            {quotas.result?.quotas.map((q) => (
              <tr key={q.region + q.quota}>
                <td>{q.region}</td>
                <td className="small">{q.quota}</td>
                <td>{q.used}</td>
                <td>{q.limit}</td>
                <td>
                  {q.this_lab}
                  {q.used > q.this_lab && <span className="small muted"> (the rest by other resources)</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <Panel title="3. Rate limits on a real call">
        <button className="btn" disabled={rate.busy} onClick={() => void rate.run(() => svc.rateLimit())}>
          {rate.busy ? 'Calling…' : 'Make one small call to gpt-5.4-mini'}
        </button>
        <Problem error={rate.error} />
        {rate.result && (
          <div className="az-result small">
            <table className="az-table">
              <tbody>
                {Object.entries(rate.result.headers).map(([k, v]) => (
                  <tr key={k}>
                    <td className="mono">{k}</td>
                    <td>{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted">
              {rate.result.ms} ms · {usd(rate.result.cost_usd)}. Capacity 100 means 100,000 tokens and 100 requests a
              minute; both refill every 60 seconds. Past either, the call is a 429 with <code>retry-after</code>: the
              image lab&apos;s gpt-image-2, at capacity 1, met one on its second image.
            </p>
          </div>
        )}
      </Panel>

      <Panel title="4. Monitoring: the last 24 hours in Azure Monitor">
        <button className="btn" disabled={metrics.busy} onClick={() => void metrics.run(() => svc.metrics(24))}>
          {metrics.busy ? 'Reading…' : 'Read the metrics'}
        </button>
        <Problem error={metrics.error} />
        {metrics.result && (
          <div className="az-table-wrap az-result">
            <table className="az-table">
              <thead>
                <tr>
                  <th>Metric</th>
                  <th>Deployment</th>
                  <th>Hourly</th>
                  <th>24 h</th>
                  <th>Peak hour</th>
                </tr>
              </thead>
              <tbody>
                {metrics.result.series.map((s) => (
                  <tr key={s.resource + s.metric + s.deployment}>
                    <td className="small">
                      <b>{s.metric}</b>
                      <div className="muted">{s.resource}</div>
                    </td>
                    <td className="small">{s.deployment}</td>
                    <td>
                      <Spark s={s} />
                    </td>
                    <td className="small">
                      {s.aggregation === 'average'
                        ? `mean ${num(s.sum / Math.max(1, s.points.filter((p) => p.average).length))} ms`
                        : num(s.sum)}
                    </td>
                    <td className="small">{num(s.max)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="small muted">
              BlockedCalls counts requests refused by the guardrail or the rate limit; the RAI metrics count harmful and
              rejected requests. Alerts on these, and on time to response, are the operational signals to page someone
              on.
            </p>
          </div>
        )}
      </Panel>

      <Panel title="5. Security posture">
        <button className="btn" disabled={sec.busy} onClick={() => void sec.run(() => svc.security())}>
          {sec.busy ? 'Reading…' : 'Check the resources'}
        </button>
        <Problem error={sec.error} />
        {sec.result && (
          <div className="az-grid az-result">
            {sec.result.resources.map((r) => (
              <div key={r.name}>
                <b>{r.name}</b>{' '}
                <span className="small muted">
                  {r.kind} · {r.region}
                </span>
                <ul className="small" style={{ listStyle: 'none', paddingLeft: 0 }}>
                  {r.checks.map((c) => (
                    <li key={c.check}>
                      <span className={`az-tag ${c.ok ? 'pass' : 'review'}`}>{c.ok ? 'yes' : 'no'}</span> {c.check}{' '}
                      <span className="muted">{c.note}</span>
                    </li>
                  ))}
                </ul>
                <p className="small">
                  <b>Roles:</b> {r.roles.map((x) => `${x.role} (${x.principal_type}, ${x.scope})`).join('; ')}
                </p>
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Panel title="6. Evaluate, then gate the release">
        <p className="small muted">
          {info?.eval_cases ?? 6} answers from a policy assistant, two of them planted bad. LLM-judge evaluators score
          groundedness, relevance and coherence from 1 to 5; a code evaluator scores token F1 against a reference
          answer; Content Safety&apos;s groundedness detection gives a second opinion. The release passes only if every
          mean meets the gate:{' '}
          {info &&
            Object.entries(info.gate)
              .map(([k, v]) => `${k} ${v}`)
              .join(', ')}
          .
        </p>
        <button className="btn primary" disabled={ev.busy} onClick={() => void ev.run(() => svc.evaluate())}>
          {ev.busy ? 'Evaluating…' : 'Run the evaluation'}
        </button>
        <Problem error={ev.error} />
        {ev.result && (
          <div className="az-result">
            <p>
              <span className={`az-tag ${ev.result.release ? 'pass' : 'block'}`}>
                {ev.result.release ? 'release passes' : 'release blocked'}
              </span>{' '}
              {Object.entries(ev.result.means)
                .map(([k, v]) => `${k} ${v} (gate ${ev.result!.gate[k]})`)
                .join(' · ')}{' '}
              <span className="small muted">
                · {ev.result.seconds} s · {usd(ev.result.cost_usd)}
              </span>
            </p>
            <div className="az-table-wrap">
              <table className="az-table">
                <thead>
                  <tr>
                    <th>Question and response</th>
                    <th>Grounded</th>
                    <th>Relevant</th>
                    <th>Coherent</th>
                    <th>F1</th>
                    <th>Content Safety</th>
                  </tr>
                </thead>
                <tbody>
                  {ev.result.rows.map((r) => (
                    <tr key={r.question}>
                      <td className="small">
                        <b>{r.question}</b>
                        <div>{r.response}</div>
                        <div className="muted">{r.reason}</div>
                      </td>
                      <td className={r.groundedness < 4 ? 'az-bad' : ''}>{r.groundedness}</td>
                      <td className={r.relevance < 4 ? 'az-bad' : ''}>{r.relevance}</td>
                      <td>{r.coherence}</td>
                      <td className={r.f1 < 0.3 ? 'az-bad' : ''}>{r.f1}</td>
                      <td className="small">
                        {r.content_safety_ungrounded === null
                          ? '—'
                          : r.content_safety_ungrounded
                            ? 'ungrounded'
                            : 'grounded'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="small muted">
              Error analysis: read the low rows. A correct answer can fail F1 for being longer than the reference; a
              judge&apos;s score needs its reason before you trust it.
            </p>
          </div>
        )}
      </Panel>

      <Panel title="7. Trace one request">
        <p className="small muted">
          An agent answers from the search lab&apos;s index. Each step is an OpenTelemetry span with the generative AI
          semantic conventions (<code>gen_ai.request.model</code>, <code>gen_ai.usage.input_tokens</code>): the same
          shape Foundry tracing and Application Insights show. Select a span for its attributes.
        </p>
        <input
          type="text"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          style={{ width: '100%' }}
          aria-label="Question to trace"
        />
        <div className="az-row">
          <button className="btn primary" disabled={tr.busy} onClick={() => void tr.run(() => svc.trace(question))}>
            {tr.busy ? 'Tracing…' : 'Run and trace'}
          </button>
        </div>
        <Problem error={tr.error} />
        {tr.result && (
          <div className="az-result">
            <Waterfall spans={tr.result.spans} />
            <div className="az-quote small">{tr.result.answer}</div>
            <p className="small muted">
              trace {tr.result.trace_id.slice(0, 16)}… · {usd(tr.result.cost_usd)}. In production,{' '}
              <code>configure_azure_monitor()</code> from azure-monitor-opentelemetry sends these spans to the
              Application Insights resource connected to the Foundry project.
            </p>
          </div>
        )}
      </Panel>

      <Panel title="8. CI/CD: deployments as code, and the gate in the pipeline">
        <p className="small">
          The lab's own pipeline, <code>.github/workflows/infra.yml</code>. A pull request only checks the Bicep
          compiles: it gets no Azure sign-in. On main it signs in with OpenID Connect (no secret), shows what would
          change, runs <code>azd provision</code> and then the evaluation gate, which fails the run below its
          thresholds. <code>infra/pipeline.sh</code> sets it up: an app registration that trusts tokens for main only,
          Contributor on the subscription, and the right to grant only the lab's own roles, only on its resource group.
          The deployments themselves, with capacity, version policy and guardrail, are in{' '}
          <code>infra/resources.bicep</code>; <code>deployments.bicep</code> is the same idea for an account that
          already exists.
        </p>
        {info &&
          Object.entries(info.cicd).map(([name, text]) => (
            <details key={name}>
              <summary className="small">
                <b>{name}</b>
              </summary>
              <pre className="az-code">{text}</pre>
            </details>
          ))}
      </Panel>

      <h2>What this covers in AI-103</h2>
      <ul className="small">
        <li>Choose deployment options; configure model deployments; integrate with CI/CD (sections 1 and 8).</li>
        <li>
          Manage quotas, scaling, rate limits and cost footprints (sections 2 and 3; costs on every page of these labs).
        </li>
        <li>
          Monitor model performance and safety events (section 4); observability with tracing, token analytics and
          latency breakdowns (section 7).
        </li>
        <li>
          Configure security: managed identity, private networking, keyless credentials and role policies (section 5).
        </li>
        <li>Evaluate models and apps, with evaluators and error analysis (section 6).</li>
      </ul>
      <h2>What to take away</h2>
      <ul>
        <li>
          Quota is shared by every resource in the region: another project can use up yours. Check usage against the
          limit, not only your own capacity.
        </li>
        <li>Read the rate-limit headers on every response; they tell you how close the next 429 is.</li>
        <li>
          Keyless and a managed identity are the baseline. Public network access is still on here: a production review
          would want private endpoints.
        </li>
        <li>
          A release gate needs several evaluators: the judge caught the invented answer and the off-topic one, and F1
          alone would have failed a correct answer.
        </li>
        <li>
          Trace before you tune: in the trace, the model call is most of the time, and the search step shows what the
          answer was built from.
        </li>
      </ul>
    </main>
  );
}
