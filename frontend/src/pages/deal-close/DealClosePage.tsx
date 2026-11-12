import { useEffect, useRef, useState } from 'react';
import { isLocalModel } from '@/lib/models';
import {
  dealsService,
  type DealContact,
  type DealEvent,
  type DealsInfo,
  type DealsState,
  type Outreach,
  type StepId,
  type StepStatus,
} from '@/services/dealsService';
import { statusService } from '@/services/statusService';
import './deal-close.css';

const usd = (v: number) => `$${v < 0.1 ? v.toFixed(4) : v.toFixed(2)}`;
const gbp = (v: number) => `£${v.toLocaleString('en-GB')}`;
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

interface StepView {
  status: StepStatus;
  summary: string;
  detail: unknown;
}
type Steps = Partial<Record<StepId, StepView>>;

const WHO = { model: 'Model', code: 'Code', person: 'You' } as const;
const STATUS_WORDS: Record<Outreach['status'], string> = {
  draft: 'Waiting for you',
  sent: 'Sent (simulated)',
  rejected: 'Rejected',
  blocked: 'Stopped by a rule',
};

// The shapes of each step's detail, as the backend sends them.
interface WinDetail {
  why_won: string;
  pains: string[];
  trigger: string;
  proof_point: string;
  names_removed_by_code: string[];
}
interface Candidate {
  account_id: string;
  name: string;
  industry: string;
  employees: number;
  region: string;
  current_vendor: string;
  similarity: { score: number; parts: Record<string, number> };
}
interface Rated {
  account_id: string;
  name: string;
  similarity: number;
  need: number;
  timing: number;
  combined: number;
  priority: 'A' | 'B' | 'skip';
  angle: string;
  reason: string;
}
interface EnrichDetail {
  contacts: { account: string; contact: string | null; role: string | null; why: string; ok: boolean }[];
  sends_left_today: number;
  daily_cap: number;
}

/** What one step found, as a small table or a few lines. */
function StepDetail({ id, view, info }: { id: StepId; view: StepView | undefined; info: DealsInfo }) {
  if (!view || view.status === 'idle') return <p className="small muted">Not run yet.</p>;
  if (view.status === 'running') return <p className="small muted">Working…</p>;
  if (view.status === 'failed') return <p className="dc-bad small">{view.summary}</p>;
  const d = view.detail;
  if (id === 'trigger') {
    const t = d as { account: string; value_gbp: number; displaced: string; win_notes: string };
    return (
      <>
        <p>
          {t.account} · {gbp(t.value_gbp)}
          {t.displaced && <> · replaced {t.displaced}</>}
        </p>
        <p className="small muted">The sales team’s notes, which the next step reads: {t.win_notes}</p>
      </>
    );
  }
  if (id === 'win') {
    const w = d as WinDetail;
    return (
      <>
        <p>{w.why_won}</p>
        <p className="small">
          <b>Their problems:</b> {w.pains.join('; ')}. <b>What made them act:</b> {w.trigger}
        </p>
        <p className="small">
          <b>Proof point for other companies:</b> {w.proof_point}
        </p>
        {w.names_removed_by_code.length > 0 && (
          <p className="small muted">
            The model named the customer ({w.names_removed_by_code.join(', ')}); it was asked again, and code removed
            any name left.
          </p>
        )}
      </>
    );
  }
  if (id === 'finder') {
    const rows = d as Candidate[];
    return (
      <div className="table-wrap">
        <table className="t">
          <thead>
            <tr>
              <th>Account</th>
              <th>Industry</th>
              <th>Staff</th>
              <th>Region</th>
              <th>Similarity</th>
              <th>Made up of</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.account_id}>
                <td>{c.name}</td>
                <td>{c.industry}</td>
                <td>{c.employees.toLocaleString('en-GB')}</td>
                <td>{c.region}</td>
                <td>
                  <b>{c.similarity.score}</b>
                </td>
                <td className="small">
                  {Object.entries(c.similarity.parts)
                    .filter(([, v]) => v > 0)
                    .map(([k, v]) => `${k} ${v}`)
                    .join(' · ')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  if (id === 'competitor') {
    const rows = d as { account: string; current_vendor: string; weaknesses: string }[];
    return (
      <div className="table-wrap">
        <table className="t">
          <thead>
            <tr>
              <th>Account</th>
              <th>Uses now</th>
              <th>That supplier’s weak spots (our notes)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.account}>
                <td>{c.account}</td>
                <td>{c.current_vendor}</td>
                <td>{c.weaknesses || '–'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  if (id === 'classify') {
    const rows = d as Rated[];
    return (
      <>
        <p className="small muted">
          Combined = half the similarity + 3 × need + 2 × timing. Code gives priority A at {info.thresholds.A} or more,
          B at {info.thresholds.B} or more. Only A accounts get a draft.
        </p>
        <div className="table-wrap">
          <table className="t">
            <thead>
              <tr>
                <th>Account</th>
                <th>Similarity (code)</th>
                <th>Need (model)</th>
                <th>Timing (model)</th>
                <th>Combined</th>
                <th>Priority</th>
                <th>The model’s reason</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.account_id}>
                  <td>{c.name}</td>
                  <td>{c.similarity}</td>
                  <td>{c.need}</td>
                  <td>{c.timing}</td>
                  <td>
                    <b>{c.combined}</b>
                  </td>
                  <td>
                    <span className={`dc-pri ${c.priority}`}>{c.priority}</span>
                  </td>
                  <td className="small">{c.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </>
    );
  }
  if (id === 'enrich') {
    const e = d as EnrichDetail;
    return (
      <>
        <p className="small">
          {e.sends_left_today} of {e.daily_cap} sends left today.
        </p>
        <div className="table-wrap">
          <table className="t">
            <thead>
              <tr>
                <th>Account</th>
                <th>Contact chosen</th>
                <th>Why</th>
              </tr>
            </thead>
            <tbody>
              {e.contacts.map((c) => (
                <tr key={c.account}>
                  <td>{c.account}</td>
                  <td>{c.ok ? `${c.contact}, ${c.role}` : <span className="dc-bad">Nobody: no draft</span>}</td>
                  <td className="small">{c.why}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </>
    );
  }
  return <p className="small">{view.summary}</p>;
}

/** Closed-deal agents: mark a deal won, watch each step work, then approve or reject the drafts. */
export default function DealClosePage() {
  const [info, setInfo] = useState<DealsInfo | null>(null);
  const [state, setState] = useState<DealsState | null>(null);
  const [contacts, setContacts] = useState<DealContact[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState('');
  const [steps, setSteps] = useState<Steps>({});
  const [selected, setSelected] = useState<StepId>('trigger');
  const [runId, setRunId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [cost, setCost] = useState(0);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    Promise.all([dealsService.info(), dealsService.state(), dealsService.contacts(), statusService.status()])
      .then(([i, s, c, status]) => {
        setInfo(i);
        setState(s);
        setContacts(c.contacts);
        const offered = status.models || [];
        setModels(offered);
        setModel(offered.includes(i.model) ? i.model : offered[0] || '');
      })
      .catch((err) => setError(errorText(err)));
    return () => abort.current?.abort();
  }, []);

  async function close(dealId: string) {
    if (busy) return;
    setBusy(true);
    setError('');
    setNote('');
    setSteps({});
    setSelected('trigger');
    abort.current = new AbortController();
    try {
      await dealsService.close(
        dealId,
        model || undefined,
        (e: DealEvent) => {
          if (e.type === 'run') setRunId(e.run_id);
          else if (e.type === 'step') {
            setSteps((s) => ({ ...s, [e.step]: { status: e.status, summary: e.summary, detail: e.detail } }));
            if (e.status === 'running') setSelected(e.step);
          } else if (e.type === 'done') {
            const { type: _type, drafts: _drafts, cost_usd, ...rest } = e;
            setState(rest);
            setCost((c) => c + cost_usd);
          } else if (e.type === 'error') {
            setError(e.message);
            setCost((c) => c + (e.cost_usd ?? 0));
          }
        },
        abort.current.signal,
      );
      setState(await dealsService.state());
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function decide(id: number, approve: boolean) {
    setError('');
    setNote('');
    try {
      const { sent: _sent, message, ...rest } = await dealsService.decide(id, approve);
      setState(rest);
      setNote(message);
    } catch (err) {
      setError(errorText(err));
      setState(await dealsService.state().catch(() => state));
    }
  }

  async function reset() {
    abort.current?.abort();
    setError('');
    setNote('');
    try {
      setState(await dealsService.reset());
      setContacts((await dealsService.contacts()).contacts);
      setSteps({});
      setRunId('');
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function consent(c: DealContact) {
    try {
      setContacts((await dealsService.setConsent(c.id, !c.consent)).contacts);
    } catch (err) {
      setError(errorText(err));
    }
  }

  if (!info || !state) {
    return (
      <main className="page-deal-close">
        <div className="kicker">Building · Closed-deal agents</div>
        <h1>When a deal closes, find the next ones like it</h1>
        {error ? <p className="dc-bad small">{error}</p> : <p className="small muted">Loading…</p>}
      </main>
    );
  }

  // The approval node follows the drafts of the run on show: it is done once none is waiting.
  const mine = state.outreach.filter((o) => o.run_id === runId);
  const waiting = mine.filter((o) => o.status === 'draft').length;
  const shown: Steps = {
    ...steps,
    ...(steps.approval && {
      approval: {
        status: waiting ? 'running' : 'done',
        summary: waiting
          ? `${waiting} waiting for you`
          : mine.some((o) => o.status === 'sent' || o.status === 'rejected')
            ? `${mine.filter((o) => o.status === 'sent').length} sent, ${mine.filter((o) => o.status === 'rejected').length} rejected`
            : 'Nothing to approve',
        detail: null,
      },
    }),
  };
  const selectedStep = info.steps.find((s) => s.id === selected) ?? info.steps[0];
  const open = state.deals.filter((d) => d.stage === 'open');
  const closed = state.deals.filter((d) => d.stage !== 'open');

  return (
    <main className="page-deal-close">
      <div className="kicker">Building · Closed-deal agents</div>
      <h1>When a deal closes, find the next ones like it</h1>
      <p className="lede">
        Mark a deal closed-won in this invented CRM and a chain of small steps runs: read why it was won, find accounts
        that look the same, rate them, pick a contact and draft an email to each. Three steps are a model. The rest is
        code: the search, the scores, the thresholds and every rule on what may be sent. Nothing goes out until you
        approve it, and sending is simulated.
      </p>

      <div className="dc-bar">
        <label className="small">
          Model{' '}
          <select value={model} onChange={(e) => setModel(e.target.value)} disabled={busy}>
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
                {m.startsWith('gpt-') ? ' (Azure OpenAI)' : isLocalModel(m) ? ' (local, free)' : ''}
              </option>
            ))}
          </select>
        </label>
        <span className="small">
          Emails sent today: <b>{state.cap.sent_today}</b> of {state.cap.limit}
        </span>
        <span className="small muted">Spent here: {usd(cost)}</span>
        <button className="btn small" onClick={() => void reset()}>
          Reset the data
        </button>
      </div>
      {error && <p className="dc-bad small">{error}</p>}
      {note && <p className="dc-note small">{note}</p>}

      <div className="dc-layout">
        <section className="card" aria-label="Deals">
          <h2 className="dc-h">Open deals</h2>
          {open.length === 0 && <p className="small muted">None left. Reset the data to run them again.</p>}
          {open.map((d) => (
            <div key={d.id} className="dc-deal">
              <b>{d.name}</b>
              <span className="small muted">
                {d.account} · {gbp(d.value_gbp)}
                {d.displaced && ` · against ${d.displaced}`}
              </span>
              <details>
                <summary>Win notes</summary>
                {d.win_notes}
              </details>
              <button className="btn primary small" disabled={busy} onClick={() => void close(d.id)}>
                {busy ? 'Running…' : 'Mark closed-won'}
              </button>
            </div>
          ))}
          {closed.length > 0 && (
            <>
              <h2 className="dc-h">Closed</h2>
              {closed.map((d) => (
                <div key={d.id} className="dc-deal">
                  <b>{d.name}</b>
                  <span className="small muted">
                    {d.account} · {gbp(d.value_gbp)} · won {d.closed_on}
                  </span>
                </div>
              ))}
            </>
          )}
          <p className="small muted">
            {info.company} sells {info.product}. The company, its {state.accounts} accounts and its competitors are
            invented.
          </p>
        </section>

        <div className="dc-right">
          <section className="card" aria-label="The steps">
            <h2 className="dc-h">The chain of steps</h2>
            <ol className="dc-graph">
              {info.steps.map((s) => {
                const view = shown[s.id];
                return (
                  <li key={s.id}>
                    <button
                      className={`dc-node ${view?.status ?? 'idle'}${selected === s.id ? ' selected' : ''}`}
                      onClick={() => setSelected(s.id)}
                      aria-pressed={selected === s.id}
                    >
                      <span className={`dc-who ${s.who}`}>{WHO[s.who]}</span>
                      <span className="dc-node-name">{s.name}</span>
                      <span className="dc-node-sum">
                        {view?.status === 'running' ? 'Working…' : view?.summary || s.does}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
            <div className="dc-detail" aria-live="polite">
              <h3>
                {selectedStep.name} <span className={`dc-who ${selectedStep.who}`}>{WHO[selectedStep.who]}</span>
              </h3>
              <p className="small muted">{selectedStep.does}.</p>
              {selected === 'approval' || selected === 'email' ? (
                <p className="small">{shown[selected]?.summary || 'Not run yet.'} The drafts are below.</p>
              ) : (
                <StepDetail id={selected} view={shown[selected]} info={info} />
              )}
            </div>
          </section>

          <section className="card" aria-label="Drafts and decisions">
            <h2 className="dc-h">Drafts and decisions</h2>
            {state.outreach.length === 0 && (
              <p className="small muted">Drafts appear here when a run finishes. Each one waits for you.</p>
            )}
            {state.outreach.map((o) => (
              <div key={o.id} className={`dc-draft ${o.status}`}>
                <div className="dc-draft-head">
                  <span>
                    <b>{o.account}</b>
                    {o.contact && (
                      <span className="small muted">
                        {' '}
                        · to {o.contact}, {o.role} ({o.email})
                      </span>
                    )}
                  </span>
                  <span className="dc-status">{STATUS_WORDS[o.status]}</span>
                </div>
                {o.subject && (
                  <>
                    <p className="small">
                      <b>Subject:</b> {o.subject}
                    </p>
                    <pre>{o.body}</pre>
                  </>
                )}
                <div className="dc-actions">
                  {o.status === 'draft' && (
                    <>
                      <button className="btn primary small" onClick={() => void decide(o.id, true)}>
                        Approve and send
                      </button>
                      <button className="btn small" onClick={() => void decide(o.id, false)}>
                        Reject
                      </button>
                    </>
                  )}
                  <span className="small muted">{o.reason}</span>
                </div>
              </div>
            ))}
          </section>
        </div>
      </div>

      <h2>The rules code enforces</h2>
      <ul className="dc-rules">
        {info.rules.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
      <details>
        <summary className="small">Try the consent rule: change who has agreed to email</summary>
        <p className="small muted">
          Untick a contact after their draft is written, then approve it: code checks again at that moment and refuses.
        </p>
        <div className="table-wrap">
          <table className="t dc-contacts">
            <thead>
              <tr>
                <th>Account</th>
                <th>Contact</th>
                <th>Role</th>
                <th>Agreed to email</th>
              </tr>
            </thead>
            <tbody>
              {contacts.map((c) => (
                <tr key={c.id}>
                  <td>{c.account}</td>
                  <td>{c.name}</td>
                  <td>{c.role}</td>
                  <td>
                    <label>
                      <input type="checkbox" checked={!!c.consent} onChange={() => void consent(c)} />{' '}
                      {c.unsubscribed ? 'Unsubscribed' : c.consent ? 'Yes' : 'No'}
                    </label>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      <h2>Who does what</h2>
      <div className="table-wrap">
        <table className="t">
          <thead>
            <tr>
              <th>Step</th>
              <th>Done by</th>
              <th>Why</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Read the win notes: why we won, and a proof point with no names</td>
              <td>The model; code checks for the customer’s name, asks once more, then removes it itself</td>
              <td>Reading free text is the model’s job; keeping a customer’s name private cannot be left to it</td>
            </tr>
            <tr>
              <td>Find look-alike accounts and score how similar each is</td>
              <td>Code: a query on the CRM and fixed points for industry, size, region, systems and supplier</td>
              <td>Exact, free, and the same every time; it also leaves out customers and deals in progress</td>
            </tr>
            <tr>
              <td>Attach the notes on each account’s current supplier</td>
              <td>Code: a lookup</td>
              <td>The facts are already in a table</td>
            </tr>
            <tr>
              <td>Rate need and timing from our notes on each account</td>
              <td>The model, as JSON in a fixed schema; code keeps only accounts it found and clamps the ratings</td>
              <td>Judging “a new director and a missed target” takes reading; the model cannot add an account</td>
            </tr>
            <tr>
              <td>Turn the scores into priority A, B or skip</td>
              <td>Code, with fixed thresholds</td>
              <td>Who gets an email is a business rule, so it must be the same for every run</td>
            </tr>
            <tr>
              <td>Pick the contact and count the day’s sends</td>
              <td>Code: the most senior person who has agreed to email and not unsubscribed</td>
              <td>Consent and limits are legal matters, not matters of judgement</td>
            </tr>
            <tr>
              <td>Write each email</td>
              <td>The model; code checks names and length (one retry), and adds the opt-out line</td>
              <td>Writing is the model’s job; the checks decide whether a person even sees the draft</td>
            </tr>
            <tr>
              <td>Send</td>
              <td>You approve or reject; code checks every rule again at that moment</td>
              <td>Consent can be withdrawn and the limit reached between drafting and sending</td>
            </tr>
          </tbody>
        </table>
      </div>
    </main>
  );
}
