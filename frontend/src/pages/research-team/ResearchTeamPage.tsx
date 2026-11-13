import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { statusService } from '@/services/statusService';
import {
  researchTeamService,
  type AgentName,
  type AgentResult,
  type CoverageRow,
  type ManifestView,
  type StructuredError,
  type TeamEvent,
  type TeamInfo,
  type TeamRunSummary,
} from '@/services/researchTeamService';
import './research-team.css';

type Ev<T extends TeamEvent['type']> = Extract<TeamEvent, { type: T }>;

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const usd = (v: number) => `$${v < 0.1 ? v.toFixed(4) : v.toFixed(2)}`;
const short = (v: unknown, n = 160) => {
  const s = JSON.stringify(v) ?? '';
  return s.length > n ? `${s.slice(0, n)}…` : s;
};
const AGENT_ORDER: AgentName[] = ['search', 'analysis', 'synthesis', 'report'];
const TOOL_SCOPE_NOTE: Record<AgentName, string> = {
  search: 'Reads the corpus. It is the only agent that can fetch a source, so every finding starts here.',
  analysis:
    'No tools. It reads the findings it is handed and pulls out figures, so it cannot wander off to look things up.',
  synthesis:
    'One narrow tool: verify_claim checks a figure against a source it was given. It cannot search, so it cannot add evidence nobody has checked.',
  report: 'No tools. It writes up the synthesis and nothing else.',
};

/** Text with [S01] citations drawn as chips. */
function Cited({ text }: { text: string }) {
  return (
    <>
      {text.split(/(\[S\d+\])/g).map((part, i) =>
        /^\[S\d+\]$/.test(part) ? (
          <span key={i} className="rt-cite">
            {part.slice(1, -1)}
          </span>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className="card rt-section" id={id}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function ErrorCard({ e }: { e: StructuredError }) {
  return (
    <div className="rt-error">
      <b>{e.failure_type}</b> <span className="mono small">{e.attempted_query}</span>
      <div className="small">{e.message}</div>
      <pre className="mono small">{JSON.stringify({ ...e, message: undefined, source_id: undefined }, null, 2)}</pre>
    </div>
  );
}

function CoverageTable({ rows }: { rows: CoverageRow[] }) {
  return (
    <div className="table-wrap">
      <table className="t">
        <thead>
          <tr>
            <th>Sub-question</th>
            <th>Status</th>
            <th>Note</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>
                <span className="mono">{r.id}</span> {r.text}
              </td>
              <td>
                <span className={`rt-badge ${r.status}`}>{r.status === 'supported' ? 'well supported' : r.status}</span>
              </td>
              <td className="small">{r.note}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Everything one subagent did, as it happened. */
function AgentCard({ events, callId }: { events: TeamEvent[]; callId: string }) {
  const start = events.find((e): e is Ev<'agent_start'> => e.type === 'agent_start' && e.call_id === callId);
  const mine = events.filter((e) => 'call_id' in e && e.call_id === callId);
  const done = mine.find((e): e is Ev<'agent_done'> => e.type === 'agent_done');
  if (!start) return null;
  return (
    <div className={`rt-agent ${start.agent}`}>
      <div className="rt-agent-head">
        <b>
          {start.step} · {start.agent}
        </b>
        {done && (
          <span className={`rt-badge ${done.status}`}>
            {done.status} · {done.seconds} s · {usd(done.cost_usd)}
          </span>
        )}
      </div>
      <p className="small">{start.task}</p>
      <ol className="rt-trace">
        {mine.map((e, i) => {
          if (e.type === 'turn')
            return (
              <li key={i} className="rt-turn">
                turn {e.turn} · {e.seconds} s · {usd(e.cost_usd)} ·{' '}
                {(e.input_tokens + e.output_tokens).toLocaleString('en-GB')} tokens
                {e.text && <div className="small muted">{e.text}</div>}
              </li>
            );
          if (e.type === 'tool')
            return (
              <li key={i} className={`rt-tool${e.ok ? '' : ' bad'}`}>
                <span className="mono">{e.tool}</span> <span className="mono small">{short(e.input, 90)}</span>
                <div className="mono small">
                  {e.ok ? 'ok' : 'failed'}
                  {e.attempt > 1 ? ` (attempt ${e.attempt})` : ''} · {short(e.result, 150)}
                </div>
              </li>
            );
          if (e.type === 'retry')
            return (
              <li key={i} className="rt-retry">
                {e.failure_type} on {e.tool}: retried inside the agent (attempt {e.attempt} failed)
              </li>
            );
          return null;
        })}
      </ol>
      <details className="small">
        <summary>
          The exact prompt this agent received
          {start.included.length ? ` (carries ${start.included.join(', ')})` : ' (empty context)'}
        </summary>
        <p className="muted">System prompt: its definition.</p>
        <pre className="rt-pre">{start.system}</pre>
        <p className="muted">First message:</p>
        <pre className="rt-pre">{start.prompt}</pre>
      </details>
    </div>
  );
}

export default function ResearchTeamPage() {
  const [info, setInfo] = useState<TeamInfo | null>(null);
  const [error, setError] = useState('');
  const [question, setQuestion] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState('');
  const [budget, setBudget] = useState(0.25);
  const [crash, setCrash] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const [events, setEvents] = useState<TeamEvent[]>([]);
  const [saved, setSaved] = useState<TeamRunSummary[]>([]);
  const abort = useRef<AbortController | null>(null);

  const refreshRuns = () =>
    researchTeamService
      .runs()
      .then(setSaved)
      .catch(() => undefined);

  useEffect(() => {
    researchTeamService
      .info()
      .then((i) => {
        setInfo(i);
        setQuestion((q) => q || i.questions[0].question);
      })
      .catch((err) => setError(errorText(err)));
    statusService
      .status()
      .then((s) => {
        const offered = s.claude_models?.length ? s.claude_models : s.models || [];
        setModels(offered);
        setModel(offered.includes('claude-haiku-5-5') ? 'claude-haiku-5-5' : s.default_model || offered[0] || '');
      })
      .catch(() => undefined);
    void refreshRuns();
    return () => abort.current?.abort();
  }, []);

  async function start(go: (onEvent: (e: TeamEvent) => void, signal: AbortSignal) => Promise<void>) {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setEvents([]);
    setError('');
    setRunning(true);
    try {
      await go((e) => {
        if (e.type === 'error') setError(e.message);
        setEvents((list) => [...list, e]);
      }, controller.signal);
    } catch (err) {
      if (!controller.signal.aborted) setError(errorText(err));
    } finally {
      setRunning(false);
      void refreshRuns();
    }
  }

  const run = () => start((on, signal) => researchTeamService.run(question, model, budget, crash, on, signal));
  const resume = (id: string) => start((on, signal) => researchTeamService.resume(id, model, budget, on, signal));

  const v = useMemo(() => {
    const of = <T extends TeamEvent['type']>(t: T) => events.filter((e): e is Ev<T> => e.type === t);
    const starts = of('agent_start');
    const dones = of('agent_done');
    const sq = of('subquestions');
    const manifests = of('manifest');
    const coverage = of('coverage');
    const results: { step: string; agent: AgentName; result: AgentResult }[] = dones.map((d) => ({
      step: d.step,
      agent: d.agent,
      result: d.result,
    }));
    return {
      started: of('started')[0],
      sq,
      turns: of('turn'),
      starts,
      dones,
      parallel: of('parallel'),
      retries: of('retry'),
      tools: of('tool'),
      coverage: coverage[coverage.length - 1],
      manifest: manifests[manifests.length - 1] as ManifestView | undefined,
      report: of('report')[0],
      crashed: of('crashed')[0],
      done: of('done')[0],
      notes: of('note'),
      results,
      cost: of('turn').reduce((a, t) => a + t.cost_usd, 0),
    };
  }, [events]);

  const calledAgents = new Set(v.starts.map((s) => s.agent));
  const coordinatorTurns = v.turns.filter((t) => t.agent === 'coordinator');
  const allFindings = v.results.flatMap((r) => r.result.findings ?? []);
  const comparisons = v.results.flatMap((r) => r.result.comparisons ?? []);
  const synthesis = [...v.results].reverse().find((r) => r.agent === 'synthesis')?.result;
  const subs = v.sq[v.sq.length - 1];
  const addedLater = new Set(v.sq.flatMap((s) => (s.revision > 0 ? s.added : [])));

  return (
    <main className="page-research-team">
      <div className="kicker">Building · Research team</div>
      <h1>A coordinator and four specialists</h1>
      <p className="lede">
        One question goes to a coordinator. It splits the question into sub-questions, chooses which specialist agents
        to call, checks what comes back for gaps, and sends targeted follow-ups. The agents work from an invented
        collection of fourteen sources about heat pumps in UK homes, so a run is cheap and repeatable. This is the
        multi-agent research system from the Claude Certified Architect exam (Scenario 3), run on the Messages API with
        our own orchestration.
      </p>
      {error && <p className="rt-bad small">{error}</p>}

      <section className="card rt-section" id="run">
        <h2>Ask a question</h2>
        <div className="rt-examples">
          {info?.questions.map((q) => (
            <button key={q.id} className="rt-chip" disabled={running} onClick={() => setQuestion(q.question)}>
              {q.label}
            </button>
          ))}
        </div>
        <textarea
          className="rt-question"
          rows={2}
          maxLength={500}
          value={question}
          disabled={running}
          onChange={(e) => setQuestion(e.target.value)}
        />
        <div className="rt-row">
          <select value={model} onChange={(e) => setModel(e.target.value)} disabled={running} title="Model">
            {models.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
          <select value={budget} onChange={(e) => setBudget(Number(e.target.value))} disabled={running} title="Budget">
            {[0.1, 0.25, 0.5, 1].map((b) => (
              <option key={b} value={b}>
                up to ${b.toFixed(2)}
              </option>
            ))}
          </select>
          <select
            value={crash ?? ''}
            onChange={(e) => setCrash(e.target.value === '' ? null : Number(e.target.value))}
            disabled={running}
            title="Stop the run on purpose, to try resuming"
          >
            <option value="">No simulated crash</option>
            {[1, 2, 3].map((n) => (
              <option key={n} value={n}>
                Crash after {n} subagent{n > 1 ? 's' : ''}
              </option>
            ))}
          </select>
          {running ? (
            <button className="btn" onClick={() => abort.current?.abort()}>
              Stop
            </button>
          ) : (
            <button className="btn primary" disabled={question.trim().length < 3 || !model} onClick={() => void run()}>
              Run the team
            </button>
          )}
        </div>
        {events.length > 0 && (
          <p className="small muted rt-stats">
            {running ? 'Running. ' : v.done ? `Finished (${v.done.status}). ` : ''}
            {v.turns.length} model calls · {usd(v.done?.spent_usd ?? v.cost)} · {v.done ? `${v.done.seconds} s` : ''}
            {v.started?.resumed ? ' · resumed from a manifest' : ''}
          </p>
        )}
        {v.crashed && <p className="rt-bad small">{v.crashed.message} The manifest is on disk: resume it below.</p>}
        {v.notes.map((n, i) => (
          <p key={i} className="rt-bad small">
            {n.message}
          </p>
        ))}
      </section>

      <Section id="coordinator" title="1. The coordinator: hub and spoke">
        <p>
          Subagents never talk to each other, and they never talk to you. Everything goes through the coordinator. That
          gives one place to decide who runs, to handle failures, and to see all the results. The coordinator decides
          from the question which agents to call: a narrow question needs a search and a report, not the whole pipeline.
          After synthesis, code checks coverage against the sub-questions and gives the result to the coordinator, which
          can send targeted searches to fill gaps. That loop is capped at {info?.limits.refinements ?? 2} rounds.
        </p>
        {events.length > 0 && (
          <>
            <div className="rt-pipeline">
              {AGENT_ORDER.map((a) => (
                <span key={a} className={`rt-stage${calledAgents.has(a) ? ' on' : ''}`}>
                  {a}
                  <small>
                    {calledAgents.has(a) ? `${v.starts.filter((s) => s.agent === a).length} run` : 'not called'}
                  </small>
                </span>
              ))}
            </div>
            <ol className="rt-trace">
              {coordinatorTurns.map((t, i) => (
                <li key={i} className="rt-turn">
                  coordinator turn {t.turn} · {t.seconds} s · {usd(t.cost_usd)}
                  {t.text && <div className="small">{t.text}</div>}
                  {t.tools.length > 0 && <div className="mono small">calls: {t.tools.join(', ')}</div>}
                </li>
              ))}
            </ol>
            {v.coverage && (
              <>
                <h3>Coverage check after synthesis</h3>
                <p className="small muted">
                  Refinement rounds used: {v.coverage.refinements_used} of {v.coverage.refinements_cap}.
                </p>
                <CoverageTable rows={v.coverage.coverage} />
              </>
            )}
          </>
        )}
        {v.done?.final?.answer && <p className="small">Coordinator&rsquo;s last word: {v.done.final.answer}</p>}
      </Section>

      <Section id="decomposition" title="2. Decomposing the question">
        <p>
          The coordinator first writes sub-questions. The list is not fixed: when a finding shows a sub-question nobody
          listed, the coordinator can call set_subquestions again with the new list. Coverage is measured against the
          latest list, so a question added late still has to be answered or shown as a gap.
        </p>
        {subs ? (
          <ol>
            {subs.items.map((s) => (
              <li key={s.id}>
                <span className="mono">{s.id}</span> {s.text}
                {addedLater.has(s.id) && <span className="rt-badge partial"> added during the run</span>}
              </li>
            ))}
          </ol>
        ) : (
          <p className="small muted">
            Run a question to see its sub-questions. A narrow question gets one; a broad one several.
          </p>
        )}
        {v.sq.length > 1 && <p className="small muted">The list was revised {v.sq.length - 1} time(s).</p>}
      </Section>

      <Section id="delegation" title="3. Delegation and empty context">
        <p>
          A subagent starts with nothing: no conversation, no earlier findings. The coordinator chooses which earlier
          results to pass, and they are written out in full in the subagent&rsquo;s prompt. If a result is not in the
          prompt, the subagent does not know it. Open an agent below to read the exact prompt it received.
        </p>
        <p className="small">
          The definitions have the shape of the Claude Agent SDK&rsquo;s <span className="mono">AgentDefinition</span>:
          a description (which tells the coordinator when to use it), a prompt and a tool list. In the Claude Agent SDK
          the coordinator calls a subagent with the <span className="mono">Task</span> tool, so{' '}
          <span className="mono">Task</span> must be in the coordinator&rsquo;s{' '}
          <span className="mono">allowedTools</span>; without it, no subagent can be started. Here the same job is done
          by our own <span className="mono">delegate</span> tool.
        </p>
        <div className="rt-defs">
          {info?.agents.map((a) => (
            <details key={a.name} className="rt-def">
              <summary>
                <b>{a.name}</b> <span className="small muted">{a.description}</span>
              </summary>
              <pre className="rt-pre">
                {JSON.stringify({ description: a.description, prompt: a.prompt, tools: a.tools }, null, 2)}
              </pre>
            </details>
          ))}
        </div>
        <h3>Parallel delegation</h3>
        <p className="small">
          When the coordinator makes several delegate calls in one turn, they run at the same time. Waiting for each in
          turn would add their times; running together costs only the slowest.
        </p>
        {v.parallel.length > 0 ? (
          v.parallel.map((p, i) => (
            <div key={i} className="rt-parallel">
              <b>{p.agents.length} agents at once</b> ({p.agents.join(', ')}): wall clock <b>{p.wall_s} s</b>, sum of
              the individual times {p.sum_s} s, saved {p.saved_s} s.
            </div>
          ))
        ) : (
          <p className="small muted">This run made no parallel delegation. Try the broad question.</p>
        )}
        <h3>Each agent&rsquo;s run</h3>
        {v.starts.length === 0 && <p className="small muted">Nothing has run yet.</p>}
        <div className="rt-agents">
          {v.starts.map((s) => (
            <AgentCard key={s.call_id} events={events} callId={s.call_id} />
          ))}
        </div>
      </Section>

      <Section id="scoped-tools" title="4. Scoped tools">
        <p>
          Each agent gets only the tools its job needs. Fewer tools mean fewer wrong choices, and a smaller chance of an
          agent doing another agent&rsquo;s work. Every agent also has one tool to hand in its result in a fixed shape.
        </p>
        <div className="table-wrap">
          <table className="t">
            <thead>
              <tr>
                <th>Agent</th>
                <th>Tools</th>
                <th>Why</th>
              </tr>
            </thead>
            <tbody>
              {info?.agents.map((a) => (
                <tr key={a.name}>
                  <td>{a.name}</td>
                  <td className="mono small">{a.tools.length ? a.tools.join(', ') : 'none'}</td>
                  <td className="small">{TOOL_SCOPE_NOTE[a.name]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>
          What goes wrong when synthesis can search: it meets a gap in its findings and fills it with its own search.
          The new claim has no excerpt checked against the source, and the coordinator never sees the search, so
          coverage, error handling and the record of what was read are all bypassed. The result reads well and cannot be
          traced. Scoping the tool makes the gap visible, and the coordinator sends a search agent to fill it. If a
          scoped agent does call a tool outside its list, the service refuses it and says so.
        </p>
      </Section>

      <Section id="errors" title="5. Errors: retry here, report there">
        <p>
          Two sources are built to fail. {info?.transient_id ?? 'S10'} times out on the first fetch only, so the search
          agent retries it itself (up to {info?.limits.fetch_retries ?? 2} times) and the coordinator never hears about
          it. {info?.blocked_id ?? 'S11'} always refuses access, so retrying is pointless: the agent sends up a
          structured error with the failure type, the query it tried, what it had found so far and alternatives, and the
          coordinator decides. The run carries on with partial results; it does not fail and it does not quietly drop
          the source.
        </p>
        <div className="table-wrap">
          <table className="t">
            <thead>
              <tr>
                <th>What happened</th>
                <th>Handled by</th>
                <th>Means</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Timeout, works on retry</td>
                <td>the subagent</td>
                <td className="small">Nothing to report except the retry.</td>
              </tr>
              <tr>
                <td>Access refused</td>
                <td>the coordinator, from structured context</td>
                <td className="small">The answer may exist but could not be read: a coverage gap with a reason.</td>
              </tr>
              <tr>
                <td>Search returns nothing</td>
                <td>nobody: it is a valid result</td>
                <td className="small">The corpus has nothing on it. Not an error, and not a gap to hide.</td>
              </tr>
            </tbody>
          </table>
        </div>
        {v.retries.map((r, i) => (
          <p key={i} className="rt-retry small">
            Retried {r.tool} after {r.failure_type} (agent {r.agent}, attempt {r.attempt}).
          </p>
        ))}
        {v.results.flatMap((r) =>
          (r.result.errors ?? []).map((e, i) => (
            <Fragment key={`${r.step}-${i}`}>
              <p className="small">Sent up by {r.step}:</p>
              <ErrorCard e={e} />
            </Fragment>
          )),
        )}
        {v.results.flatMap((r) =>
          (r.result.empty_queries ?? []).map((q, i) => (
            <p key={`${r.step}-e${i}`} className="small rt-empty">
              Valid empty result from {r.step}: nothing in the corpus matched &ldquo;{q}&rdquo;.
            </p>
          )),
        )}
      </Section>

      <Section id="provenance" title="6. Findings, sources and the report">
        <p>
          Every finding is a claim, an excerpt of evidence, and the source&rsquo;s id, title, publisher and date. Code
          fills in the source details and checks that the excerpt is really in the source&rsquo;s text; a finding from a
          source that was not fetched is rejected. The synthesis must keep each claim tied to its sources, and code
          checks that every figure in a claim is in a finding it cites. Where two credible sources disagree about the
          same year, both figures stay, side by side. Where figures describe different years, dates decide: a newer
          figure replacing an older one is a change over time, not a contradiction.
        </p>
        {allFindings.length > 0 && (
          <div className="table-wrap">
            <table className="t">
              <thead>
                <tr>
                  <th>Source</th>
                  <th>Claim</th>
                  <th>Evidence</th>
                  <th>Publisher, date</th>
                </tr>
              </thead>
              <tbody>
                {allFindings.map((f, i) => (
                  <tr key={i}>
                    <td className="mono">{f.source_id}</td>
                    <td>{f.claim}</td>
                    <td className="small">&ldquo;{f.evidence}&rdquo;</td>
                    <td className="small">
                      {f.publisher}, {f.date}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {v.results.some((r) => (r.result.rejected ?? []).length > 0) && (
          <p className="small rt-bad">
            Rejected by code:{' '}
            {v.results
              .flatMap((r) => r.result.rejected ?? [])
              .map((x) => `${x.source_id} (${x.reason})`)
              .join('; ')}
          </p>
        )}
        {comparisons.map((c, i) => (
          <div key={i} className={`rt-compare ${c.relation}`}>
            <b>{c.measure}</b>:{' '}
            {c.relation === 'conflict'
              ? 'a conflict (same year, different figures)'
              : c.relation === 'time_difference'
                ? 'a change over time (different years), not a contradiction'
                : 'sources agree'}
            <div className="mono small">
              {c.sides
                .map((s) => `${s.source_id}: ${s.value.toLocaleString('en-GB')} ${s.unit} (${s.year})`)
                .join('  |  ')}
            </div>
          </div>
        ))}
        {synthesis?.conflicts?.map((c, i) => (
          <div key={i} className="rt-compare conflict">
            <b>Kept side by side: {c.measure}</b>
            <div className="mono small">{c.sides.map((s) => `${s.source_id}: ${s.value}`).join('  |  ')}</div>
            {c.explanation && <div className="small">{c.explanation}</div>}
          </div>
        ))}
        {synthesis?.issues && synthesis.issues.length > 0 && (
          <div className="rt-error">
            <b>Provenance checks failed</b>
            <ul className="small">
              {synthesis.issues.map((x, i) => (
                <li key={i}>
                  {x.kind}: {x.detail} ({x.claim})
                </li>
              ))}
            </ul>
          </div>
        )}
        {synthesis && (!synthesis.issues || synthesis.issues.length === 0) && (
          <p className="small rt-ok">
            Provenance checks passed: every claim traces to a finding that holds its figures.
          </p>
        )}

        {v.report && (
          <div className="rt-report">
            <h3>{v.report.title}</h3>
            <p>
              <Cited text={v.report.summary} />
            </p>
            {v.report.sections.map((s, i) => (
              <div key={i} className="rt-rsec">
                <h4>
                  {s.heading} {s.status && <span className={`rt-badge ${s.status}`}>{s.status}</span>}
                </h4>
                {s.kind === 'table' ? (
                  <div className="table-wrap">
                    <table className="t">
                      <thead>
                        <tr>
                          {(s.columns ?? []).map((c) => (
                            <th key={c}>{c}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {(s.rows ?? []).map((row, r) => (
                          <tr key={r}>
                            {row.map((cell, c) => (
                              <td key={c}>
                                <Cited text={cell} />
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p>
                    <Cited text={s.text ?? ''} />
                  </p>
                )}
                {s.source_ids.length > 0 && <p className="small muted">Sources: {s.source_ids.join(', ')}</p>}
              </div>
            ))}
            <h4>Coverage</h4>
            <CoverageTable rows={v.report.coverage} />
            {v.report.unavailable.length > 0 && (
              <p className="small">
                Could not be read: {v.report.unavailable.map((u) => `${u.source_id} (${u.failure_type})`).join(', ')}.
              </p>
            )}
            <h4>Sources cited</h4>
            <ul className="small">
              {v.report.cited_sources.map((s) => (
                <li key={s.id}>
                  <span className="rt-cite">{s.id}</span> {s.title}. {s.publisher}, {s.date}.
                </li>
              ))}
            </ul>
            {v.report.unknown_citations.length > 0 && (
              <p className="small rt-bad">
                Cited without a finding behind them: {v.report.unknown_citations.join(', ')}.
              </p>
            )}
          </div>
        )}
        <details className="small">
          <summary>The corpus ({info?.sources.length ?? 0} invented sources)</summary>
          <div className="table-wrap">
            <table className="t">
              <thead>
                <tr>
                  <th>Id</th>
                  <th>Title</th>
                  <th>Publisher</th>
                  <th>Date</th>
                </tr>
              </thead>
              <tbody>
                {info?.sources.map((s) => (
                  <tr key={s.id}>
                    <td className="mono">{s.id}</td>
                    <td>{s.title}</td>
                    <td>{s.publisher}</td>
                    <td className="mono">{s.date}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </Section>

      <Section id="manifest" title="7. The manifest and resuming">
        <p>
          While it runs, the team writes a manifest to{' '}
          <span className="mono">generated/research-team/&lt;run id&gt;/</span>: for each subagent, its status and the
          file holding its findings. If the run stops, resume loads the manifest. Finished steps are reused from their
          files at no cost; the coordinator is told what is done, and only the unfinished work runs again. To try it,
          choose &ldquo;Crash after 1 subagent&rdquo; above, run, then resume.
        </p>
        {v.manifest && (
          <div className="table-wrap">
            <table className="t">
              <thead>
                <tr>
                  <th>Step</th>
                  <th>Agent</th>
                  <th>Status</th>
                  <th>Findings file</th>
                </tr>
              </thead>
              <tbody>
                {[...v.manifest.steps, ...v.manifest.interrupted].map((s, i) => (
                  <tr key={`${s.id}-${i}`}>
                    <td className="mono">{s.id}</td>
                    <td>{s.agent}</td>
                    <td>
                      <span className={`rt-badge ${s.status === 'done' ? 'ok' : 'partial'}`}>{s.status}</span>
                    </td>
                    <td className="mono small">{s.findings_file ?? '(none: unfinished)'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="small muted mono">{v.manifest.folder}</p>
          </div>
        )}
        <h3>Saved runs</h3>
        {saved.length === 0 && <p className="small muted">No runs saved yet.</p>}
        <ul className="rt-saved">
          {saved.map((r) => (
            <li key={r.run_id}>
              <span className="mono small">{r.run_id}</span> {r.question}{' '}
              <span className="small muted">
                ({r.status}; {r.done} done, {r.unfinished} unfinished)
              </span>{' '}
              <button
                className="btn"
                disabled={running || !model || r.status === 'done'}
                onClick={() => void resume(r.run_id)}
              >
                Resume run
              </button>
            </li>
          ))}
        </ul>
      </Section>
    </main>
  );
}
