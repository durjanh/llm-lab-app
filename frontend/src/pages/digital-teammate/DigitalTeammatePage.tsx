import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { isLocalModel, startingModel } from '@/lib/models';
import { statusService } from '@/services/statusService';
import {
  teammateService,
  type AuditEntry,
  type Coverage,
  type Message,
  type ReplyData,
  type Step,
  type TeammateEvent,
  type TeammateInfo,
  type TeammateState,
  type Thread,
} from '@/services/teammateService';
import './digital-teammate.css';

const usd = (v: number) => `$${v < 0.1 ? v.toFixed(4) : v.toFixed(2)}`;
const gbp = (v: number) => `£${v.toLocaleString('en-GB')}`;
const time = (at: string) => at.slice(11, 16);
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const initials = (name: string) =>
  name
    .split(' ')
    .map((w) => w[0])
    .join('')
    .slice(0, 2);

const POST_URL =
  'https://devblogs.microsoft.com/microsoft365dev/new-capabilities-for-building-digital-teammates-in-microsoft-teams/';

/** Message text with every @mention of a known name picked out, as Teams shows it. */
function Mentions({ text, names }: { text: string; names: string[] }) {
  const pattern = useMemo(
    () => new RegExp(`(@(?:${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')}))`, 'gi'),
    [names],
  );
  return (
    <>
      {text.split(pattern).map((part, i) =>
        i % 2 ? (
          <span key={i} className="dt-at">
            {part}
          </span>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  );
}

/** The agent's plan and steps: what it read and what code checked, without extra messages in the thread. */
function Steps({ steps, open }: { steps: Step[]; open: boolean }) {
  if (!steps.length) return null;
  const done = steps.filter((s) => s.status === 'done').length;
  return (
    <details className="dt-steps" open={open}>
      <summary>
        Plan and steps · {done} of {steps.length} done
      </summary>
      <ol>
        {steps.map((s, i) => (
          <li key={i} className={s.status}>
            <span className="dt-tick" aria-hidden>
              {s.status === 'done' ? '✓' : s.status === 'failed' ? '!' : '…'}
            </span>
            <span>
              {s.label}
              {s.detail && <span className="small muted"> · {s.detail}</span>}
            </span>
          </li>
        ))}
      </ol>
    </details>
  );
}

/** The widget in a reply: move the assumptions and code works out the coverage again. No model call. */
function CapacityWidget({ info, data }: { info: TeammateInfo; data: ReplyData }) {
  const start = Object.fromEntries((data.shortlist ?? []).map((r) => [r.supplier_id, r.batches]));
  const [internal, setInternal] = useState(info.demand.internal_batches);
  const [alloc, setAlloc] = useState<Record<string, number>>(start);
  const [cov, setCov] = useState<Coverage | null>(data.coverage ?? null);
  const [error, setError] = useState('');

  useEffect(() => {
    // Only the answer for the latest sliders is shown: an older request that returns late is ignored.
    let current = true;
    const t = window.setTimeout(() => {
      teammateService
        .coverage(
          Object.entries(alloc).map(([supplier_id, batches]) => ({ supplier_id, batches })),
          internal,
        )
        .then((c) => {
          if (!current) return;
          setCov(c);
          setError('');
        })
        .catch((err) => current && setError(errorText(err)));
    }, 150);
    return () => {
      current = false;
      window.clearTimeout(t);
    };
  }, [alloc, internal]);

  const needed = info.demand.batches_needed;
  const pct = (n: number) => `${Math.min(100, (n / needed) * 100)}%`;
  return (
    <div className="dt-widget">
      <div className="dt-widget-head">
        <b>Capacity widget</b>
        <span className="small muted">The sums are code, the same code the agent used. No model call.</span>
      </div>
      <div className="dt-sliders">
        <label>
          <span>Our own capacity</span>
          <input
            type="range"
            min={0}
            max={needed}
            value={internal}
            onChange={(e) => setInternal(Number(e.target.value))}
          />
          <b>{internal}</b>
        </label>
        {info.suppliers.map((s) => (
          <label key={s.supplier_id}>
            <span>{s.name}</span>
            <input
              type="range"
              min={0}
              max={s.batches_offered}
              value={alloc[s.supplier_id] ?? 0}
              onChange={(e) => setAlloc((a) => ({ ...a, [s.supplier_id]: Number(e.target.value) }))}
            />
            <b>{alloc[s.supplier_id] ?? 0}</b>
          </label>
        ))}
      </div>
      {cov && (
        <>
          <div className="dt-meter" aria-label={`${cov.covered} of ${needed} batches covered`}>
            <span className="own" style={{ width: pct(cov.internal_batches) }} />
            <span className="ext" style={{ width: pct(cov.from_suppliers) }} />
          </div>
          <p className="small">
            <b>
              {cov.covered} of {needed}
            </b>{' '}
            batches covered ·{' '}
            {cov.gap_left ? (
              <span className="dt-bad">{cov.gap_left} still short</span>
            ) : cov.over_by ? (
              <span className="dt-warn">{cov.over_by} more than needed</span>
            ) : (
              <span className="dt-good">no gap</span>
            )}{' '}
            · suppliers cost {gbp(cov.cost_gbp)}
          </p>
          {cov.rows.some((r) => !r.passes_rules || r.single_site) && (
            <ul className="dt-flags small">
              {cov.rows.map((r) =>
                !r.passes_rules ? (
                  <li key={r.supplier_id} className="dt-bad">
                    {r.name} fails the rules: {r.fails.join('; ')}
                  </li>
                ) : r.single_site ? (
                  <li key={r.supplier_id} className="dt-warn">
                    {r.name} has one production site: agree a continuity plan
                  </li>
                ) : null,
              )}
            </ul>
          )}
        </>
      )}
      {(data.checklist ?? []).some((c) => c.owner) && (
        <div className="small">
          <b>Next steps and owners</b>
          <ul className="dt-flags">
            {(data.checklist ?? [])
              .filter((c) => c.owner)
              .map((c, i) => (
                <li key={i}>
                  {c.what} ({c.supplier}): <b>{c.owner}</b>, due {c.due}
                </li>
              ))}
          </ul>
        </div>
      )}
      {error && <p className="dt-bad small">{error}</p>}
    </div>
  );
}

/** What code built around the agent's words: the table, the sums, the checklist and the citations. */
function ReplyParts({ info, data }: { info: TeammateInfo; data: ReplyData }) {
  const [widget, setWidget] = useState(false);
  const rows = data.shortlist ?? [];
  return (
    <>
      {(data.not_checked ?? []).length > 0 && (
        <p className="dt-warn small">
          Not checked, because your admin has not granted it: {data.not_checked!.join(', ')}.
        </p>
      )}
      {rows.length > 0 && (
        <div className="table-wrap">
          <table className="t dt-table">
            <thead>
              <tr>
                <th>Supplier</th>
                <th>Batches</th>
                <th>Per batch</th>
                <th>Lead time</th>
                <th>Cost</th>
                <th>Why</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.supplier_id}>
                  <td>
                    <b>{r.name}</b>
                    {r.single_site && <span className="dt-tag warn">one site</span>}
                  </td>
                  <td>{r.batches}</td>
                  <td>{gbp(r.price_per_batch_gbp)}</td>
                  <td>{r.lead_time_weeks} weeks</td>
                  <td>{gbp(r.cost_gbp)}</td>
                  <td className="small">{r.why}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data.coverage && rows.length > 0 && (
        <p className="small">
          With our own {data.coverage.internal_batches}, this covers{' '}
          <b>
            {data.coverage.covered} of {data.coverage.batches_needed}
          </b>{' '}
          batches
          {data.coverage.gap_left ? `, ${data.coverage.gap_left} short` : ', no gap'}, for {gbp(data.coverage.cost_gbp)}
          . <span className="muted">Worked out by code.</span>
        </p>
      )}
      {(data.checklist ?? []).length > 0 && (
        <ul className="dt-check small">
          {data.checklist!.map((c, i) => (
            <li key={i}>
              <span aria-hidden>☐</span> {c.what} ({c.supplier})
              {c.owner && (
                <>
                  {' '}
                  · <b>{c.owner}</b>, due {c.due}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {(data.citations ?? []).length > 0 && (
        <p className="dt-cites small">
          {data.citations!.map((c, i) => (
            <span key={c.id} title={c.title}>
              [{i + 1}] {c.title}
            </span>
          ))}
        </p>
      )}
      {rows.length > 0 && (
        <button className="chip-btn" onClick={() => setWidget((w) => !w)} aria-expanded={widget}>
          {widget ? 'Close the capacity widget' : 'Open the capacity widget'}
        </button>
      )}
      {widget && <CapacityWidget info={info} data={data} />}
    </>
  );
}

function MessageView({
  m,
  info,
  names,
  onProfile,
}: {
  m: Message;
  info: TeammateInfo;
  names: string[];
  onProfile: () => void;
}) {
  if (m.role === 'system') {
    return (
      <div className="dt-msg system">
        <Mentions text={m.text} names={names} />
        {m.data?.steps && <Steps steps={m.data.steps} open={false} />}
      </div>
    );
  }
  const agent = m.role === 'agent';
  return (
    <div className={`dt-msg ${m.role}`}>
      <span className={`dt-avatar ${agent ? 'agent' : ''}`} aria-hidden>
        {agent ? '⟨/⟩' : initials(m.author)}
      </span>
      <div className="dt-body">
        <div className="dt-who">
          {agent ? (
            <button className="dt-name" onClick={onProfile}>
              {m.author}
            </button>
          ) : (
            <b>{m.author}</b>
          )}
          {agent && <span className="dt-tag">AI agent</span>}
          {m.data?.nudge && <span className="dt-tag warn">Posted on its own</span>}
          <span className="small muted">{time(m.at)}</span>
        </div>
        {m.data?.steps && <Steps steps={m.data.steps} open={false} />}
        <p className="dt-text">
          <Mentions text={m.text} names={names} />
        </p>
        {m.data?.worded_by && <p className="small muted">Who to nudge chosen by code; worded by {m.data.worded_by}.</p>}
        {agent && m.data && !m.data.nudge && <ReplyParts info={info} data={m.data} />}
      </div>
    </div>
  );
}

/** The agent's profile card, as people see it in the directory. */
function Profile({ info, state }: { info: TeammateInfo; state: TeammateState }) {
  const a = info.agent;
  return (
    <div className="dt-profile">
      <div className="dt-profile-top">
        <span className="dt-avatar agent big" aria-hidden>
          ⟨/⟩
          <span className={`dt-presence ${state.settings.enabled ? 'on' : 'off'}`} />
        </span>
        <div>
          <b>{a.name}</b>
          <div className="small muted">⟨/⟩ {a.kind}</div>
          <div className="small">{state.settings.enabled ? 'Available' : 'Turned off by an admin'}</div>
        </div>
      </div>
      <dl>
        <dt>Contact</dt>
        <dd>
          {a.email}
          <br />@{a.handle} · {a.company}
        </dd>
        <dt>Reports to</dt>
        <dd>
          {a.reports_to} <span className="muted">({a.reports_to_role})</span>
        </dd>
        <dt>Owner</dt>
        <dd>{a.owner}</dd>
        <dt>Its own account</dt>
        <dd className="small">{a.id} · actions are logged under this name, not a person’s</dd>
      </dl>
    </div>
  );
}

const AUDIT_FILTERS: Record<string, (a: AuditEntry) => boolean> = {
  Everything: () => true,
  'Tool calls': (a) => a.kind === 'tool',
  'Refused or sent back': (a) => /denied|refused|sent back|failed|skipped/.test(a.outcome),
  'Admin changes': (a) => a.kind === 'admin',
};

export default function DigitalTeammatePage() {
  const [info, setInfo] = useState<TeammateInfo | null>(null);
  const [state, setState] = useState<TeammateState | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState('');
  const [view, setView] = useState<'channel' | 'admin'>('channel');
  const [draft, setDraft] = useState('');
  const [replies, setReplies] = useState<Record<number, string>>({});
  const [working, setWorking] = useState<number | 'new' | null>(null);
  const [live, setLive] = useState<Record<string, Step[]>>({});
  const [profile, setProfile] = useState(false);
  const [auditFilter, setAuditFilter] = useState('Everything');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [cost, setCost] = useState(0);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    Promise.all([teammateService.info(), teammateService.state(), statusService.status()])
      .then(([i, s, status]) => {
        setInfo(i);
        setState(s);
        const offered = status.models || [];
        setModels(offered);
        setModel(startingModel(i.model, offered));
        setDraft(`${i.mention} `);
      })
      .catch((err) => setError(errorText(err)));
    return () => abort.current?.abort();
  }, []);

  const names = useMemo(() => (info ? [info.agent.name, ...info.people.map((p) => p.name)] : []), [info]);

  async function send(threadId: number | null) {
    const text = (threadId === null ? draft : (replies[threadId] ?? '')).trim();
    if (!text || working !== null) return;
    setWorking(threadId ?? 'new');
    setError('');
    setNote('');
    let key = threadId === null ? 'new' : String(threadId);
    setLive((l) => ({ ...l, [key]: [] }));
    abort.current = new AbortController();
    const onEvent = (e: TeammateEvent) => {
      if (e.type === 'thread') {
        if (threadId === null) {
          key = String(e.thread_id);
          setDraft(info ? `${info.mention} ` : '');
        } else setReplies((r) => ({ ...r, [threadId]: '' }));
        setWorking(e.thread_id);
        void teammateService.state().then(setState);
      } else if (e.type === 'step') {
        setLive((l) => {
          const steps = [...(l[key] ?? [])];
          steps[e.index] = { label: e.label, status: e.status, detail: e.detail };
          return { ...l, [key]: steps };
        });
      } else if (e.type === 'done') {
        const { type: _t, cost_usd, note: n, ...rest } = e;
        setState(rest);
        setCost((c) => c + cost_usd);
        if (n) setNote(n);
      } else if (e.type === 'error') {
        setError(e.message);
        setCost((c) => c + (e.cost_usd ?? 0));
        if (e.threads) setState(e as unknown as TeammateState);
      }
    };
    try {
      if (threadId === null) await teammateService.post(text, model || undefined, onEvent, abort.current.signal);
      else await teammateService.reply(threadId, text, model || undefined, onEvent, abort.current.signal);
      setState(await teammateService.state());
    } catch (err) {
      setError(errorText(err));
    } finally {
      setWorking(null);
      setLive({});
    }
  }

  async function admin(change: { enabled?: boolean; scopes?: string[]; proactive?: boolean }) {
    setError('');
    try {
      setState(await teammateService.admin(change));
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function morning() {
    setError('');
    setNote('');
    try {
      const { posted: _p, message, cost_usd, ...rest } = await teammateService.morningCheck(model || undefined);
      setState(rest);
      setNote(message);
      setCost((c) => c + cost_usd);
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function reset() {
    setError('');
    setNote('');
    try {
      setState(await teammateService.reset());
    } catch (err) {
      setError(errorText(err));
    }
  }

  const head = (
    <>
      <div className="kicker">Building · Digital teammate</div>
      <h1>An AI agent with its own seat on the team</h1>
    </>
  );
  if (!info || !state) {
    return (
      <main className="page-digital-teammate">
        {head}
        {error ? <p className="dt-bad small">{error}</p> : <p className="small muted">Loading…</p>}
      </main>
    );
  }

  const threads = state.threads;
  const pendingNew = working === 'new' || (typeof working === 'number' && !threads.some((t) => t.id === working));

  const threadView = (t: Thread) => {
    const steps = live[String(t.id)];
    const answering = working === t.id;
    const [first, ...rest] = t.messages;
    return (
      <article key={t.id} className={`dt-thread ${t.kind}`}>
        {first && <MessageView m={first} info={info} names={names} onProfile={() => setProfile(true)} />}
        {(rest.length > 0 || answering) && (
          <div className="dt-replies">
            {rest.map((m) => (
              <MessageView key={m.id} m={m} info={info} names={names} onProfile={() => setProfile(true)} />
            ))}
            {answering && steps && (
              <div className="dt-msg agent pending">
                <span className="dt-avatar agent" aria-hidden>
                  ⟨/⟩
                </span>
                <div className="dt-body">
                  <div className="dt-who">
                    <b>{info.agent.name}</b>
                    <span className="dt-tag">AI agent</span>
                    <span className="small muted">working…</span>
                  </div>
                  <Steps steps={steps} open />
                </div>
              </div>
            )}
          </div>
        )}
        {(t.kind === 'proactive' || t.messages.some((m) => m.role !== 'person')) && (
          <div className="dt-reply-box">
            <input
              type="text"
              placeholder="Reply in this thread"
              value={replies[t.id] ?? ''}
              maxLength={1000}
              disabled={working !== null}
              onChange={(e) => setReplies((r) => ({ ...r, [t.id]: e.target.value }))}
              onKeyDown={(e) => e.key === 'Enter' && void send(t.id)}
              aria-label="Reply in this thread"
            />
            <button
              className="btn small"
              disabled={working !== null || !(replies[t.id] ?? '').trim()}
              onClick={() => void send(t.id)}
            >
              Reply
            </button>
          </div>
        )}
      </article>
    );
  };

  return (
    <main className="page-digital-teammate">
      {head}
      <p className="lede">
        An AI agent that works as itself: it has its own account and profile, people @mention it in a channel like a
        colleague, it answers in a thread while showing its steps, and everything it does is logged under its own name.
        An admin decides what it may read and can turn it off. This is a simulation of the agents Microsoft described
        for Teams in{' '}
        <a href={POST_URL} target="_blank" rel="noreferrer">
          November 2026
        </a>
        , built without Teams or its SDK. The company, its suppliers and its people are invented.
      </p>

      <div className="dt-bar">
        <div className="dt-tabs" role="tablist">
          {(['channel', 'admin'] as const).map((v) => (
            <button
              key={v}
              role="tab"
              aria-selected={view === v}
              className={view === v ? 'on' : ''}
              onClick={() => setView(v)}
            >
              {v === 'channel' ? 'Channel' : 'Admin centre'}
            </button>
          ))}
        </div>
        <label className="small">
          Model{' '}
          <select value={model} onChange={(e) => setModel(e.target.value)} disabled={working !== null}>
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
                {m.startsWith('gpt-') ? ' (Azure OpenAI)' : isLocalModel(m) ? ' (local, free)' : ''}
              </option>
            ))}
          </select>
        </label>
        <span className="small muted">Spent here: {usd(cost)}</span>
        <button className="btn small" onClick={() => void reset()} disabled={working !== null}>
          Reset the channel
        </button>
      </div>
      {error && <p className="dt-bad small">{error}</p>}
      {note && <p className="dt-good small">{note}</p>}

      {view === 'channel' ? (
        <div className="dt-layout">
          <section className="dt-channel" aria-label="Channel">
            <div className="dt-channel-head">
              <b>Procurement</b> › Capacity planning
              <span className="small muted">
                {' '}
                · {info.people.map((p) => p.name).join(', ')} and {info.agent.name}
              </span>
            </div>
            <div className="dt-compose">
              <textarea
                rows={2}
                value={draft}
                maxLength={1000}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Start a post. @mention the agent to bring it in."
                aria-label="Start a post"
                disabled={working !== null}
              />
              <div className="dt-compose-row">
                <span className="small muted">Posting as {info.you} (you)</span>
                <button
                  className="btn primary small"
                  disabled={working !== null || !draft.trim()}
                  onClick={() => void send(null)}
                >
                  {working !== null ? 'Working…' : 'Post'}
                </button>
              </div>
              <div className="dt-samples">
                {info.samples.map((s) => (
                  <button key={s} className="chip-btn" onClick={() => setDraft(s)} disabled={working !== null}>
                    {s.replace(info.mention, '').trim()}
                  </button>
                ))}
              </div>
            </div>
            {pendingNew && live.new && <p className="small muted">Posting…</p>}
            {threads.length === 0 && !pendingNew && (
              <p className="small muted dt-empty">
                No posts yet. Try the first suggestion: the team is {info.demand.gap} batches short on{' '}
                {info.demand.product} for {info.demand.quarter}.
              </p>
            )}
            {threads.map(threadView)}
          </section>

          <aside className="dt-side">
            <Profile info={info} state={state} />
            <div className="card dt-facts">
              <b className="small">What the team needs</b>
              <p className="small">
                {info.demand.batches_needed} batches of {info.demand.product} for {info.demand.quarter}, within{' '}
                {info.demand.need_by_weeks} weeks. We make {info.demand.internal_batches} ourselves, so{' '}
                <b>{info.demand.gap} short</b>.
              </p>
              <b className="small">Suppliers who offered capacity</b>
              <ul className="small">
                {info.suppliers.map((s) => (
                  <li key={s.supplier_id}>
                    {s.name}: {s.batches_offered} batches at {gbp(s.price_per_batch_gbp)}, {s.lead_time_weeks} weeks
                  </li>
                ))}
              </ul>
              <p className="small muted">The quality records and contracts are only what the agent can read.</p>
            </div>
          </aside>
        </div>
      ) : (
        <div className="dt-admin">
          <section className="card">
            <h2 className="dt-h">The agent</h2>
            <Profile info={info} state={state} />
            <label className="dt-switch">
              <input
                type="checkbox"
                checked={state.settings.enabled}
                onChange={(e) => void admin({ enabled: e.target.checked })}
              />{' '}
              Turned on. Off, it answers nothing, and an answer in progress stops at its next tool call.
            </label>
          </section>
          <section className="card">
            <h2 className="dt-h">What it may read</h2>
            <p className="small muted">
              Checked at every tool call, so a change applies even part-way through an answer.
            </p>
            {Object.entries(info.scopes).map(([key, label]) => (
              <label key={key} className="dt-switch">
                <input
                  type="checkbox"
                  checked={state.settings.scopes.includes(key)}
                  onChange={(e) =>
                    void admin({
                      scopes: e.target.checked
                        ? [...state.settings.scopes, key]
                        : state.settings.scopes.filter((s) => s !== key),
                    })
                  }
                />{' '}
                {label}
              </label>
            ))}
            <h2 className="dt-h">Posts of its own</h2>
            <label className="dt-switch">
              <input
                type="checkbox"
                checked={state.settings.proactive}
                onChange={(e) => void admin({ proactive: e.target.checked })}
              />{' '}
              Allowed: it may follow up on open requirements, at most {state.proactive.limit} times a day (
              {state.proactive.today} today).
            </label>
            <button className="btn small" onClick={() => void morning()} disabled={working !== null}>
              Run its morning check now
            </button>
            <p className="small muted">
              Normally on a schedule. Code finds open requirements due within a week on the latest shortlist and who
              owns them; the model only words the message.
            </p>
          </section>
          <section className="card dt-log">
            <div className="dt-log-head">
              <h2 className="dt-h">Activity, down to each tool call</h2>
              <select value={auditFilter} onChange={(e) => setAuditFilter(e.target.value)} aria-label="Show">
                {Object.keys(AUDIT_FILTERS).map((f) => (
                  <option key={f}>{f}</option>
                ))}
              </select>
            </div>
            {state.audit.length === 0 ? (
              <p className="small muted">Nothing yet. @mention the agent in the channel, then come back.</p>
            ) : (
              <div className="table-wrap">
                <table className="t">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Who</th>
                      <th>Thread</th>
                      <th>What</th>
                      <th>Detail</th>
                      <th>Outcome</th>
                    </tr>
                  </thead>
                  <tbody>
                    {state.audit.filter(AUDIT_FILTERS[auditFilter]).map((a) => (
                      <tr key={a.id} className={/denied|refused|sent back|failed/.test(a.outcome) ? 'dt-row-bad' : ''}>
                        <td>{time(a.at)}</td>
                        <td>{a.actor}</td>
                        <td>{a.thread_id ?? ''}</td>
                        <td>
                          <code>{a.name}</code>
                        </td>
                        <td className="small dt-detail">{a.detail}</td>
                        <td className="small">{a.outcome}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}

      {profile && (
        <div
          className="dt-pop"
          role="dialog"
          aria-label={`${info.agent.name} profile`}
          onClick={() => setProfile(false)}
        >
          <div onClick={(e) => e.stopPropagation()}>
            <Profile info={info} state={state} />
            <button className="btn small" onClick={() => setProfile(false)}>
              Close
            </button>
          </div>
        </div>
      )}

      <h2>How this maps to Teams</h2>
      <div className="table-wrap">
        <table className="t">
          <thead>
            <tr>
              <th>In Teams (Nov 2026)</th>
              <th>What it does</th>
              <th>Here</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Agentic users (preview)</td>
              <td>
                The agent gets its own Microsoft Entra account: found by name, @mentioned, its owner on its profile
              </td>
              <td>The profile card and the activity log under the agent’s name; there is no real account</td>
            </tr>
            <tr>
              <td>Microsoft Agent 365</td>
              <td>Admins approve the agent, set what it can reach, review it down to each tool call, and disable it</td>
              <td>The admin centre: on and off, the record types, and the log</td>
            </tr>
            <tr>
              <td>Threaded replies (preview)</td>
              <td>Each task gets a thread; the thread is the boundary of what the agent remembers</td>
              <td>Each post is a thread, and a follow-up carries that thread only</td>
            </tr>
            <tr>
              <td>Agent plans and steps (preview)</td>
              <td>Progress on a long task, kept for review beside the answer</td>
              <td>Plan and steps, live while it works, then folded into the reply</td>
            </tr>
            <tr>
              <td>Streaming and Extended Markdown</td>
              <td>Answers appear as they are written, with tables, checklists and citations</td>
              <td>Steps stream; the table, checklist and citations are built by code from checked data</td>
            </tr>
            <tr>
              <td>HTML widgets (preview)</td>
              <td>An interactive view in a reply, tied to business logic and MCP tools</td>
              <td>The capacity widget, which calls the same code as the agent’s check_coverage tool</td>
            </tr>
            <tr>
              <td>Posts of its own</td>
              <td>Within limits the organisation sets, it follows up and nudges stalled work</td>
              <td>The morning check, at most {info.proactive_daily_limit} a day, only when the admin allows it</td>
            </tr>
            <tr>
              <td>Socket mode (preview)</td>
              <td>Run and test an agent in Teams locally, with no public endpoint</td>
              <td>Not needed: everything here runs in the lab</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2>Who does what</h2>
      <div className="table-wrap">
        <table className="t">
          <thead>
            <tr>
              <th>Part</th>
              <th>Done by</th>
              <th>Why</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Decide which records to read, and write the recommendation</td>
              <td>The model, through {info.tools.length} tools</td>
              <td>Weighing a single site against a lower price takes judgement</td>
            </tr>
            <tr>
              <td>Whether it may read a record at all</td>
              <td>Code, at every tool call, from the admin’s settings</td>
              <td>Access is the organisation’s decision, not the agent’s</td>
            </tr>
            <tr>
              <td>The supplier rules: certificate, defects, on time, lead time</td>
              <td>Code</td>
              <td>A rule must give the same answer every time</td>
            </tr>
            <tr>
              <td>Coverage, gap and cost</td>
              <td>Code, through check_coverage and the widget</td>
              <td>Sums are not a job for a language model</td>
            </tr>
            <tr>
              <td>Whether a reply may be posted</td>
              <td>Code: every number and citation must come from what it read; the shortlist must pass the rules</td>
              <td>A reply that breaks a rule goes back to the model, at most twice, and is never posted</td>
            </tr>
            <tr>
              <td>Who to nudge, and how often</td>
              <td>Code picks the owners and keeps the daily limit; the model words the message</td>
              <td>An agent that posts on its own needs limits a person set</td>
            </tr>
            <tr>
              <td>Whether to commit</td>
              <td>The team</td>
              <td>The agent recommends; nothing is ordered</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2>The rules code enforces</h2>
      <ul className="dt-rules">
        {info.rules.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
    </main>
  );
}
