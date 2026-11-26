import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import {
  softwareFactoryService as svc,
  type Change,
  type ChangeSummary,
  type Decision,
  type FactoryInfo,
  type FactoryState,
  type Ticket,
  type Tier,
} from '@/services/softwareFactoryService';
import { board, COLUMNS, diffLines, dollars, duration, EMPTY_LIVE, reduce, STATUS_LABEL, type Live } from './model';
import './software-factory.css';

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

function TierBadge({ tier, title }: { tier: Tier | null | undefined; title?: string }) {
  if (!tier) return null;
  return (
    <span className={`sf-tier ${tier}`} title={title}>
      {tier}
    </span>
  );
}

/** The decision a person is asked for: approve, change, reject or take over a plan or a diff. */
function DecisionCard({
  live,
  onDecide,
}: {
  live: Live;
  onDecide: (decision: Decision, note: string, plan?: string) => Promise<void>;
}) {
  const p = live.pending!;
  const [note, setNote] = useState('');
  const [plan, setPlan] = useState(p.plan ?? '');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const act = async (d: Decision) => {
    if ((d === 'reject' || d === 'changes') && !note.trim()) {
      setProblem('Say why, so the agent and the audit trail know.');
      return;
    }
    setBusy(true);
    setProblem('');
    try {
      await onDecide(d, note, p.kind === 'plan' ? plan : undefined);
    } catch (err) {
      setProblem(message(err));
      setBusy(false);
    }
  };
  return (
    <div className="card sf-decision" role="region" aria-label="Your decision">
      <h3>{p.kind === 'plan' ? 'Approve the plan before any code is written' : 'Approve the diff before it merges'}</h3>
      <p className="small muted">
        Nothing merges without you at this tier. No answer within {duration(p.timeoutS)} counts as a no.
      </p>
      {p.kind === 'plan' ? (
        <label className="sf-field">
          <span>The plan (edit it if you want the agent to work differently)</span>
          <textarea value={plan} onChange={(e) => setPlan(e.target.value)} rows={10} />
        </label>
      ) : (
        <DiffView diff={p.diff ?? ''} />
      )}
      <label className="sf-field">
        <span>Note (needed to reject or ask for changes)</span>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
      </label>
      {problem && <p className="sf-bad small">{problem}</p>}
      <div className="row sf-actions">
        <button type="button" className="btn primary" disabled={busy} onClick={() => void act('approve')}>
          {p.kind === 'plan' ? 'Approve plan' : 'Approve and merge'}
        </button>
        {p.kind === 'diff' && (
          <button type="button" className="btn" disabled={busy} onClick={() => void act('changes')}>
            Request changes
          </button>
        )}
        <button type="button" className="btn" disabled={busy} onClick={() => void act('reject')}>
          Reject
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => void act('take_over')}>
          Take over
        </button>
      </div>
    </div>
  );
}

function DiffView({ diff }: { diff: string }) {
  if (!diff.trim()) return <p className="small muted">No diff yet.</p>;
  return (
    <pre className="sf-diff" aria-label="Diff">
      {diffLines(diff).map((l, i) => (
        <span key={i} className={`sf-d-${l.kind}`}>
          {l.text || ' '}
          {'\n'}
        </span>
      ))}
    </pre>
  );
}

/** One change in full: why its tier, the plan, the diff, the tests, the reviewer, the gates and the audit trail. */
function ChangeView({ change, onRevert, busy }: { change: Change; onRevert: () => void; busy: boolean }) {
  return (
    <div className="sf-change">
      <div className="sf-change-head">
        <h3>
          {change.ticket_id}: {change.title}
        </h3>
        <TierBadge tier={change.effective_tier} />
        <span className={`sf-status ${change.status}`}>{STATUS_LABEL[change.status]}</span>
        <span className="small muted">
          {change.model} · {dollars(change.cost_usd)}
          {change.dark && ' · ran dark'}
        </span>
        {change.status === 'merged' && (
          <button type="button" className="btn small" disabled={busy} onClick={onRevert}>
            Revert (an escaped defect)
          </button>
        )}
      </div>
      {change.stopped_reason && change.status !== 'merged' && <p className="note small">{change.stopped_reason}</p>}
      <details open>
        <summary>Why this tier</summary>
        <ul className="small">
          {change.tier_reasons.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      </details>
      {change.plan && (
        <details>
          <summary>Plan</summary>
          <pre className="sf-pre">{change.plan}</pre>
        </details>
      )}
      {change.diff && (
        <details>
          <summary>
            Diff · {change.files.length} files, {change.diff_lines} lines
          </summary>
          <DiffView diff={change.diff} />
        </details>
      )}
      {change.gates.length > 0 && (
        <div className="sf-gates" aria-label="Gates">
          {change.gates.map((g) => (
            <div key={g.name} className={`sf-gate ${g.passed ? 'ok' : 'no'}`}>
              <b>{g.passed ? '✓' : '✕'}</b> {g.name}
              <span className="small muted">{g.detail}</span>
            </div>
          ))}
        </div>
      )}
      {change.review && (
        <details>
          <summary>
            Reviewer agent: {change.review.verdict ?? 'no verdict'} · {change.review.findings.length} findings
          </summary>
          <ul className="small">
            {change.review.findings.map((f, i) => (
              <li key={i}>
                <b>{f.severity}</b> {f.file}: {f.issue}
              </li>
            ))}
          </ul>
        </details>
      )}
      {change.tests && (
        <details>
          <summary>Test output</summary>
          <pre className="sf-pre">{change.tests.output || '(none)'}</pre>
        </details>
      )}
      <details>
        <summary>Audit trail · {change.audit.length} entries</summary>
        <ol className="sf-audit">
          {change.audit.map((a, i) => (
            <li key={i}>
              <span className="small muted">{a.at.slice(11, 19)}</span> <b>{a.actor}</b> {a.what}
              {a.why && <span className="small muted"> · {a.why}</span>}
            </li>
          ))}
        </ol>
      </details>
    </div>
  );
}

/**
 * The software factory: agents take tickets from plan to merge on a copy of the practice project, and people step
 * in where the risk calls for it. Low-risk changes run dark; areas earn autonomy with a clean record and lose it on
 * an escaped defect.
 */
export default function SoftwareFactoryPage() {
  const [info, setInfo] = useState<FactoryInfo | null>(null);
  const [state, setState] = useState<FactoryState | null>(null);
  const [live, setLive] = useState<Live>(EMPTY_LIVE);
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('low');
  const [selected, setSelected] = useState<Change | null>(null);
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [draft, setDraft] = useState({ title: '', description: '', kind: 'feature', area: 'reporting' });
  const abort = useRef<AbortController | null>(null);
  const running = !!live.runId && !live.done;

  const refresh = useCallback(async () => {
    try {
      setState(await svc.state());
    } catch (err) {
      setProblem(message(err));
    }
  }, []);

  useEffect(() => {
    svc
      .info()
      .then((i) => {
        setInfo(i);
        setModel(i.default_model);
      })
      .catch((err) => setProblem(message(err)));
    void refresh();
    return () => abort.current?.abort();
  }, [refresh]);

  const open = async (id: string) => {
    try {
      setSelected(await svc.change(id));
    } catch (err) {
      setProblem(message(err));
    }
  };

  const start = async (t: Ticket) => {
    if (running) return;
    setProblem('');
    setSelected(null);
    const controller = new AbortController();
    abort.current = controller;
    setLive({ ...EMPTY_LIVE, runId: 'starting' });
    try {
      await svc.start(
        { ticket_id: t.id, model, effort },
        (e) => {
          setLive((l) => reduce(l, e));
          if (e.type === 'change' || e.type === 'done') void refresh();
        },
        controller.signal,
      );
    } catch (err) {
      if (!controller.signal.aborted) setProblem(message(err));
    } finally {
      setLive((l) => ({ ...l, done: true, pending: null }));
      void refresh();
    }
  };

  const decide = async (decision: Decision, note: string, plan?: string) => {
    if (!live.runId || !live.pending) return;
    await svc.decide({ run_id: live.runId, decision_id: live.pending.decisionId, decision, note, plan });
  };

  const stop = async () => {
    if (live.runId && live.runId !== 'starting') {
      try {
        await svc.stop(live.runId);
      } catch {
        abort.current?.abort();
      }
    }
  };

  const revert = async (c: Change) => {
    setBusy(true);
    try {
      setSelected(await svc.revert(c.id, 'Flagged on the page as an escaped defect.'));
      await refresh();
    } catch (err) {
      setProblem(message(err));
    } finally {
      setBusy(false);
    }
  };

  const addTicket = async () => {
    setProblem('');
    try {
      await svc.addTicket(draft);
      setDraft({ ...draft, title: '', description: '' });
      await refresh();
    } catch (err) {
      setProblem(message(err));
    }
  };

  const reset = async () => {
    setConfirmReset(false);
    try {
      await svc.reset();
      setSelected(null);
      setLive(EMPTY_LIVE);
      await refresh();
    } catch (err) {
      setProblem(message(err));
    }
  };

  const columns = useMemo(() => board(state?.changes ?? []), [state]);
  const m = state?.metrics;

  return (
    <main className="page-software-factory">
      <p className="kicker">Building</p>
      <h1>Software factory</h1>
      <p className="lede">
        Agents do the delivery work; people set direction and apply judgement where the risk calls for it. Each ticket
        becomes a change: a planner agent proposes a plan, an implementer agent builds it in the sandbox, and gates
        check it. Low-risk changes merge with no person (they run dark); medium-risk changes wait for a person to
        approve the diff; high-risk ones wait for a person at the plan and at the diff. Areas earn more autonomy with a
        clean record and lose it when a defect escapes.
      </p>
      {info && !info.sandbox.available && (
        <p className="note">
          No sandbox is set up, so nothing can run. Start it with <code>./tools/sandbox.sh</code> and set{' '}
          <code>LLM_LAB_SANDBOX=docker</code>.
        </p>
      )}
      {problem && (
        <p className="sf-bad" role="alert">
          {problem}
        </p>
      )}

      {m && (
        <div className="stats sf-metrics" aria-label="Metrics">
          <div className="stat">
            <b>{m.merged}</b>
            <span className="small muted">changes merged</span>
          </div>
          <div className="stat">
            <b>{Math.round(m.dark_share * 100)}%</b>
            <span className="small muted">ran dark</span>
          </div>
          <div className="stat">
            <b>{m.interventions}</b>
            <span className="small muted">human steps</span>
          </div>
          <div className="stat">
            <b>{m.escapes}</b>
            <span className="small muted">escaped defects</span>
          </div>
          <div className="stat">
            <b>{duration(m.lead_time_s)}</b>
            <span className="small muted">median lead time</span>
          </div>
          <div className="stat">
            <b>{dollars(m.cost_per_change_usd)}</b>
            <span className="small muted">cost per change</span>
          </div>
        </div>
      )}

      <div className="sf-layout">
        <section className="card sf-backlog" aria-label="Backlog">
          <div className="sf-section-head">
            <h2>Backlog</h2>
            <label className="small">
              Model{' '}
              <select value={model} onChange={(e) => setModel(e.target.value)} disabled={running}>
                {info?.models.map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </select>
            </label>
            <label className="small">
              Effort{' '}
              <select value={effort} onChange={(e) => setEffort(e.target.value)} disabled={running}>
                {['low', 'medium', 'high'].map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </select>
            </label>
          </div>
          <ul className="sf-tickets">
            {state?.tickets.map((t) => (
              <li key={t.id} className="sf-ticket">
                <div className="sf-ticket-top">
                  <b>{t.id}</b> {t.title}
                </div>
                <div className="sf-ticket-meta small">
                  <span className="muted">
                    {t.kind} · {t.area}
                  </span>
                  <TierBadge tier={t.tier} title={t.tier_reasons.join('; ')} />
                  {t.effective_tier !== t.tier && (
                    <>
                      <span className="muted">→</span>
                      <TierBadge tier={t.effective_tier} title={t.effective_reason} />
                    </>
                  )}
                  <span className="sf-grow" />
                  <button
                    type="button"
                    className="btn small"
                    disabled={running || !info?.sandbox.available}
                    onClick={() => void start(t)}
                  >
                    Run
                  </button>
                </div>
                <p className="small muted sf-why">
                  {t.tier_reasons.join('; ')}. {t.effective_reason}.
                </p>
              </li>
            ))}
          </ul>
          <details className="sf-new">
            <summary>Add a ticket</summary>
            <label className="sf-field">
              <span>Title</span>
              <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
            </label>
            <label className="sf-field">
              <span>What should change, and why</span>
              <textarea
                rows={3}
                value={draft.description}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              />
            </label>
            <div className="row sf-actions">
              <label className="small">
                Kind{' '}
                <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value })}>
                  {info?.kinds.map((k) => (
                    <option key={k}>{k}</option>
                  ))}
                </select>
              </label>
              <label className="small">
                Area{' '}
                <select value={draft.area} onChange={(e) => setDraft({ ...draft, area: e.target.value })}>
                  {info?.areas.map((a) => (
                    <option key={a}>{a}</option>
                  ))}
                </select>
              </label>
              <button type="button" className="btn small" onClick={() => void addTicket()}>
                Add
              </button>
            </div>
          </details>
        </section>

        <section className="card sf-live" aria-label="The running change" aria-live="polite">
          <div className="sf-section-head">
            <h2>Now</h2>
            {running && (
              <button type="button" className="btn small" onClick={() => void stop()}>
                Stop
              </button>
            )}
          </div>
          {!live.runId && <p className="small muted">Pick a ticket and press Run. Every step appears here.</p>}
          {live.change && (
            <p>
              <b>
                {live.change.ticket_id}: {live.change.title}
              </b>{' '}
              <TierBadge tier={live.change.effective_tier} />{' '}
              <span className={`sf-status ${live.change.status}`}>{STATUS_LABEL[live.change.status]}</span>{' '}
              <span className="small muted">{dollars(live.change.cost_usd)}</span>
            </p>
          )}
          {live.error && <p className="sf-bad">{live.error}</p>}
          {live.pending && <DecisionCard key={live.pending.decisionId} live={live} onDecide={decide} />}
          <ol className="sf-log">
            {live.log.map((l, i) => (
              <li key={i} className={`sf-log-${l.tone}`}>
                <span className="small muted">{l.ts.slice(11, 19)}</span> <b>{l.who}</b> {l.text}
              </li>
            ))}
          </ol>
          {live.done && live.change && (
            <button type="button" className="btn small" onClick={() => void open(live.change!.id)}>
              Open the change
            </button>
          )}
        </section>
      </div>

      <h2>The flow</h2>
      <div className="sf-board" aria-label="Changes by stage">
        {COLUMNS.map((col) => (
          <div key={col.id} className="sf-col">
            <h3>
              {col.label} <span className="muted">{columns[col.id]?.length ?? 0}</span>
            </h3>
            {(columns[col.id] ?? []).map((c: ChangeSummary) => (
              <button key={c.id} type="button" className="sf-card" onClick={() => void open(c.id)}>
                <span>
                  <b>{c.ticket_id}</b> {c.title}
                </span>
                <span className="small muted">
                  <TierBadge tier={c.effective_tier} /> {c.dark ? 'ran dark' : `${c.human_steps} human steps`} ·{' '}
                  {dollars(c.cost_usd)}
                </span>
              </button>
            ))}
          </div>
        ))}
      </div>

      {selected && (
        <section className="card" aria-label="Change">
          <ChangeView change={selected} busy={busy || running} onRevert={() => void revert(selected)} />
        </section>
      )}

      <h2>Earned autonomy by area</h2>
      <p className="small muted">
        {info?.rules.autonomy.join(' ')} An area moves up a level after {info?.rules.promote_after} clean changes in a
        row (merged with no person correcting them) and down a level at once when a defect escapes.
      </p>
      <div className="table-wrap">
        <table className="t">
          <thead>
            <tr>
              <th>Area</th>
              <th>Level</th>
              <th>Clean streak</th>
              <th>Merged</th>
              <th>Ran dark</th>
              <th>Overrides</th>
              <th>Escapes</th>
            </tr>
          </thead>
          <tbody>
            {state &&
              Object.entries(state.ledger).map(([area, a]) => (
                <tr key={area}>
                  <td>{area}</td>
                  <td>{info?.rules.levels[String(a.level)] ?? a.level}</td>
                  <td>
                    {a.clean_streak} / {info?.rules.promote_after}
                  </td>
                  <td>{a.merged}</td>
                  <td>{a.dark}</td>
                  <td>{a.overrides}</td>
                  <td>{a.escapes}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      {info && (
        <details className="card sf-rules">
          <summary>The rules the factory applies</summary>
          <ul>
            {(Object.keys(info.rules.tiers) as Tier[]).map((t) => (
              <li key={t}>
                <TierBadge tier={t} /> {info.rules.tiers[t]}
              </li>
            ))}
          </ul>
          <p className="small">{info.rules.raise_only}</p>
          <p className="small">
            Kinds:{' '}
            {Object.entries(info.rules.kind_tier)
              .map(([k, v]) => `${k} ${v}`)
              .join(', ')}
            . Areas:{' '}
            {Object.entries(info.rules.area_tier)
              .map(([k, v]) => `${k} ${v}`)
              .join(', ')}
            .
          </p>
          <p className="small">
            Raised to high by a sensitive path or call; to medium by a new dependency, a diff over{' '}
            {info.rules.medium_diff_lines} lines, edited tests or code no test covers. A diff over{' '}
            {info.rules.max_diff_lines} lines is refused. Each change may spend {dollars(info.change_budget_usd)} and
            take {duration(info.time_limit_s)}.
          </p>
          <p className="small">
            The gates: no new failing tests (old failures on main do not count), no test deleted or skipped, no secrets,
            nothing outside the project, the diff size, and an independent reviewer agent with a checklist. A failed
            gate gets one automatic fix round, then the change is blocked.
          </p>
        </details>
      )}

      <div className="row sf-actions">
        {confirmReset ? (
          <>
            <span className="small">Start again with a fresh project, no changes and a new track record?</span>
            <button type="button" className="btn small" onClick={() => void reset()}>
              Reset
            </button>
            <button type="button" className="btn small" onClick={() => setConfirmReset(false)}>
              Cancel
            </button>
          </>
        ) : (
          <button type="button" className="btn small" disabled={running} onClick={() => setConfirmReset(true)}>
            Reset the factory
          </button>
        )}
      </div>

      <p className="small muted">
        Related: the <Link to="/coding-agent">coding agent</Link> it builds on,{' '}
        <Link to="/review-passes">review passes</Link>, <Link to="/evals">evals</Link> and the release pipeline in{' '}
        <Link to="/llmops">LLMOps</Link>.
      </p>
    </main>
  );
}
