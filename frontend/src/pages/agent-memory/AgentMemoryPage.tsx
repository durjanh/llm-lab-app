import { useEffect, useRef, useState } from 'react';
import {
  agentMemoryService,
  type Memory,
  type MemoryInfo,
  type MemoryState,
  type TurnResult,
} from '@/services/agentMemoryService';
import './agent-memory.css';

type Step =
  | { act: 'start'; user: string; shows: string }
  | { act: 'say'; user: string; text: string; shows: string; careless?: boolean }
  | { act: 'end'; user: string; shows: string }
  | { act: 'days'; user: string; days: number; shows: string };

/** A real run: every message and every session end is a call to Claude. Each step says which block it shows. */
const SCENARIO: Step[] = [
  { act: 'start', user: 'sam', shows: 'Session 1: working memory starts empty' },
  {
    act: 'say',
    user: 'sam',
    text: "Hi, I'm Sam. I live in Leeds and I'm vegetarian.",
    shows: 'Semantic memory: facts and preferences, with their source',
  },
  {
    act: 'say',
    user: 'sam',
    text: "I'm allergic to peanuts, so please always check for that.",
    shows: 'Importance: a safety fact',
  },
  {
    act: 'say',
    user: 'sam',
    text: 'When you suggest a plan, keep it to three bullet points.',
    shows: 'Procedural memory: how to do things for Sam',
  },
  {
    act: 'say',
    user: 'sam',
    text: "This Saturday I'm taking my sister to York for her birthday.",
    shows: 'A one-off plan',
  },
  { act: 'end', user: 'sam', shows: 'Episodic memory and compression: the session becomes one sentence' },
  { act: 'days', user: 'sam', days: 2, shows: 'Two days pass' },
  { act: 'start', user: 'sam', shows: 'Session 2: a new conversation; long-term memory carries over' },
  {
    act: 'say',
    user: 'sam',
    text: 'What could I cook for dinner tonight?',
    shows: 'Retrieval: the profile answers a question that shares no words with it',
  },
  {
    act: 'say',
    user: 'sam',
    text: "By the way, I'm still vegetarian.",
    shows: 'Consolidation: if Claude saves it again, code merges it; Claude may judge it nothing new and save nothing',
  },
  { act: 'end', user: 'sam', shows: 'Another episode, linked to the memories it used (graph)' },
  { act: 'days', user: 'sam', days: 60, shows: 'Decay and forgetting: two months pass' },
  { act: 'start', user: 'sam', shows: 'Session 3' },
  {
    act: 'say',
    user: 'sam',
    text: "Big news: I've moved to Bristol.",
    shows: 'Conflict resolution: the new home replaces the old one',
  },
  {
    act: 'say',
    user: 'sam',
    text: 'For bookings, use my card 4111 1111 1111 1111.',
    careless: true,
    shows: 'Privacy: told to keep everything; Claude usually declines, and if it tries, the guard in code refuses',
  },
  {
    act: 'say',
    user: 'sam',
    text: 'What do you remember about me, and where did each thing come from?',
    shows: 'Provenance: every memory knows its source',
  },
  {
    act: 'say',
    user: 'sam',
    text: 'Please forget that I asked for three bullet points.',
    shows: 'Forgetting on request',
  },
  { act: 'end', user: 'sam', shows: 'Session 3 ends' },
  { act: 'start', user: 'priya', shows: "Isolation: a different person's memory" },
  {
    act: 'say',
    user: 'priya',
    text: "Hi, I'm Priya. Where does Sam live?",
    shows: "Isolation: Sam's memories never reach Priya's requests",
  },
  { act: 'end', user: 'priya', shows: 'Done' },
];

/** The fifteen building blocks, and where each one happens on this page. */
const BLOCKS: [string, string][] = [
  ['Working memory', "The session's last messages, sent with each request; it ends with the session."],
  ['Episodic memory', 'When a session ends, Claude writes what happened as one sentence (kind episode).'],
  ['Semantic memory', 'Facts and preferences Claude keeps with the remember tool.'],
  ['Procedural memory', 'How the person wants things done (kind procedure), such as "three bullet points".'],
  ['Long-term memory', "The person's file: it outlives every session and is read at the start of each turn."],
  ['Summarisation', "The episode: a session's messages summarised."],
  ['Retrieval', 'Each turn: the profile, plus one-off memories that share words with the message. Shown with scores.'],
  ['Consolidation', 'The same thing said again is merged into the memory it repeats, which gets stronger.'],
  ['Compression', "Each episode records its size: the session's tokens against the sentence's."],
  ['Graph memory', 'Episodes link to the memories the session used; replaced memories link to what replaced them.'],
  [
    'Decay',
    'Strength halves every half-life unused (episodes and one-off plans 30 days, preferences 180, facts 365) and grows with use.',
  ],
  ['Forgetting', 'Below the floor a memory is forgotten, with the reason; the person can also ask.'],
  [
    'Conflict resolution',
    'Something new about the same subject replaces the old; a guess never replaces what was said.',
  ],
  ['Provenance', 'Every memory keeps the words, session and day it came from, and whether the person really said it.'],
  ['Memory isolation', "One file per person; a turn reads only that person's memories."],
];

const statusText = (m: Memory) =>
  m.status === 'active' ? 'active' : m.status === 'superseded' ? `replaced by ${m.replaced_by}` : 'forgotten';

/** An assistant that remembers people across sessions, on Claude, with every memory rule visible. */
export default function AgentMemoryPage() {
  const [info, setInfo] = useState<MemoryInfo | null>(null);
  const [user, setUser] = useState('sam');
  const [state, setState] = useState<MemoryState | null>(null);
  const [session, setSession] = useState('');
  const [model, setModel] = useState('');
  const [chat, setChat] = useState<{ role: 'user' | 'assistant' | 'note'; text: string; turn?: TurnResult }[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [step, setStep] = useState(-1); // the scenario's current step, or -1
  const [spent, setSpent] = useState(0);
  const [showAll, setShowAll] = useState(true);
  const stopRef = useRef(false);
  const busyRef = useRef(false); // set at once, before any await, so a second click is refused

  useEffect(() => {
    agentMemoryService
      .info()
      .then((i) => {
        setInfo(i);
        setModel(i.model);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  // Load the person shown. While a run is going, its own replies are newer than this read, so it is skipped.
  useEffect(() => {
    let alive = true;
    agentMemoryService
      .state(user)
      .then((s) => alive && !busyRef.current && setState(s))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [user]);

  /** Choosing another person by hand: their memory, and no session or conversation yet. */
  const choose = (who: string) => {
    setUser(who);
    setSession('');
    setChat([]);
  };

  useEffect(() => () => void (stopRef.current = true), []);

  const note = (text: string) => setChat((c) => [...c, { role: 'note', text }]);

  /** One action, used by both the scenario and the buttons. Returns the session id in use afterwards. */
  async function act(s: Step, sid: string): Promise<string> {
    if (s.act === 'start') {
      const r = await agentMemoryService.start(s.user);
      setState(r);
      note(`Session ${r.sessions[r.sessions.length - 1].number} starts for ${s.user}: working memory is empty.`);
      return r.session;
    }
    if (s.act === 'days') {
      const r = await agentMemoryService.advance(s.user, s.days);
      setState(r);
      const faded = r.log.filter((l) => l.event === 'forgotten' && l.day === r.day).length;
      note(`${s.days} days pass: day ${r.day}.${faded ? ` ${faded} memor${faded === 1 ? 'y' : 'ies'} faded.` : ''}`);
      return sid;
    }
    if (s.act === 'end') {
      const r = await agentMemoryService.end(s.user, sid, model);
      setState(r);
      setSpent((v) => v + r.cost_usd);
      const ep = r.memories.find((m) => m.id === r.episode);
      note(ep ? `Session ends. Episode ${ep.id}: ${ep.text}` : 'Session ends. Nothing worth an episode happened.');
      return '';
    }
    setChat((c) => [...c, { role: 'user', text: s.text }]);
    const r = await agentMemoryService.say(s.user, sid, s.text, model, s.careless);
    setState(r);
    setSpent((v) => v + r.cost_usd);
    setChat((c) => [...c, { role: 'assistant', text: r.reply, turn: r }]);
    return sid;
  }

  /** Runs the steps in order; false when one failed. The caller may have set busyRef already. */
  async function run(steps: Step[], startSid = session): Promise<boolean> {
    busyRef.current = true;
    setError('');
    setBusy(true);
    stopRef.current = false;
    let sid = startSid;
    let who = user; // tracked here: the state value seen by this function does not change while it runs
    try {
      for (let i = 0; i < steps.length && !stopRef.current; i++) {
        const s = steps[i];
        if (steps === SCENARIO) setStep(i);
        if (s.user !== who) {
          who = s.user;
          setUser(who);
          sid = '';
        }
        sid = await act(s, sid);
        setSession(sid);
      }
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
      if (steps === SCENARIO) setStep(-1);
    }
  }

  async function playScenario() {
    if (busyRef.current) return;
    busyRef.current = true; // before the resets, so a double click cannot start a second run
    setBusy(true);
    setChat([]);
    for (const p of ['sam', 'priya']) await agentMemoryService.reset(p).catch(() => undefined);
    setSpent(0);
    if (user !== 'sam') setUser('sam');
    await run(SCENARIO, '');
  }

  const send = async () => {
    const text = input.trim();
    if (!text || busyRef.current) return;
    setInput('');
    const say: Step = { act: 'say', user, text, shows: '' };
    // With no session open, start one first: the same run, so it has the busy guard and the error handling.
    const ok = await run(session ? [say] : [{ act: 'start', user, shows: '' }, say]);
    if (!ok) setInput(text); // nothing was lost: the words are back in the box
  };

  const memories = (state?.memories ?? []).filter((m) => showAll || m.status === 'active');
  const last = [...chat].reverse().find((c) => c.turn)?.turn;

  return (
    <main className="page-agent-memory">
      <div className="kicker">Agents · Memory</div>
      <h1>An assistant that remembers, with every memory rule on show</h1>
      <p className="lede">
        Claude talks to a person over several separate conversations. It decides what is worth remembering; code decides
        what happens to each memory: merged, replaced, faded, forgotten or refused, and never shown to anyone else. Play
        the scenario to watch the building blocks happen on real calls, or talk to it yourself. Claude's choices vary
        from run to run; the rules in code do not, and the log shows which was which.
      </p>
      {error && <p className="am-error">{error}</p>}

      <section className="card">
        <div className="am-bar">
          <button className="btn primary" onClick={() => void playScenario()} disabled={busy}>
            Play the scenario (real calls, about $0.05)
          </button>
          {busy && step >= 0 && (
            <button className="btn" onClick={() => (stopRef.current = true)}>
              Stop after this step
            </button>
          )}
          <label>
            Person
            <select value={user} onChange={(e) => choose(e.target.value)} disabled={busy}>
              {[...new Set(['sam', 'priya', ...(info?.people ?? [])])].map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </label>
          <label>
            Model
            <select value={model} onChange={(e) => setModel(e.target.value)} disabled={busy}>
              {info?.models.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </label>
          <span className="am-day">Day {state?.day ?? 1}</span>
          {[7, 30, 90].map((d) => (
            <button
              key={d}
              className="btn ghost"
              disabled={busy}
              onClick={() => void run([{ act: 'days', user, days: d, shows: '' }])}
            >
              +{d} days
            </button>
          ))}
          <button
            className="btn ghost"
            disabled={busy}
            onClick={() => {
              if (!window.confirm(`Forget everything about ${user}?`)) return;
              agentMemoryService.reset(user).then((s) => {
                setState(s);
                setSession('');
                setChat([]);
              });
            }}
          >
            Reset {user}
          </button>
          {spent > 0 && <span className="small muted">spent here ${spent.toFixed(4)}</span>}
        </div>
        {step >= 0 && (
          <ol className="am-steps small">
            {SCENARIO.map((s, i) => (
              <li key={i} className={i === step ? 'on' : i < step ? 'done' : ''}>
                <b>{s.user}</b>{' '}
                {s.act === 'say'
                  ? `“${s.text}”`
                  : s.act === 'days'
                    ? `+${s.days} days`
                    : s.act === 'start'
                      ? 'new session'
                      : 'end session'}
                <span className="muted"> · {s.shows}</span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <div className="am-grid">
        <section className="card am-chat">
          <h2>Conversation with {user}</h2>
          <div className="am-log-chat">
            {chat.length === 0 && <p className="small muted">Play the scenario, or write a message below.</p>}
            {chat.map((c, i) => (
              <div key={i} className={`am-msg am-${c.role}`}>
                {c.text}
                {c.turn && <TurnDetails turn={c.turn} />}
              </div>
            ))}
          </div>
          <div className="am-input">
            <input
              value={input}
              placeholder={`Write to the assistant as ${user}`}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !busy && void send()}
              disabled={busy}
              maxLength={2000}
            />
            <button className="btn primary" onClick={() => void send()} disabled={busy || !input.trim()}>
              Send
            </button>
            <button
              className="btn"
              disabled={busy || !session}
              onClick={() => void run([{ act: 'end', user, shows: '' }])}
            >
              End session
            </button>
          </div>
        </section>

        <section className="card am-store">
          <div className="am-store-head">
            <h2>{user}'s memory</h2>
            <label className="small">
              <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> show replaced
              and forgotten
            </label>
          </div>
          {memories.length === 0 && <p className="small muted">Nothing remembered yet.</p>}
          <ul className="am-memories">
            {memories.map((m) => (
              <li key={m.id} className={`am-mem am-${m.status} ${last?.cited.includes(m.id) ? 'cited' : ''}`}>
                <div className="am-mem-head">
                  <span className="mono">{m.id}</span>
                  <span className={`am-kind am-kind-${m.kind}`}>
                    {m.kind} · {m.level}
                  </span>
                  <span className="small muted">{m.subject}</span>
                  <span className="am-status small">{statusText(m)}</span>
                </div>
                <p>{m.text}</p>
                <div className="am-strength" title={`strength ${m.strength}`}>
                  <i
                    style={{ width: `${Math.min(100, (m.strength / 4) * 100)}%` }}
                    className={m.strength < (info?.forget_below ?? 0.3) ? 'weak' : ''}
                  />
                </div>
                <p className="small muted">
                  Strength {m.strength} · importance {m.importance} · used {m.uses}× · last used day {m.last_used_day}
                  {m.compression && ` · ${m.compression.from_tokens} tokens kept as ${m.compression.to_tokens}`}
                </p>
                <details className="small">
                  <summary>
                    Where it came from ({m.sources.length}){m.links.length > 0 && ` · links ${m.links.join(', ')}`}
                    {m.replaces && ` · replaces ${m.replaces}`}
                  </summary>
                  <ul>
                    {m.sources.map((s, i) => (
                      <li key={i}>
                        Session {s.session}, day {s.day}, {s.by === 'person' ? `${user} said` : 'the agent wrote'}:{' '}
                        {s.quote ? `“${s.quote}”` : '(no quote)'}
                      </li>
                    ))}
                  </ul>
                  {m.reason && <p className="muted">{m.reason}</p>}
                </details>
              </li>
            ))}
          </ul>
        </section>
      </div>

      {state && state.log.length > 0 && (
        <section className="card">
          <h2>What happened to memory</h2>
          <ol className="am-events small">
            {[...state.log].reverse().map((l, i) => (
              <li key={i}>
                <span className="mono muted">day {l.day}</span>{' '}
                <span className={`am-ev am-ev-${l.event}`}>{l.event}</span> {l.detail}
              </li>
            ))}
          </ol>
        </section>
      )}

      <section className="card">
        <h2>The fifteen building blocks, and where each happens here</h2>
        <div className="table-wrap">
          <table className="t small">
            <tbody>
              {BLOCKS.map(([name, where]) => (
                <tr key={name}>
                  <td>
                    <b>{name}</b>
                  </td>
                  <td>{where}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {info && (
          <p className="small muted">
            Rules: the profile (lasting memories of importance 2 or 3, up to {info.profile_max}) goes into every
            request; up to {info.retrieve} one-off memories and episodes go in when they share words with the message.
            Half-lives: facts {info.half_life_days.fact} days, preferences {info.half_life_days.preference}, procedures{' '}
            {info.half_life_days.procedure}, episodes {info.half_life_days.episode}. Forgotten below strength{' '}
            {info.forget_below}. Working memory: the last {info.session_window} messages of the session. The privacy
            guard is <code>python/22_memory_agent.py</code>'s.
          </p>
        )}
      </section>
    </main>
  );
}

/** What one turn did to memory: what went in, what Claude asked to keep, and what the rules decided. */
function TurnDetails({ turn }: { turn: TurnResult }) {
  return (
    <details className="am-turn small">
      <summary>
        {turn.retrieved.length} memories in · {turn.decisions.length} decisions · cited{' '}
        {turn.cited.length ? turn.cited.join(', ') : 'none'} · ${turn.cost_usd.toFixed(5)}
      </summary>
      <p>
        <b>Working memory:</b> {turn.working_memory.sent} earlier message{turn.working_memory.sent === 1 ? '' : 's'} of
        this session (up to {turn.working_memory.window}).
      </p>
      <p>
        <b>Long-term memory sent:</b>{' '}
        {turn.retrieved.length
          ? turn.retrieved.map((r) => `${r.id} (${r.why}, strength ${r.strength})`).join('; ')
          : 'none'}
      </p>
      {turn.decisions.length > 0 && (
        <ul>
          {turn.decisions.map((d, i) => (
            <li key={i}>
              <b>{d.tool}</b> {String(d.input.subject ?? '')}:{' '}
              <span className={`am-ev am-ev-${d.action}`}>{d.action}</span>
              {d.id && ` ${d.id}`}
              {d.replaces && ` (replaces ${d.replaces})`}
              {d.reason && ` — ${d.reason}`}
            </li>
          ))}
        </ul>
      )}
      {turn.faded.length > 0 && <p>Faded before this turn: {turn.faded.join(', ')}</p>}
      <details>
        <summary>The system prompt sent</summary>
        <pre>{turn.system}</pre>
      </details>
    </details>
  );
}
