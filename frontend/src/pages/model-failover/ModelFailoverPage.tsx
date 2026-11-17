import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import {
  modelFailoverService as svc,
  type CatalogEntry,
  type CatalogView,
  type ConversationSummary,
  type ConversationView,
  type FailoverEvent,
  type FailoverInfo,
  type FailoverStep,
  type FaultKind,
  type Memory,
  type Pool,
  type RouterStatus,
  type LabFailover,
} from '@/services/modelFailoverService';
import './model-failover.css';

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const short = (v: unknown, n = 220) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > n ? `${s.slice(0, n)}…` : s;
};
const FAULT_BUTTONS: { label: string; kind: FaultKind; count: number }[] = [
  { label: 'next call 429', kind: '429', count: 1 },
  { label: 'next 3 calls 429', kind: '429', count: 3 },
  { label: 'next call 529', kind: '529', count: 1 },
  { label: 'next call timeout', kind: 'timeout', count: 1 },
  { label: '429, retry-after 1 s', kind: '429_short', count: 1 },
];

// A badge colour from the name, so no model name is written here and a newly added model still gets one.
function Badge({ model }: { model: string }) {
  let h = 0;
  for (const ch of model) h = (h * 31 + ch.charCodeAt(0)) % 3;
  return <span className={`mf-badge mf-c${h}`}>{model}</span>;
}

function sourceLine(src: CatalogView['source']) {
  if (src.kind === 'file') return `the file ${src.where} (checked every ${src.check_every_s ?? 1} s)`;
  if (src.kind === 'table') return `Azure Table Storage ${src.where}, table ${src.table} (cached ${src.ttl_s} s)`;
  return src.where;
}

function ModelsPanel({
  view,
  draft,
  compact,
  dirty,
  busy,
  message,
  onChange,
  onCompact,
  onSave,
  onReload,
  onDiscard,
}: {
  view: CatalogView | null;
  draft: CatalogEntry[];
  compact: string;
  dirty: boolean;
  busy: boolean;
  message: string;
  onChange: (entries: CatalogEntry[]) => void;
  onCompact: (v: string) => void;
  onSave: () => void;
  onReload: () => void;
  onDiscard: () => void;
}) {
  if (!view) return <p className="small muted">Loading the model list…</p>;
  const unavailable = new Map(view.resolved.filter((r) => !r.available).map((r) => [r.name || r.model, r.reason]));
  const set = (i: number, patch: Partial<CatalogEntry>) =>
    onChange(draft.map((e, j) => (j === i ? { ...e, ...patch } : e)));
  const move = (i: number, by: number) => {
    const next = [...draft];
    const j = i + by;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  const options = (current: string) =>
    view.known_models.includes(current) ? view.known_models : [current, ...view.known_models];
  const choices = [...new Set([...draft.map((e) => e.name || e.model), ...view.known_models])];
  return (
    <div>
      <p className="small">
        Read from <b>{sourceLine(view.source)}</b>. Version <span className="mono">{view.version || 'none'}</span>
        {view.updated_at ? `, changed ${new Date(view.updated_at).toLocaleString()}` : ''}. The order is the fallback
        order. A change takes effect on the next model call: no restart, no redeploy.
      </p>
      {view.error && (
        <p className="mf-bad small">The last edit was not used and the earlier list is still in force: {view.error}</p>
      )}
      <table className="t small mf-models">
        <thead>
          <tr>
            <th>Order</th>
            <th>On</th>
            <th>Model</th>
            <th>Provider</th>
            <th>Window</th>
            <th>Note</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {draft.map((e, i) => (
            <tr key={`${i}-${e.name || e.model}`}>
              <td className="mf-order">
                <button className="btn small" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">
                  ↑
                </button>
                <button
                  className="btn small"
                  disabled={i === draft.length - 1}
                  onClick={() => move(i, 1)}
                  aria-label="Move down"
                >
                  ↓
                </button>
              </td>
              <td>
                <input
                  type="checkbox"
                  checked={e.enabled}
                  aria-label={`Use ${e.model}`}
                  onChange={(ev) => set(i, { enabled: ev.target.checked })}
                />
              </td>
              <td>
                <select
                  value={e.model}
                  aria-label={`Model ${i + 1}`}
                  onChange={(ev) => {
                    const model = ev.target.value;
                    const auto = !e.name || e.name === e.model;
                    set(i, { model, name: auto ? (model === view.placeholder ? '' : model) : e.name });
                  }}
                >
                  {options(e.model).map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                <select value={e.provider} onChange={(ev) => set(i, { provider: ev.target.value })}>
                  {view.providers.map((p) => (
                    <option key={p}>{p}</option>
                  ))}
                </select>
              </td>
              <td>
                <input
                  type="number"
                  min={view.min_window}
                  step={1000}
                  value={e.context_window}
                  aria-label={`Context window ${i + 1}`}
                  onChange={(ev) => set(i, { context_window: Number(ev.target.value) })}
                />
              </td>
              <td>
                <input value={e.note} maxLength={120} onChange={(ev) => set(i, { note: ev.target.value })} />
              </td>
              <td className="small muted">
                {!e.enabled
                  ? 'off'
                  : unavailable.has(e.name || e.model)
                    ? `unavailable: ${unavailable.get(e.name || e.model)}`
                    : 'in use'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mf-row">
        <label className="small">
          Compaction model{' '}
          <select value={compact} onChange={(ev) => onCompact(ev.target.value)}>
            {(choices.includes(compact) ? choices : [compact, ...choices]).map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
        </label>
        <button className="btn" disabled={busy || !dirty} onClick={onSave}>
          Save the model list
        </button>
        <button className="btn small" disabled={busy || !dirty} onClick={onDiscard}>
          Discard changes
        </button>
        <button className="btn small" disabled={busy} onClick={onReload}>
          Reload from source
        </button>
        {message && <span className="small muted">{message}</span>}
      </div>
    </div>
  );
}

function StepView({ step }: { step: FailoverStep }) {
  if (step.kind === 'summary')
    return (
      <li className="mf-compaction">
        <b>History compacted.</b> Steps {step.covers_from} to {step.covers_until} are now sent as this summary, written
        by <Badge model={step.model} />. The originals stay in storage.
        <div className="mf-text small">{String(step.content[0]?.text ?? '')}</div>
      </li>
    );
  const switched =
    step.kind === 'model' && step.fallback_from ? (
      <li className="mf-switch">
        {step.reason} on {step.fallback_from} → switched to {step.model}
      </li>
    ) : null;
  let body: React.ReactNode;
  if (step.kind === 'user')
    body = (
      <li className="mf-user">
        <span className="mf-who">You</span>
        {String(step.content[0]?.text ?? '')}
      </li>
    );
  else if (step.kind === 'tool')
    body = (
      <li className="mf-tool">
        <span className="mf-who">Tool</span>
        <span className="mono small">{step.tool}</span>{' '}
        <span className="mono small muted">{short(step.content[0]?.content)}</span>
      </li>
    );
  else
    body = (
      <li className="mf-model">
        <span className="mf-who">
          <Badge model={step.model} />
        </span>
        {step.content.map((b, i) =>
          b.type === 'text' ? (
            <div key={i} className="mf-text">
              {String(b.text)}
            </div>
          ) : b.type === 'tool_use' ? (
            <div key={i} className="mono small">
              {String(b.name)}({short(b.input, 160)})
            </div>
          ) : (
            <div key={i} className="small muted">
              [{b.type} block, kept in the store]
            </div>
          ),
        )}
        <div className="small muted">
          {step.input_tokens} in, {step.output_tokens} out, {step.latency_ms} ms, {step.stop_reason}
        </div>
      </li>
    );
  return (
    <>
      {switched}
      {body}
    </>
  );
}

function Breaker({ pool, fetchedAt, now }: { pool: Pool; fetchedAt: number; now: number }) {
  const left = Math.max(0, pool.retry_in_s - (now - fetchedAt) / 1000);
  const state = pool.state === 'open' && left <= 0 ? 'half-open' : pool.state;
  return (
    <span className={`mf-state mf-${state}`}>
      {state}
      {state === 'open' ? ` ${left.toFixed(0)} s` : ''}
    </span>
  );
}

function MemoryPanel({ memory, busy, onCompact }: { memory: Memory | null; busy: boolean; onCompact: () => void }) {
  if (!memory) return <p className="small muted">Start a conversation to see its memory.</p>;
  const pct = Math.min(100, (memory.tokens / memory.threshold) * 100);
  return (
    <div>
      <div className="mf-bar" title={`${memory.tokens} of ${memory.threshold}`}>
        <div className={pct >= 100 ? 'over' : ''} style={{ width: `${pct}%` }} />
      </div>
      <div className="small">
        About {memory.tokens.toLocaleString()} tokens against a threshold of {memory.threshold.toLocaleString()} (window
        of {memory.model}: {memory.window.toLocaleString()}). Compactions so far: {memory.compactions}.
      </div>
      {memory.last ? (
        <details className="small">
          <summary>
            Last compaction: {memory.last.covers_from} to {memory.last.covers_until}, by {memory.last.model},{' '}
            {new Date(memory.last.created_at).toLocaleTimeString()}
          </summary>
          <div className="mf-text">{memory.last.text}</div>
        </details>
      ) : (
        <div className="small muted">No compaction yet.</div>
      )}
      <button className="btn small" disabled={busy} onClick={onCompact}>
        Compact now
      </button>
    </div>
  );
}

export default function ModelFailoverPage() {
  const [info, setInfo] = useState<FailoverInfo | null>(null);
  const [router, setRouter] = useState<RouterStatus | null>(null);
  const [lab, setLab] = useState<LabFailover | null>(null);
  const [fetchedAt, setFetchedAt] = useState(Date.now());
  const [now, setNow] = useState(Date.now());
  const [convs, setConvs] = useState<ConversationSummary[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [view, setView] = useState<ConversationView | null>(null);
  const [live, setLive] = useState<FailoverStep[] | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [primary, setPrimary] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [spent, setSpent] = useState(0);
  const [form, setForm] = useState({ compact_at: '', compact_max_tokens: '', keep_recent: '' });
  const [catalog, setCatalog] = useState<CatalogView | null>(null);
  const [draft, setDraft] = useState<CatalogEntry[]>([]);
  const [draftCompact, setDraftCompact] = useState('');
  const [dirty, setDirty] = useState(false);
  const [catalogMessage, setCatalogMessage] = useState('');
  const dirtyRef = useRef(false);
  const abort = useRef<AbortController | null>(null);

  const takeCatalog = useCallback((c: CatalogView) => {
    setCatalog(c);
    setDraft(c.entries);
    setDraftCompact(c.compact_model);
    dirtyRef.current = false;
    setDirty(false);
  }, []);
  const refreshCatalog = useCallback(() => {
    if (dirtyRef.current) return; // never replace what the person is editing
    svc
      .catalog()
      .then((c) => setCatalog((old) => (old && old.version === c.version && old.error === c.error ? old : c)))
      .catch(() => undefined);
  }, []);

  const refreshRouter = useCallback(() => {
    svc
      .router()
      .then((r) => {
        setRouter(r);
        setFetchedAt(Date.now());
      })
      .catch(() => undefined);
    svc
      .lab()
      .then(setLab)
      .catch(() => undefined);
  }, []);
  const loadList = useCallback(
    () =>
      svc
        .list()
        .then((r) => setConvs(r.conversations))
        .catch((e) => setError(errorText(e))),
    [],
  );
  const open = useCallback(async (id: string, p?: string) => {
    const v = await svc.get(id, p);
    setCurrent(id);
    setView(v);
    setLive(null);
    setForm({
      compact_at: v.conversation.overrides.compact_at?.toString() ?? '',
      compact_max_tokens: v.conversation.overrides.compact_max_tokens?.toString() ?? '',
      keep_recent: v.conversation.overrides.keep_recent?.toString() ?? '',
    });
  }, []);

  useEffect(() => {
    svc
      .info()
      .then((i) => {
        setInfo(i);
        setRouter(i.router);
        setFetchedAt(Date.now());
        setPrimary(i.router.pools[0]?.name ?? '');
      })
      .catch((e) => setError(errorText(e)));
    loadList();
    const tick = setInterval(() => setNow(Date.now()), 1000);
    svc
      .catalog()
      .then(takeCatalog)
      .catch((e) => setError(errorText(e)));
    const poll = setInterval(() => {
      refreshRouter();
      refreshCatalog();
    }, 3000);
    return () => {
      clearInterval(tick);
      clearInterval(poll);
      abort.current?.abort();
    };
  }, [loadList, refreshRouter, refreshCatalog, takeCatalog]);

  // A list that was never edited here follows the source (a file edited on disk, a change from another instance).
  useEffect(() => {
    if (catalog && !dirtyRef.current) {
      setDraft(catalog.entries);
      setDraftCompact(catalog.compact_model);
    }
  }, [catalog]);

  // The chosen primary may have been removed from the list.
  useEffect(() => {
    if (router && !router.pools.some((p) => p.name === primary)) setPrimary(router.pools[0]?.name ?? '');
  }, [router, primary]);

  const steps = live ?? view?.steps ?? [];

  async function newConversation() {
    setError('');
    try {
      const c = await svc.create();
      await loadList();
      await open(c.id, primary);
      setNotes([]);
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function run(start: (id: string, on: (e: FailoverEvent) => void, signal: AbortSignal) => Promise<void>) {
    if (!current || busy) return;
    setBusy(true);
    setError('');
    setNotes([]);
    setLive([...(view?.steps ?? [])]);
    abort.current = new AbortController();
    try {
      await start(
        current,
        (e) => {
          if (e.type === 'step') setLive((s) => [...(s ?? []), e.step]);
          else if (e.type === 'retry')
            setNotes((n) => [
              ...n,
              `${e.reason} on ${e.pool}: waiting ${e.retry_after ?? 0} s, then one retry on the same pool`,
            ]);
          else if (e.type === 'compaction_failed')
            setNotes((n) => [...n, `Compaction failed, history left as it was: ${e.reason}`]);
          else if (e.type === 'done') setSpent((s) => s + e.cost_usd);
          else if (e.type === 'error') {
            setSpent((s) => s + (e.cost_usd ?? 0)); // calls made before the error were charged too
            setError(e.message + (e.can_resume ? ' The steps so far are saved: use Resume.' : ''));
          }
        },
        abort.current.signal,
      );
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError(errorText(e));
    } finally {
      setBusy(false);
      refreshRouter();
      loadList();
      open(current, primary).catch((e) => setError(errorText(e)));
    }
  }

  const send = () => {
    const t = text.trim();
    if (!t || !current || busy) return; // checked before clearing, so a message that cannot go yet is kept
    setText('');
    void run((id, on, sig) => svc.send(id, t, primary, on, sig));
  };

  async function inject(pool: string, kind: FaultKind, count: number) {
    try {
      setRouter(await svc.inject(pool, kind, count));
      setFetchedAt(Date.now());
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function saveCatalog() {
    if (!catalog) return;
    setCatalogMessage('');
    try {
      takeCatalog(await svc.saveCatalog(draft, draftCompact, catalog.version));
      setCatalogMessage('Saved. The next model call uses it.');
      refreshRouter();
    } catch (e) {
      setCatalogMessage(errorText(e));
    }
  }

  async function reloadCatalog() {
    setCatalogMessage('');
    try {
      takeCatalog(await svc.reloadCatalog());
      refreshRouter();
    } catch (e) {
      setCatalogMessage(errorText(e));
    }
  }

  async function saveSettings() {
    if (!current) return;
    const num = (v: string) => (v.trim() === '' ? null : Number(v));
    try {
      const v = await svc.settings(current, {
        compact_at: num(form.compact_at) as number,
        compact_max_tokens: num(form.compact_max_tokens) as number,
        keep_recent: num(form.keep_recent) as number,
      });
      setView(v);
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function compactNow() {
    if (!current) return;
    setBusy(true);
    setError('');
    try {
      const r = await svc.compact(current, primary);
      setSpent((s) => s + r.cost_usd);
      await open(current, primary);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const memory = view?.memory ?? null;
  const rows = useMemo(() => view?.storage, [view]);

  return (
    <main className="page-model-failover">
      <div className="kicker">Agents and context</div>
      <h1>Model failover</h1>
      <p className="lede">
        An agent that keeps working when its model is rate limited (429) or overloaded (529, 5xx). It switches to
        another deployment or a similar model in the middle of a conversation, because the lab keeps the whole history
        in its own store and the model keeps nothing. Break a pool with the buttons, send a message, and watch the next
        model carry on from the same steps. See also <Link to="/support-desk">the support desk agent</Link>.
      </p>

      <section className="card mf-bar-top">
        <label className="small">
          Primary model{' '}
          <select value={primary} onChange={(e) => setPrimary(e.target.value)}>
            {router?.pools.map((p) => (
              <option key={p.name}>{p.name}</option>
            ))}
          </select>
        </label>
        <span className="small muted">Spent on this page: ${spent.toFixed(4)}. Injected faults cost nothing.</span>
        {error && <p className="mf-bad small">{error}</p>}
      </section>

      <section className="card mf-models-card">
        <h2>Models</h2>
        <ModelsPanel
          view={catalog}
          draft={draft}
          compact={draftCompact}
          dirty={dirty}
          busy={busy}
          message={catalogMessage}
          onChange={(entries) => {
            setDraft(entries);
            dirtyRef.current = true;
            setDirty(true);
          }}
          onCompact={(v) => {
            setDraftCompact(v);
            dirtyRef.current = true;
            setDirty(true);
          }}
          onSave={saveCatalog}
          onReload={reloadCatalog}
          onDiscard={() => catalog && takeCatalog(catalog)}
        />
      </section>

      <div className="mf-grid">
        <section className="card mf-list">
          <h2>Conversations</h2>
          <button className="btn small" onClick={newConversation} disabled={busy}>
            New conversation
          </button>
          <ul>
            {convs.map((c) => (
              <li key={c.id} className={c.id === current ? 'on' : ''}>
                <button className="mf-link" onClick={() => open(c.id, primary)} disabled={busy}>
                  {c.title || '(empty)'}
                </button>
                <span className="small muted"> {c.status}</span>
                <button
                  className="mf-x"
                  title="Delete"
                  disabled={busy}
                  onClick={async () => {
                    await svc.remove(c.id).catch((e) => setError(errorText(e)));
                    if (c.id === current) {
                      setCurrent(null);
                      setView(null);
                    }
                    loadList();
                  }}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section className="card mf-chat">
          <h2>Conversation</h2>
          {!current && <p className="small muted">Create or choose a conversation.</p>}
          <ol className="mf-trace">
            {steps.map((s, i) => (
              <StepView key={`${s.turn}-${s.step}-${i}`} step={s} />
            ))}
          </ol>
          {notes.map((n, i) => (
            <p key={i} className="mf-switch small">
              {n}
            </p>
          ))}
          {busy && <p className="small muted">Working…</p>}
          {current && (
            <>
              <textarea
                rows={3}
                value={text}
                maxLength={info?.limits.message ?? 1500}
                placeholder="Ask about the Northwind handbook, or ask for a ticket."
                onChange={(e) => setText(e.target.value)}
              />
              <div className="mf-row">
                <button className="btn" disabled={busy || !text.trim()} onClick={send}>
                  Send
                </button>
                {view?.incomplete && (
                  <button
                    className="btn small"
                    disabled={busy}
                    onClick={() => run((id, on, sig) => svc.resume(id, primary, on, sig))}
                  >
                    Resume from the last step
                  </button>
                )}
                {info?.examples.map((e) => (
                  <button key={e} className="btn small" disabled={busy} onClick={() => setText(e)}>
                    {short(e, 38)}
                  </button>
                ))}
              </div>
            </>
          )}
        </section>

        <aside className="mf-side">
          {lab && (
            <section className="card">
              <h2>Every other page</h2>
              {lab.enabled ? (
                <>
                  <p className="small">
                    On: a call to {lab.models.join(', ')} that fails with 429, 529, 5xx or a timeout on any page goes to
                    the next model in this list, through the same router and breakers as this page. {lab.routed_calls}{' '}
                    call{lab.routed_calls === 1 ? '' : 's'} routed since the backend started.
                  </p>
                  {lab.switches.length ? (
                    <ul className="small mf-lab-switches">
                      {lab.switches.slice(0, 8).map((w, i) => (
                        <li key={i}>
                          <span className="muted">{new Date(w.at * 1000).toLocaleTimeString()}</span> {w.area}: {w.from}{' '}
                          → {w.to} ({w.reason})
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="small muted">No switches yet.</p>
                  )}
                </>
              ) : (
                <p className="small muted">Off (LLM_LAB_FAILOVER=off): other pages call only the model they ask for.</p>
              )}
            </section>
          )}
          <section className="card">
            <h2>Router</h2>
            <p className="small muted">
              Order: the primary first, then the rest. A pool that fails opens its breaker for at least{' '}
              {router?.cooldown_s ?? 30} s.
            </p>
            {router?.pools.map((p) => (
              <div key={p.name} className="mf-pool">
                <div>
                  <Badge model={p.name} /> <Breaker pool={p} fetchedAt={fetchedAt} now={now} />{' '}
                  <span className="small muted">{p.note}</span>
                </div>
                <div className="small muted">
                  {p.provider}, window {p.context_tokens.toLocaleString()}, ok {p.successes}, failed {p.failures}
                  {p.last_error ? `, last: ${p.last_error}` : ''}
                  {p.faults.length ? `, queued faults: ${p.faults.join(' ')}` : ''}
                </div>
                <div className="mf-row">
                  {FAULT_BUTTONS.map((f) => (
                    <button key={f.label} className="btn small" onClick={() => inject(p.name, f.kind, f.count)}>
                      {f.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
            <button className="btn small" onClick={() => svc.resetRouter().then(setRouter)}>
              Close breakers and clear faults
            </button>
          </section>

          <section className="card">
            <h2>Memory</h2>
            <MemoryPanel memory={memory} busy={busy || !current} onCompact={compactNow} />
            {memory && current && (
              <div className="mf-settings small">
                <div className="muted">
                  Server defaults: compact at {memory.defaults.compact_at} of the window, ceiling{' '}
                  {memory.defaults.compact_max_tokens}, keep {memory.defaults.keep_recent} turns, summary by{' '}
                  {memory.defaults.compact_model}. Override for this conversation (empty uses the default):
                </div>
                <label>
                  Fraction (0.2 to 0.95){' '}
                  <input
                    value={form.compact_at}
                    onChange={(e) => setForm({ ...form, compact_at: e.target.value })}
                    placeholder={String(memory.defaults.compact_at)}
                  />
                </label>
                <label>
                  Ceiling in tokens (4000 or more){' '}
                  <input
                    value={form.compact_max_tokens}
                    onChange={(e) => setForm({ ...form, compact_max_tokens: e.target.value })}
                    placeholder={String(memory.defaults.compact_max_tokens)}
                  />
                </label>
                <label>
                  Keep recent turns (1 to 20){' '}
                  <input
                    value={form.keep_recent}
                    onChange={(e) => setForm({ ...form, keep_recent: e.target.value })}
                    placeholder={String(memory.defaults.keep_recent)}
                  />
                </label>
                <button className="btn small" disabled={busy} onClick={saveSettings}>
                  Save for this conversation
                </button>
                <div className="muted">Token counts are an estimate: {info?.estimate}.</div>
              </div>
            )}
          </section>

          <section className="card">
            <h2>Storage</h2>
            <p className="small">
              History lives in:{' '}
              <b>
                {(rows?.kind ?? info?.storage.kind) === 'azurite'
                  ? 'Azurite (Blob and Table, on this machine)'
                  : (rows?.kind ?? info?.storage.kind) === 'azure'
                    ? 'Azure Storage (Blob and Table)'
                    : 'local files'}
              </b>{' '}
              <span className="mono muted">{rows?.where ?? info?.storage.where}</span>
            </p>
            {rows?.blobs && (
              <>
                <div className="small muted">Blobs, one per step, never changed once written:</div>
                <ul className="mono small mf-paths">
                  {rows.blobs.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
                <div className="small muted">Conversations table row (PartitionKey = user, RowKey = conversation):</div>
                <pre className="mono small">{JSON.stringify(rows.conversation_row, null, 1)}</pre>
                <div className="small muted">Steps table rows (PartitionKey = conversation, RowKey = turn-step):</div>
                <pre className="mono small">
                  {rows.step_rows
                    ?.map((r) => `${r.RowKey}  ${r.model || r.kind}  ${r.fallbackFrom ? `from ${r.fallbackFrom}` : ''}`)
                    .join('\n')}
                </pre>
              </>
            )}
          </section>
        </aside>
      </div>

      <section className="card mf-explain">
        <h2>The one rule</h2>
        <p>
          The model holds no state. Your system holds the conversation, and every model call is built from it. If a
          provider holds the thread (the Responses API with <code>previous_response_id</code>, or a Microsoft Foundry
          Agent Service thread) you cannot move the conversation to another model, because the history is on the wrong
          side of the wall. Use those for what they are good at, but keep the conversation of record in your own store.
        </p>

        <h2>What each error means</h2>
        <div className="table-wrap">
          <table className="t small">
            <thead>
              <tr>
                <th>Failure</th>
                <th>Do</th>
                <th>Why</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>429 with a retry-after of 2 s or less</td>
                <td>Retry once on the same pool</td>
                <td>The wait is shorter than a switch costs. If the retry fails too, switch.</td>
              </tr>
              <tr>
                <td>429 with a long or no retry-after</td>
                <td>Open the breaker, switch</td>
                <td>Waiting would stall the person. Other capacity may be free.</td>
              </tr>
              <tr>
                <td>529, 503 and other 5xx, a timeout, a dropped connection</td>
                <td>Open the breaker, switch</td>
                <td>The service is struggling. Leave it alone until the cool-down ends, then send one probe.</td>
              </tr>
              <tr>
                <td>400, 401, 403, 404, a prompt that is too long, a refusal</td>
                <td>Never switch. Report it.</td>
                <td>The next model would fail the same way, or a refusal is an answer. Switching hides a bug.</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="small muted">
          The Anthropic SDK retries a 429 or 5xx twice by itself before it raises. A service that owns failover sets{' '}
          <code>max_retries=0</code> so the router decides. This lab leaves it as it is, so a real 429 reaches the
          router after those retries. Injected faults skip them.
        </p>

        <h2>The fallback order</h2>
        <ol>
          <li>
            The same model on another deployment or region. Azure API Management&apos;s AI gateway can do this for you:
            backend pools with priority and weight, and a circuit breaker per backend, with no change to the agent.
          </li>
          <li>
            The same model from another provider (for example Claude through Microsoft Foundry and through Anthropic).
          </li>
          <li>
            A similar model that passed your evaluations for this task. Here: the order in the Models panel above, which
            you can change without a restart.
          </li>
        </ol>

        <h2>Switching in the middle of a conversation, safely</h2>
        <ul>
          <li>
            <b>Only between model calls.</b> A tool result is a step in the store. The next model reads it from history
            and never asks for the tool again.
          </li>
          <li>
            <b>No repeated side effects.</b> <code>create_ticket</code> carries an idempotency key (conversation, turn,
            subject). Even if the process dies after the tool ran and before its step was saved, the resumed run gets
            the same ticket back.
          </li>
          <li>
            <b>Partial output is thrown away.</b> If a streamed reply fails half way, drop what arrived and call the
            next model. This lab does not stream: it keeps only whole replies.
          </li>
          <li>
            <b>Translation.</b> History is kept in Claude&apos;s message shape. A GPT deployment gets the same history
            turned into Chat Completions messages. Thinking blocks stay in the store and go only to the model that wrote
            them.
          </li>
          <li>
            <b>Context window.</b> A fallback may have a smaller window. The history is measured before every call, and
            compacted if it is over the threshold for that model.
          </li>
        </ul>

        <h2>Compaction</h2>
        <p>
          A long conversation costs more and is slower, and eventually does not fit. Before each model call the lab
          measures what it is about to send. When that passes the smaller of <code>MODEL_FAILOVER_COMPACT_AT</code> (a
          fraction of the current model&apos;s window, default 0.7) and <code>MODEL_FAILOVER_COMPACT_MAX_TOKENS</code>{' '}
          (an absolute ceiling, default 60,000), the older turns are summarised by compaction model chosen in the Models
          panel (<code>MODEL_FAILOVER_COMPACT_MODEL</code> overrides it when set), called through the router, so it can
          fail over too. The summary is stored as a step. From then on the model gets the latest summary and the last{' '}
          <code>MODEL_FAILOVER_KEEP_RECENT</code> turns (default 4) word for word.
        </p>
        <ul>
          <li>The cut is always between turns, so a tool call is never parted from its result.</li>
          <li>
            Code appends the write actions already taken (the tickets) to every summary, so a summary cannot forget one.
          </li>
          <li>Repeated compaction summarises the last summary plus the next range.</li>
          <li>
            An empty, refused or cut-off summary is not used. The full history goes out if it still fits, otherwise the
            turn fails clearly.
          </li>
          <li>
            The original steps are never deleted. Compaction changes only what is sent. The blobs are the audit trail:
            you can always show what was said, and re-summarise with a better model later.
          </li>
          <li>
            Counts are an estimate (characters over four, plus a margin), because counting through an API is a call that
            can fail in an outage.
          </li>
        </ul>

        <h2>Where the history lives</h2>
        <p>
          One immutable JSON blob per step at{' '}
          <code>conversations/&#123;user&#125;/&#123;conv&#125;/steps/&#123;turn&#125;-&#123;step&#125;.json</code>. A{' '}
          <b>Conversations</b> table row (PartitionKey = user, RowKey = conversation) holds the title, status, last step
          and the compaction overrides. A <b>Steps</b> table row per step (PartitionKey = conversation, RowKey =
          turn-step) holds the blob path, the model, the provider, what it fell back from and why, tokens and latency.
          Writes use optimistic concurrency: the conversation row is replaced with <code>If-Match</code> on its ETag.
          Two requests at once cannot both win: the loser gets 409 and nothing is written. A crash between claiming a
          step and writing it is repaired on the next load. Sign-in is keyless (<code>DefaultAzureCredential</code>).
          With nothing configured the same layout is written to files; with Azurite&apos;s published development
          connection string it runs locally. SQL Server comes later behind the same interface: a Conversations table
          with a rowversion as the ETag, and a Steps table with the content in a JSON column.
        </p>

        <h2>The same thing in other frameworks</h2>
        <ul>
          <li>
            <b>Microsoft Agent Framework</b>: a chat client that wraps two clients and falls back with the same rules,
            and a <code>HistoryProvider</code> (get_messages, save_messages) over the same Blob and Table layout, with
            compaction inside it. See <code>examples/model-failover/agent_framework/</code>.
          </li>
          <li>
            <b>LangGraph</b>: <code>model.with_fallbacks([...], exceptions_to_handle=...)</code>, a{' '}
            <code>RetryPolicy</code> on the node, a custom checkpointer that stores checkpoints in Blob with a Table
            index, and a summarising node. See <code>examples/model-failover/langgraph/</code>.
          </li>
        </ul>
      </section>
    </main>
  );
}
