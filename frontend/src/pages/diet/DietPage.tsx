import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  dietService,
  type DietFile,
  type DietInfo,
  type DietEvent,
  type DietState,
  type DietStep,
  type MemoryFile,
} from '@/services/dietService';
import { statusService } from '@/services/statusService';
import { isLocalModel } from '@/lib/models';
import { VoiceComposer } from '@/components/voice/VoiceComposer';
import './diet.css';

const usd = (v: number) => `$${v < 0.1 ? v.toFixed(4) : v.toFixed(2)}`;
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** What the status line says while each tool is in use. */
const ACTIVITY: Record<string, string> = {
  memory: 'Checking your memory…',
  set_profile: 'Working out your targets…',
  save_week_plan: 'Writing your week…',
};

interface Line {
  from: 'you' | 'agent';
  text: string;
  steps?: DietStep[];
  cost?: number;
}

/** One line per tool call, with its arguments and result as JSON on request. */
function Steps({ steps }: { steps: DietStep[] }) {
  if (!steps.length) return null;
  return (
    <div className="dt-steps">
      {steps.map((s, i) => {
        const bad = 'error' in s.result || 'refused' in s.result || 'stopped' in s.result;
        const label =
          s.tool === 'memory' ? `memory.${String(s.args.command ?? '')} ${String(s.args.path ?? '')}` : s.tool;
        return (
          <details key={i} className={`dt-step${bad ? ' bad' : ''}`}>
            <summary>
              <code>{label}</code>
              {bad && <span className="dt-flag">{'refused' in s.result ? 'refused' : 'not done'}</span>}
            </summary>
            <pre>{JSON.stringify({ args: s.args, result: s.result }, null, 2)}</pre>
          </details>
        );
      })}
    </div>
  );
}

function PlanView({ state }: { state: DietState }) {
  const { plan, totals, targets } = state;
  if (!plan || !totals || !targets) return null;
  return (
    <div className="dt-days">
      {plan.days.map((d) => {
        const t = totals[d.day];
        const off = Math.abs(t.kcal - targets.kcal_per_day) / targets.kcal_per_day;
        return (
          <div key={d.day} className="dt-day">
            <div className="dt-day-head">
              <b>{d.day}</b>
              <span className={`small ${off > 0.05 ? 'muted' : ''}`}>
                {t.kcal} kcal · {t.protein_g} g protein
              </span>
            </div>
            {d.meals.map((m, i) => (
              <div key={i} className="dt-meal">
                <span className="dt-slot">{m.slot}</span>
                <span className="dt-dish">
                  {m.name}
                  <span className="small muted">
                    {' '}
                    · {m.kcal} kcal · {m.prep_minutes} min
                  </span>
                </span>
              </div>
            ))}
          </div>
        );
      })}
      {plan.notes && <p className="small dt-notes">{plan.notes}</p>}
    </div>
  );
}

function Shopping({ state }: { state: DietState }) {
  if (!state.shopping) return null;
  return (
    <div className="dt-shopping">
      {Object.entries(state.shopping).map(([aisle, items]) => (
        <div key={aisle}>
          <h4>{state.aisles[aisle] ?? aisle}</h4>
          <ul>
            {items.map((i) => (
              <li key={`${i.item}-${i.unit}`}>
                {i.item}{' '}
                <span className="muted">
                  {i.quantity}
                  {i.unit === 'item' ? '' : ` ${i.unit}`}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function Memory({ files, onForget }: { files: MemoryFile[]; onForget: () => void }) {
  return (
    <div className="dt-memory">
      {files.length === 0 ? (
        <p className="small muted">Nothing remembered yet. The agent saves what it learns as files in /memories.</p>
      ) : (
        files.map((f) => (
          <div key={f.path}>
            <code className="small">{f.path}</code>
            <pre>{f.text}</pre>
          </div>
        ))
      )}
      {files.length > 0 && (
        <button className="btn small" onClick={onForget}>
          Forget me
        </button>
      )}
    </div>
  );
}

// The name picks the memory folder, so this browser remembers it; every model reads the same folder.
const NAME_KEY = 'llm-lab.diet.name';
function savedName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
}

/** A diet planner agent: it asks a few questions, designs a checked week of meals, remembers, and the plan downloads. */
export default function DietPage() {
  const [info, setInfo] = useState<DietInfo | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState('');
  const [user, setUser] = useState(savedName);
  const [consent, setConsent] = useState(false);
  const [chatId, setChatId] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [state, setState] = useState<DietState | null>(null);
  const [memory, setMemory] = useState<MemoryFile[]>([]);
  const [tab, setTab] = useState<'plan' | 'shopping' | 'memory'>('plan');
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [cost, setCost] = useState(0);
  const [activity, setActivity] = useState('');
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([dietService.info(), statusService.status()])
      .then(([i, s]) => {
        if (cancelled) return;
        setInfo(i);
        const offered = (s.models || []).slice();
        if (i.model && !offered.includes(i.model)) offered.unshift(i.model);
        setModels(offered);
        setModel(i.model || offered[0] || '');
      })
      .catch((err) => !cancelled && setError(errorText(err)));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (chatId) return;
    const timer = window.setTimeout(() => {
      dietService
        .memory(user || 'guest')
        .then((r) => setMemory(r.memory))
        .catch(() => undefined);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [user, chatId]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
  }, [lines, busy]);

  function newConversation() {
    setChatId(null);
    setLines([]);
    setState(null);
    setCost(0);
    setError('');
  }

  async function send(text: string) {
    const message = text.trim();
    if (!message || busy) return;
    setBusy(true);
    setError('');
    setInput('');
    setLines((ls) => [...ls, { from: 'you', text: message }]);
    try {
      let id = chatId;
      if (!id) {
        const started = await dietService.newChat(model || undefined, user || 'guest', consent);
        id = started.chat_id;
        setChatId(id);
        setUser(started.user);
        try {
          localStorage.setItem(NAME_KEY, started.user);
        } catch {
          /* not remembered: they type it again next time */
        }
      }
      // The planner's line fills in as it works: its words, each tool call, then the reply and the plan.
      setLines((ls) => [...ls, { from: 'agent', text: '', steps: [] }]);
      const patch = (f: (l: Line) => Line) => setLines((ls) => [...ls.slice(0, -1), f(ls[ls.length - 1])]);
      let failed = '';
      await dietService.stream(id, message, (e: DietEvent) => {
        if (e.type === 'thinking') setActivity('Thinking…');
        else if (e.type === 'text') {
          setActivity('Writing…');
          patch((l) => ({ ...l, text: l.text + e.text }));
        } else if (e.type === 'tool_start') setActivity(ACTIVITY[e.tool] ?? `Using ${e.tool}…`);
        else if (e.type === 'writing')
          setActivity(
            e.tool === 'save_week_plan'
              ? `Writing your week… ${e.chars.toLocaleString('en-GB')} characters so far`
              : `${ACTIVITY[e.tool] ?? e.tool}`,
          );
        else if (e.type === 'step') {
          patch((l) => ({ ...l, steps: [...(l.steps ?? []), e.step] }));
          if (e.step.tool === 'save_week_plan')
            setActivity('error' in e.step.result ? 'The checks found problems; fixing them…' : 'Plan saved.');
        } else if (e.type === 'done') {
          patch((l) => ({ ...l, text: e.reply, steps: e.steps, cost: e.cost_usd }));
          setCost((c) => c + (e.cost_usd || 0));
          setState(e);
          setMemory(e.memory);
          if (e.plan) setTab('plan');
        } else if (e.type === 'error') failed = e.message;
      });
      if (failed) setError(failed);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
      setActivity('');
    }
  }

  async function download(kind: DietFile) {
    if (!chatId || !info) return;
    try {
      await dietService.download(chatId, kind, info.files[kind]);
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function forget() {
    if (!window.confirm(`Delete everything remembered about ${user}?`)) return;
    try {
      setMemory((await dietService.forget(user || 'guest')).memory);
    } catch (err) {
      setError(errorText(err));
    }
  }

  const t = state?.targets;

  return (
    <main className="page-diet">
      <div className="kicker">Building · diet planner agent</div>
      <h1>A diet planner that asks, plans, checks and remembers</h1>
      <p className="lede">
        Tell the agent about yourself, or let it ask. It works out your daily targets with code, designs a week of
        meals, and code checks the plan against your allergies, diet, calorie target and cooking time before saving it.
        Download it as a PDF, a shopping list or a spreadsheet. Next week it remembers you, keeping health details only
        if you agree.
      </p>
      <p className="small muted">
        Calories and protein are the model’s estimates. This is a lab example, not medical or dietetic advice.
      </p>
      {error && !busy && <p className="dt-bad small">{error}</p>}

      <div className="dt-layout">
        <section className="card dt-chat" aria-label="Chat with the planner">
          <header className="dt-bar">
            <label className="small">
              Your name{' '}
              <input
                value={user}
                onChange={(e) => setUser(e.target.value)}
                disabled={!!chatId}
                size={10}
                placeholder="e.g. Sam"
                title="Your memory is kept under this name, whichever model you choose"
              />
            </label>
            <label className="small">
              Model{' '}
              <select value={model} onChange={(e) => setModel(e.target.value)} disabled={!!chatId}>
                {models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                    {m.startsWith('gpt-') ? ' (Azure OpenAI)' : isLocalModel(m) ? ' (local, free)' : ''}
                  </option>
                ))}
              </select>
            </label>
            <label
              className="small dt-consent"
              title={chatId ? 'Fixed for this conversation. Press New conversation to change it.' : undefined}
            >
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
                disabled={!!chatId}
              />{' '}
              Remember my health details (allergies, conditions, weight, height)
              {chatId && <span className="muted"> · fixed for this conversation; start a new one to change it</span>}
            </label>
            <button className="btn small" onClick={newConversation} disabled={busy}>
              New conversation
            </button>
          </header>
          {isLocalModel(model) && (
            <p className="small muted dt-note">
              The local model writes a whole week slowly: a plan can take several minutes. The checks are the same.
            </p>
          )}
          <div className="dt-messages" ref={scroller}>
            {lines.length === 0 && (
              <p className="small muted">Say hello, or pick a sample below. The agent will ask what it needs.</p>
            )}
            {lines.map((line, i) => (
              <div key={i} className={`dt-msg ${line.from}`}>
                <div className="small dt-from">{line.from === 'agent' ? 'Planner' : 'You'}</div>
                {line.steps && <Steps steps={line.steps} />}
                <div className="dt-bubble">
                  {line.from === 'agent' ? (
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{line.text || '(no reply)'}</ReactMarkdown>
                  ) : (
                    line.text
                  )}
                </div>
                {line.cost !== undefined && <div className="small muted">{usd(line.cost)}</div>}
              </div>
            ))}
            {busy && (
              <div className="small dt-activity" aria-live="polite">
                <span className="dt-pulse" /> {activity || 'The planner is working…'}
              </div>
            )}
          </div>
          <VoiceComposer
            value={input}
            onChange={setInput}
            onSend={(t) => void send(t)}
            onError={setError}
            busy={busy}
          />
          <div className="dt-samples">
            {(info?.samples ?? []).map((s) => (
              <button key={s.label} className="btn small" disabled={busy} onClick={() => setInput(s.text)}>
                {s.label}
              </button>
            ))}
          </div>
          <p className="small muted">Total this conversation: {usd(cost)}</p>
        </section>

        <section className="card dt-side" aria-label="Your plan">
          {t ? (
            <div className="dt-targets">
              <div>
                <b>{t.kcal_per_day}</b> kcal a day
              </div>
              <div>
                <b>{t.protein_g_per_day} g</b> protein
              </div>
              <div className="small muted">
                maintenance {t.maintenance_kcal} kcal · BMI {t.bmi}
                {t.floor_applied ? ' · raised to the floor' : ''}
              </div>
              {t.notes?.map((n) => (
                <p key={n} className="small dt-warn">
                  {n}
                </p>
              ))}
            </div>
          ) : (
            <p className="small muted">Your targets appear here once the planner has what it needs.</p>
          )}
          <div className="dt-downloads">
            <button className="btn small" disabled={!state?.plan} onClick={() => download('plan')}>
              Meal plan (PDF)
            </button>
            <button className="btn small" disabled={!state?.plan} onClick={() => download('shopping')}>
              Shopping list (PDF)
            </button>
            <button className="btn small" disabled={!state?.plan} onClick={() => download('xlsx')}>
              Spreadsheet (.xlsx)
            </button>
          </div>
          <div className="dt-tabs" role="tablist">
            {(['plan', 'shopping', 'memory'] as const).map((k) => (
              <button
                key={k}
                role="tab"
                aria-selected={tab === k}
                className={tab === k ? 'on' : ''}
                onClick={() => setTab(k)}
              >
                {k === 'plan' ? 'Week' : k === 'shopping' ? 'Shopping list' : `Memory (${memory.length})`}
              </button>
            ))}
          </div>
          {tab === 'plan' && (state?.plan ? <PlanView state={state} /> : <p className="small muted">No plan yet.</p>)}
          {tab === 'shopping' &&
            (state?.shopping ? <Shopping state={state} /> : <p className="small muted">No plan yet.</p>)}
          {tab === 'memory' && <Memory files={memory} onForget={forget} />}
        </section>
      </div>

      <h2>What code decides, not the model</h2>
      <div className="table-wrap">
        <table className="t">
          <thead>
            <tr>
              <th>Rule</th>
              <th>Where</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Daily calories and protein (Mifflin-St Jeor, activity, goal, a floor of 1,400 or 1,600 kcal)</td>
              <td>
                <code>set_profile</code> → <code>targets_for</code>
              </td>
            </tr>
            <tr>
              <td>No plan for under-18s; no weight loss when underweight, pregnant or breastfeeding</td>
              <td>
                <code>targets_for</code> refuses
              </td>
            </tr>
            <tr>
              <td>Eating-disorder signs or a starvation target get a fixed reply that points to support</td>
              <td>Screened before any model sees the message</td>
            </tr>
            <tr>
              <td>
                Seven days, the right meals, each day within 10% of the target, enough protein, nothing you are allergic
                to or do not eat, prep times that fit, some variety
              </td>
              <td>
                <code>save_week_plan</code> → <code>check_plan</code>
              </td>
            </tr>
            <tr>
              <td>Health details kept in memory only with your agreement; card numbers never</td>
              <td>The memory store’s guard</td>
            </tr>
            <tr>
              <td>The shopping list totals and the files</td>
              <td>Made from the checked plan</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="small muted">
        Code: <code>examples/diet/diet.py</code>, shared with the command line <code>examples/diet/diet_agent.py</code>.
      </p>
    </main>
  );
}
