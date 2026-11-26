import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { CodeBlock } from '@/components/CodeBlock';
import { highlight } from '@/components/highlight';
import {
  controlLayerService as svc,
  type ConsumerRow,
  type DayRow,
  type Overview,
  type VirtualKey,
} from '@/services/controlLayerService';
import {
  autoRoutingSummary,
  burn,
  chartConsumers,
  connectSnippets,
  formToPolicy,
  overProjected,
  policySummary,
  policyToForm,
  usd,
  type PolicyForm,
} from './logic';
import './control-layer.css';

const REFRESH_MS = 8000;
const SERIES = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--brand)'];
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const when = (t: number | null) =>
  t === null ? 'never' : new Date(t * 1000).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
const AREA_NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/** Spending per day as stacked bars, one colour per consumer, the rest grouped as "other". */
function SpendChart({ days, labels }: { days: DayRow[]; labels: Record<string, string> }) {
  const top = chartConsumers(days, 5);
  const most = Math.max(...days.map((d) => d.total_usd), 0);
  const W = 720;
  const H = 200;
  const L = 52;
  const B = 24;
  const bw = (W - L - 8) / Math.max(1, days.length);
  const y = (v: number) => (most ? ((H - B - 8) * v) / most : 0);
  return (
    <figure className="card cl-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Spending per day over the last 30 days, by consumer">
        <line className="cl-axis" x1={L} y1={H - B} x2={W - 4} y2={H - B} />
        {[0, 0.5, 1].map((f) => (
          <text key={f} x={L - 6} y={H - B - (H - B - 8) * f + 4} className="cl-tick" textAnchor="end">
            {usd(most * f)}
          </text>
        ))}
        {days.map((d, i) => {
          let base = H - B;
          const parts = [
            ...top.map((c, j) => ({ c, v: d.by_consumer[c] ?? 0, fill: SERIES[j % SERIES.length] })),
            {
              c: 'other',
              v: Object.entries(d.by_consumer).reduce((s, [c, v]) => (top.includes(c) ? s : s + v), 0),
              fill: 'var(--line2)',
            },
          ];
          return (
            <g key={d.day}>
              <title>
                {d.day}: {usd(d.total_usd)}
              </title>
              {parts.map((p) => {
                const h = y(p.v);
                base -= h;
                return h > 0 ? (
                  <rect
                    key={p.c}
                    x={L + i * bw + 1}
                    y={base}
                    width={Math.max(1, bw - 2)}
                    height={h}
                    style={{ fill: p.fill }}
                  />
                ) : null;
              })}
              {i % 7 === days.length % 7 && (
                <text x={L + i * bw + bw / 2} y={H - 6} className="cl-tick" textAnchor="middle">
                  {d.day.slice(5)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <figcaption className="cl-legend small">
        {top.length === 0 && <span className="muted">Nothing spent through the control layer yet.</span>}
        {top.map((c, j) => (
          <span key={c}>
            <i style={{ background: SERIES[j % SERIES.length] }} />
            {labels[c] ?? c}
          </span>
        ))}
      </figcaption>
    </figure>
  );
}

function PolicyEditor({
  consumer,
  label,
  initial,
  models,
  efforts,
  onSaved,
  onCancel,
}: {
  consumer: string;
  label: string;
  initial: ConsumerRow['policy'];
  models: string[];
  efforts: string[];
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [f, setF] = useState<PolicyForm>(() => policyToForm(initial, models));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<PolicyForm>) => setF((x) => ({ ...x, ...patch }));
  const options = f.restrictModels ? f.allowed : models;

  async function save() {
    const out = formToPolicy(f);
    if ('error' in out) return setError(out.error);
    setBusy(true);
    try {
      await svc.setPolicy(consumer, out.policy);
      onSaved();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await svc.removePolicy(consumer);
      onSaved();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card cl-editor" role="region" aria-label={`Policy for ${label}`}>
      <h3>
        Policy for <code>{label}</code>
      </h3>
      <div className="cl-form">
        <fieldset>
          <legend>Models</legend>
          <label className="cl-check">
            <input
              type="checkbox"
              checked={f.restrictModels}
              onChange={(e) => set({ restrictModels: e.target.checked })}
            />
            Only these models
          </label>
          {f.restrictModels && (
            <div className="cl-models">
              {models.map((m) => (
                <label key={m} className="cl-check">
                  <input
                    type="checkbox"
                    checked={f.allowed.includes(m)}
                    onChange={(e) =>
                      set({ allowed: e.target.checked ? [...f.allowed, m] : f.allowed.filter((x) => x !== m) })
                    }
                  />
                  {m}
                </label>
              ))}
            </div>
          )}
          <label>
            Highest effort
            <select value={f.maxEffort} onChange={(e) => set({ maxEffort: e.target.value as PolicyForm['maxEffort'] })}>
              <option value="">Any</option>
              {efforts.map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </select>
          </label>
        </fieldset>
        <fieldset>
          <legend>Budgets and rate</legend>
          <label>
            Daily budget ($)
            <input
              inputMode="decimal"
              value={f.daily}
              placeholder="none"
              onChange={(e) => set({ daily: e.target.value })}
            />
          </label>
          <label>
            Monthly budget ($)
            <input
              inputMode="decimal"
              value={f.monthly}
              placeholder="none"
              onChange={(e) => set({ monthly: e.target.value })}
            />
          </label>
          <label>
            Requests per minute
            <input
              inputMode="numeric"
              value={f.rpm}
              placeholder="none"
              onChange={(e) => set({ rpm: e.target.value })}
            />
          </label>
        </fieldset>
        <fieldset>
          <legend>Routing</legend>
          {(['none', 'send', 'downgrade'] as const).map((r) => (
            <label key={r} className="cl-check">
              <input
                type="radio"
                name={`route-${consumer}`}
                checked={f.route === r}
                onChange={() => set({ route: r })}
              />
              {r === 'none'
                ? 'Use the model each call asks for'
                : r === 'send'
                  ? 'Send every call to'
                  : 'Move to a cheaper model'}
            </label>
          ))}
          {f.route === 'send' && (
            <select
              value={f.routeTo}
              onChange={(e) => set({ routeTo: e.target.value })}
              aria-label="Send every call to"
            >
              {options.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          )}
          {f.route === 'downgrade' && (
            <div className="cl-inline">
              <label>
                after
                <input
                  inputMode="numeric"
                  value={f.downgradeAt}
                  onChange={(e) => set({ downgradeAt: e.target.value })}
                />
                % of the budget, to
              </label>
              <select
                value={f.downgradeTo}
                onChange={(e) => set({ downgradeTo: e.target.value })}
                aria-label="Cheaper model"
              >
                {options.map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
            </div>
          )}
        </fieldset>
        <fieldset>
          <legend>Guardrails</legend>
          <label className="cl-check">
            <input
              type="checkbox"
              checked={f.refuseSecrets}
              onChange={(e) => set({ refuseSecrets: e.target.checked })}
            />
            Refuse requests that contain an API key or a private key
          </label>
          <label className="cl-check">
            <input type="checkbox" checked={f.maskPii} onChange={(e) => set({ maskPii: e.target.checked })} />
            Mask email addresses and phone numbers before sending
          </label>
          <label>
            Note
            <input
              value={f.note}
              maxLength={200}
              onChange={(e) => set({ note: e.target.value })}
              placeholder="optional"
            />
          </label>
        </fieldset>
      </div>
      {error && (
        <p className="cl-error" role="alert">
          {error}
        </p>
      )}
      <div className="row cl-actions">
        <button type="button" className="btn primary" onClick={() => void save()} disabled={busy}>
          Save policy
        </button>
        {initial && (
          <button type="button" className="btn" onClick={() => void remove()} disabled={busy}>
            Remove policy
          </button>
        )}
        <button type="button" className="btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function Keys({
  keys,
  onChange,
  onPolicy,
}: {
  keys: VirtualKey[];
  onChange: () => void;
  onPolicy: (id: string) => void;
}) {
  const [name, setName] = useState('');
  const [made, setMade] = useState<{ key: string; name: string } | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [error, setError] = useState('');
  const origin =
    typeof window === 'undefined' ? 'http://127.0.0.1:8000' : window.location.origin.replace(':5173', ':8000');
  const snippets = connectSnippets(origin, made?.key ?? '<your virtual key>');

  async function create() {
    setError('');
    try {
      const k = await svc.createKey(name.trim());
      setMade({ key: k.key, name: k.name });
      setName('');
      onChange();
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <>
      <div className="row cl-actions">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Who or what will use it, such as “Laptop coding agent”"
          aria-label="Name for a new key"
          maxLength={60}
        />
        <button type="button" className="btn primary" disabled={!name.trim()} onClick={() => void create()}>
          Make a key
        </button>
      </div>
      {error && <p className="cl-error">{error}</p>}
      {made && (
        <div className="note cl-made" role="status">
          <p>
            <b>Copy this key now.</b> It is shown once; the lab keeps only a fingerprint of it.
          </p>
          <code className="cl-key">{made.key}</code>
          <button type="button" className="btn small" onClick={() => void navigator.clipboard?.writeText(made.key)}>
            Copy
          </button>
          <button type="button" className="btn small" onClick={() => setMade(null)}>
            Done
          </button>
        </div>
      )}
      {keys.length > 0 && (
        <div className="table-wrap">
          <table className="t">
            <thead>
              <tr>
                <th>Name</th>
                <th>Key</th>
                <th>Made</th>
                <th>Last used</th>
                <th>State</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id} className={k.revoked_at ? 'cl-revoked' : undefined}>
                  <td>{k.name}</td>
                  <td>
                    <code>{k.prefix}…</code>
                  </td>
                  <td>{when(k.created_at)}</td>
                  <td>{when(k.last_used_at)}</td>
                  <td>{k.revoked_at ? `Revoked ${when(k.revoked_at)}` : 'Active'}</td>
                  <td className="cl-row-actions">
                    {!k.revoked_at && (
                      <>
                        <button type="button" className="btn small" onClick={() => onPolicy(k.id)}>
                          Policy
                        </button>
                        {confirm === k.id ? (
                          <button
                            type="button"
                            className="btn small cl-danger"
                            onClick={() =>
                              void svc
                                .revokeKey(k.id)
                                .then(onChange)
                                .catch((e) => setError(errorText(e)))
                                .finally(() => setConfirm(null))
                            }
                          >
                            Revoke now
                          </button>
                        ) : (
                          <button type="button" className="btn small" onClick={() => setConfirm(k.id)}>
                            Revoke
                          </button>
                        )}
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <h3>Point a coding agent at this lab</h3>
      <p className="small">
        Tools that speak the Messages API (Claude Code, the Anthropic SDKs and others) can send their calls here
        instead. Each call then follows the key&apos;s policy, fails over like the lab&apos;s own calls, and is counted
        under the key. The proxy answers only on this machine.
      </p>
      <CodeBlock html={highlight(snippets.env, 'shell')} />
      <CodeBlock html={highlight(snippets.curl, 'shell')} />
    </>
  );
}

/**
 * Usage, cost and access for every model call the lab makes: spending by part of the lab, by model and by day;
 * policies that limit models, effort, budgets and rate, route to cheaper models and refuse secrets; virtual keys
 * for outside coding agents; and the audit log of every change.
 */
export default function ControlLayerPage() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [newArea, setNewArea] = useState('');

  const load = useCallback(async () => {
    try {
      setData(await svc.overview());
      setError('');
    } catch (err) {
      setError(errorText(err));
    }
  }, []);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => {
      if (!document.hidden) void load();
    }, REFRESH_MS);
    return () => window.clearInterval(id);
  }, [load]);

  const labels = useMemo(() => Object.fromEntries((data?.consumers ?? []).map((c) => [c.id, c.label])), [data]);
  const models = data?.models.map((m) => m.id) ?? [];
  const row = data?.consumers.find((c) => c.id === editing);
  const t = data?.totals;

  return (
    <main className="page-control-layer">
      <p className="kicker">Cost and operations</p>
      <h1>Usage, cost and access</h1>
      <p className="lede">
        Every model call in the lab passes one checkpoint before it leaves this machine. With no policy it is only
        counted. Give a part of the lab, or a key for an outside coding agent, a policy, and its calls are held to it:
        which models, how much effort, how much money a day or a month, how many requests a minute, which cheaper model
        to use, and which requests to refuse.
      </p>
      {error && (
        <p className="cl-error" role="alert">
          {error}
        </p>
      )}

      {t && (
        <div className="stats cl-stats">
          <div className="stat">
            <b>{usd(t.today_usd)}</b>
            <span className="small muted">spent today</span>
          </div>
          <div className="stat">
            <b>{usd(t.month_usd)}</b>
            <span className="small muted">this month</span>
          </div>
          <div className="stat">
            <b>{usd(t.saved_month_usd)}</b>
            <span className="small muted">saved by routing this month</span>
          </div>
          <div className="stat">
            <b>{t.blocked}</b>
            <span className="small muted">calls refused recently</span>
          </div>
          <div className="stat">
            <b>
              {t.policies} · {t.active_keys}
            </b>
            <span className="small muted">policies · active keys</span>
          </div>
          <div className="stat">
            <b>
              {usd(t.session_spent_usd)} / {usd(t.session_budget_usd)}
            </b>
            <span className="small muted">this server run, against --budget</span>
          </div>
        </div>
      )}

      <h2>Spending by day</h2>
      {data && <SpendChart days={data.by_day} labels={labels} />}

      <h2>Consumers</h2>
      <p className="small">
        A consumer is a part of the lab (the area of the page that made the call) or a virtual key. The projection
        carries this month&apos;s daily rate to the month&apos;s end.
      </p>
      {data && (
        <div className="table-wrap">
          <table className="t cl-consumers">
            <thead>
              <tr>
                <th>Consumer</th>
                <th>Today</th>
                <th>This month</th>
                <th>Projected</th>
                <th>Budget used</th>
                <th>Saved</th>
                <th>Policy</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.consumers.map((c) => {
                const b = burn(c);
                return (
                  <tr key={c.id}>
                    <td>
                      {c.label}
                      {c.kind === 'key' && <span className="cl-tag">key</span>}
                    </td>
                    <td>{usd(c.today_usd)}</td>
                    <td>{usd(c.month_usd)}</td>
                    <td className={overProjected(c) ? 'cl-bad' : undefined}>{usd(c.projected_month_usd)}</td>
                    <td>
                      {b ? (
                        <span className="cl-burn" title={b.label}>
                          <span
                            className={b.share >= 1 ? 'full' : b.share >= 0.8 ? 'high' : ''}
                            style={{ width: `${Math.min(100, b.share * 100)}%` }}
                          />
                        </span>
                      ) : (
                        <span className="muted">–</span>
                      )}
                    </td>
                    <td>{c.saved_month_usd ? usd(c.saved_month_usd) : '–'}</td>
                    <td className="small">{policySummary(c.policy).join(' · ')}</td>
                    <td>
                      <button type="button" className="btn small" onClick={() => setEditing(c.id)}>
                        {c.policy ? 'Edit' : 'Add policy'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="row cl-actions">
        <input
          value={newArea}
          onChange={(e) => setNewArea(e.target.value.toLowerCase())}
          placeholder="Another area, such as assistant or coding"
          aria-label="Area name for a new policy"
          maxLength={40}
        />
        <button
          type="button"
          className="btn"
          disabled={!AREA_NAME.test(newArea)}
          onClick={() => {
            setEditing(newArea);
            setNewArea('');
          }}
        >
          Add a policy for it
        </button>
      </div>
      {editing && data && (
        <PolicyEditor
          key={editing}
          consumer={editing}
          label={row?.label ?? editing}
          initial={row?.policy ?? null}
          models={models}
          efforts={data.efforts}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
          onCancel={() => setEditing(null)}
        />
      )}

      <h2>By model</h2>
      {data && (
        <div className="table-wrap">
          <table className="t">
            <thead>
              <tr>
                <th>Model</th>
                <th>Calls</th>
                <th>Refused or failed</th>
                <th>Spend</th>
              </tr>
            </thead>
            <tbody>
              {data.by_model.map((m) => (
                <tr key={m.model}>
                  <td>{m.model}</td>
                  <td>{m.calls.toLocaleString('en-GB')}</td>
                  <td>{m.errors}</td>
                  <td>{usd(m.cost_usd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="small muted">
            From the last {data.call_log_size.toLocaleString('en-GB')} calls in the{' '}
            <Link to="/observability">call log</Link>.
          </p>
        </div>
      )}

      <h2>Auto routing</h2>
      {data && !data.auto_routing && <p className="muted">This backend does not route automatically.</p>}
      {data?.auto_routing && data.auto_routing.turns === 0 && (
        <p className="muted">
          No routed turns yet. Turn on Auto in the <Link to="/assistant">assistant</Link>&apos;s model menu.
        </p>
      )}
      {data?.auto_routing && data.auto_routing.turns > 0 && (
        <div className="card cl-routing">
          <p>
            <b>{data.auto_routing.turns.toLocaleString('en-GB')}</b> assistant turns routed by Auto:{' '}
            {autoRoutingSummary(data.auto_routing).tiers}.
          </p>
          <p>
            Against always using {data.auto_routing.baseline_model} for the same tokens:{' '}
            <b>{autoRoutingSummary(data.auto_routing).saving}</b>.
          </p>
          <p className="small muted">
            {autoRoutingSummary(data.auto_routing).notes}. The comparison prices each turn&apos;s tokens at the
            baseline&apos;s list prices; a stronger model might have used fewer of them.
          </p>
        </div>
      )}

      <h2>Refused calls</h2>
      {data && data.blocked.length === 0 && <p className="muted">None since the server started.</p>}
      {data && data.blocked.length > 0 && (
        <ul className="cl-list">
          {data.blocked.map((b, i) => (
            <li key={`${b.at}-${i}`}>
              <span className="cl-when">{when(b.at)}</span> <b>{labels[b.consumer] ?? b.consumer}</b>{' '}
              <span className="cl-tag">{b.status}</span> {b.model}: {b.reason}
            </li>
          ))}
        </ul>
      )}

      <h2>Virtual keys</h2>
      {data && <Keys keys={data.keys} onChange={() => void load()} onPolicy={(id) => setEditing(`key:${id}`)} />}

      <h2>Audit log</h2>
      {data && data.audit.length === 0 && <p className="muted">No changes yet.</p>}
      {data && data.audit.length > 0 && (
        <ul className="cl-list">
          {data.audit.map((a, i) => (
            <li key={`${a.at}-${i}`}>
              <span className="cl-when">{when(a.at)}</span> {a.who}: <b>{a.action}</b>{' '}
              <code>{labels[a.subject] ?? a.subject}</code>
            </li>
          ))}
        </ul>
      )}

      <h2>How it works</h2>
      <ul>
        <li>
          The check sits under the lab&apos;s model gateway, so it sees every call: the pages, and the coding agent,
          harness, skills and decks that drive the model client directly. A refused call is final; it is not passed to
          the next model in the <Link to="/model-failover">failover</Link> list.
        </li>
        <li>
          Before a call, its cost is estimated from the prompt&apos;s length and its token limit and held against the
          budget; after it, the hold is replaced by the real cost. Two calls at once cannot both take the last of a
          budget.
        </li>
        <li>
          Routing applies to the model each call is finally sent to; the saving is the cost at the model the code asked
          for less the cost at the one used. For when a cheaper model is good enough, see{' '}
          <Link to="/routing">Routing</Link>.
        </li>
        <li>
          Not covered: Azure services billed by something other than tokens (speech, translation) and image generation,
          which have their own clients. The local model costs nothing and is counted at $0.
        </li>
        <li>
          Policies, keys (as fingerprints only), the spending ledger and this audit log are kept in{' '}
          <code>generated/control-layer/</code>, which git ignores.
        </li>
      </ul>
    </main>
  );
}
