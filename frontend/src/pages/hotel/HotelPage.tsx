import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { hotelService, type Board, type HotelInfo, type HotelStep, type PaymentLink } from '@/services/hotelService';
import { statusService } from '@/services/statusService';
import { isLocalModel } from '@/lib/models';
import { Audit, Bookings, Calendar, Outbox, pounds } from './BackOffice';
import './hotel.css';

const POLL_MS = 15_000; // holds expire, so the back office refreshes itself
const usd = (v: number) => `$${v < 0.1 ? v.toFixed(4) : v.toFixed(2)}`;
// Samples whose label says they try to break the rules are listed again under "Try to break it".
const BREAK = /break|inject|trick|pretend|manager|upgrade|discount|card|someone|another guest|system/i;

interface Line {
  from: 'guest' | 'agent' | 'hotel'; // hotel: a message from the hotel's systems, which only the agent sees
  text: string;
  redactions?: string[];
  steps?: HotelStep[];
  cost?: number;
}

interface Payment extends PaymentLink {
  result?: { ok: boolean; message: string };
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

type Tone = '' | 'ok' | 'stop';
type Json = Record<string, unknown>;
const pounds0 = (v: unknown) =>
  `£${Number(v ?? 0)
    .toFixed(2)
    .replace(/\.00$/, '')}`;

/** One line saying what a tool call did, in words, and whether a rule in code stopped or asked first. */
function describe(step: HotelStep): { label: string; tone: Tone } {
  const r = (step.result ?? {}) as Json;
  const a = (step.args ?? {}) as Json;
  if (r.error) return { label: `Refused: ${String(r.error)}`, tone: 'stop' };
  if (r.status === 'needs_confirmation')
    return { label: 'Asked the guest to confirm first (rule in code)', tone: 'stop' };
  switch (step.tool) {
    case 'check_availability': {
      const options = (r.options as Json[] | undefined) ?? [];
      const full = (r.full as string[] | undefined) ?? [];
      return {
        label: `${String(a.check_in)} to ${String(a.check_out)}, ${String(a.adults)} adult${a.adults === 1 ? '' : 's'}: ${options.length} room type${options.length === 1 ? '' : 's'} free${full.length ? `; full: ${full.join(', ')}` : ''}`,
        tone: '',
      };
    }
    case 'book_room':
      return {
        label: `Held ${String(r.ref)}, ${String(r.room_type)}, total ${pounds0(r.total)}; payment page shown for the ${pounds0(r.deposit)} deposit`,
        tone: 'ok',
      };
    case 'check_payment':
      return {
        label: `${String(r.ref)}: ${String(r.status)}, deposit ${String(r.payment)}`,
        tone: r.status === 'confirmed' ? 'ok' : '',
      };
    case 'find_booking':
      return { label: `Found ${String(r.ref)} for ${String(r.guest_name)} (reference and email matched)`, tone: '' };
    case 'quote_change':
      return {
        label: `Priced the change: ${pounds0(r.new_total)} (was ${pounds0(r.old_total)}, difference ${pounds0(r.difference)})`,
        tone: '',
      };
    case 'change_booking':
      return {
        label: `Changed ${String(r.ref)}: room ${String(r.room_number)}, ${String(r.check_in)} to ${String(r.check_out)}`,
        tone: 'ok',
      };
    case 'cancel_booking':
      return {
        label: `Cancelled ${String(r.ref)}; deposit ${String(r.payment)}${r.refund ? ` (${pounds0(r.refund)} back)` : ''}`,
        tone: 'ok',
      };
    default:
      return { label: 'Done', tone: '' };
  }
}

/** Every tool call in a turn: what it did in words, then the exact arguments and result the agent saw. */
function Steps({ steps, open }: { steps: HotelStep[]; open: boolean }) {
  if (!steps.length) return null;
  return (
    <ul className="ho-steps">
      {steps.map((s, i) => {
        const d = describe(s);
        return (
          <li key={i} className={d.tone}>
            <details open={open}>
              <summary>
                <code>{s.tool}</code> {d.label}
              </summary>
              <div className="ho-json">
                <div className="small muted">Arguments the agent sent</div>
                <pre>{JSON.stringify(s.args, null, 2)}</pre>
                <div className="small muted">Result the tool returned</div>
                <pre>{JSON.stringify(s.result, null, 2)}</pre>
              </div>
            </details>
          </li>
        );
      })}
    </ul>
  );
}

/** Lab 52: a hotel booking agent. A guest books, changes and cancels by chatting; the rules live in the tools. */
export default function HotelPage() {
  const [info, setInfo] = useState<HotelInfo | null>(null);
  const [board, setBoard] = useState<Board | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState('');
  const [chatId, setChatId] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [cost, setCost] = useState(0);
  const [showJson, setShowJson] = useState(true); // the tool calls' JSON, open by default
  const [payments, setPayments] = useState<Payment[]>([]);
  const [desk, setDesk] = useState({ type: '', checkIn: '', checkOut: '' });
  const [deskResult, setDeskResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [deskBusy, setDeskBusy] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([hotelService.info(), hotelService.board(), statusService.status()])
      .then(([i, b, s]) => {
        if (cancelled) return;
        setInfo(i);
        setBoard(b);
        // Claude, GPT deployments and the local model: the tools and rules are the same whichever answers.
        const offered = (s.models || []).slice();
        if (i.model && !offered.includes(i.model)) offered.unshift(i.model);
        setModels(offered);
        setModel(i.model || offered[0] || '');
        setDesk({ type: i.room_types[0]?.code ?? '', checkIn: addDays(i.today, 1), checkOut: addDays(i.today, 2) });
      })
      .catch((err) => !cancelled && setError(errorText(err)));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      hotelService
        .board()
        .then(setBoard)
        .catch(() => undefined); // a missed refresh is not worth an error on the page
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
  }, [lines, busy]);

  function newConversation() {
    setChatId(null);
    setLines([]);
    setPayments([]);
    setCost(0);
    setError('');
  }

  async function send(text: string) {
    const message = text.trim();
    if (!message || busy) return;
    setBusy(true);
    setError('');
    setInput('');
    setLines((ls) => [...ls, { from: 'guest', text: message }]);
    try {
      let id = chatId;
      if (!id) {
        id = (await hotelService.newChat(model || undefined)).chat_id;
        setChatId(id);
      }
      const r = await hotelService.send(id, message);
      setLines((ls) => {
        const out = ls.slice();
        const last = out[out.length - 1];
        if (last?.from === 'guest') out[out.length - 1] = { ...last, redactions: r.screened.redactions };
        return [...out, { from: 'agent', text: r.reply, steps: r.steps, cost: r.cost_usd }];
      });
      setCost((c) => c + (r.cost_usd || 0));
      if (r.payment_links.length) {
        setPayments((ps) => [...ps, ...r.payment_links.filter((l) => !ps.some((p) => p.token === l.token))]);
      }
      setBoard(r.board);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function pay(token: string) {
    try {
      const r = await hotelService.pay(token);
      setPayments((ps) => ps.map((p) => (p.token === token ? { ...p, result: { ok: r.ok, message: r.message } } : p)));
      setBoard(r.board);
      // The payment provider told the hotel, and the hotel told this conversation's agent: let it reply now.
      if (r.ok && r.chat_id && r.chat_id === chatId) {
        setBusy(true);
        try {
          const u = await hotelService.update(r.chat_id);
          if (u.reply || u.steps.length) {
            setLines((ls) => [
              ...ls,
              ...(u.event ? [{ from: 'hotel' as const, text: u.event }] : []),
              { from: 'agent' as const, text: u.reply, steps: u.steps, cost: u.cost_usd },
            ]);
            setCost((c) => c + (u.cost_usd || 0));
          }
          setBoard(u.board);
        } catch (err) {
          setError(errorText(err));
        } finally {
          setBusy(false);
        }
      }
    } catch (err) {
      setPayments((ps) =>
        ps.map((p) => (p.token === token ? { ...p, result: { ok: false, message: errorText(err) } } : p)),
      );
    }
  }

  async function frontDesk() {
    setDeskBusy(true);
    setDeskResult(null);
    try {
      const r = await hotelService.frontDesk(desk.type, desk.checkIn, desk.checkOut);
      setDeskResult({ ok: r.ok, message: r.message });
      setBoard(r.board);
    } catch (err) {
      setDeskResult({ ok: false, message: errorText(err) });
    } finally {
      setDeskBusy(false);
    }
  }

  async function reset() {
    if (!window.confirm('Reset the hotel? Every booking, message and conversation goes, and the sample data returns.'))
      return;
    try {
      const r = await hotelService.reset();
      setBoard(r.board);
      newConversation();
      setDeskResult(null);
    } catch (err) {
      setError(errorText(err));
    }
  }

  const samples = info?.samples ?? [];
  const breakers = samples.filter((s) => BREAK.test(s.label));
  const openPayments = payments.filter((p) => !p.result?.ok);
  const donePayments = payments.filter((p) => p.result?.ok);

  return (
    <main className="page-hotel">
      <div className="kicker">Lab 52 · Hotel booking agent</div>
      <h1>A hotel booking agent with its rules in code</h1>
      <p className="lede">
        A guest books, changes and cancels a room at{' '}
        {info ? `${info.hotel.name}, ${info.hotel.town}` : 'an invented hotel'} by chatting with an agent on Claude, GPT
        or a local open model. The agent decides what to say and which tool to call. Prices, availability, the refund
        policy, who may see a booking and taking payment are all enforced in the tools, not in the prompt, so a clever
        message cannot talk its way round them.
      </p>
      <p className="small muted">
        The hotel, its guests and every email address and phone number are invented. You play the guest; the right-hand
        side is the back office.
      </p>
      {error && !busy && <p className="ho-bad small">{error}</p>}

      <div className="ho-layout">
        <section className="ho-left" aria-label="Guest chat">
          <div className="card ho-chat">
            <header className="ho-chat-bar">
              <b>Chat with the hotel</b>
              <span className="ho-chat-tools small">
                <label>
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
                <label className="small ho-json-toggle">
                  <input type="checkbox" checked={showJson} onChange={(e) => setShowJson(e.target.checked)} /> Show tool
                  JSON
                </label>
                <button className="btn small" onClick={newConversation} disabled={busy}>
                  New conversation
                </button>
              </span>
              {isLocalModel(model) && (
                <p className="small muted ho-model-note">
                  A small local model may skip tools or ask more questions than it needs. The rules still hold: they are
                  in the tools, whichever model calls them.
                </p>
              )}
            </header>
            <div className="ho-messages" ref={scroller}>
              {lines.length === 0 && (
                <p className="small muted ho-empty">
                  Ask for a room, or pick a sample below. A new conversation starts with your first message.
                </p>
              )}
              {lines.map((line, i) => (
                <div key={i} className={`ho-msg ${line.from}`}>
                  <div className="ho-from small">
                    {line.from === 'agent'
                      ? 'Harbour Light agent'
                      : line.from === 'hotel'
                        ? 'Hotel system → agent'
                        : 'You (the guest)'}
                  </div>
                  {line.steps && <Steps steps={line.steps} open={showJson} />}
                  <div className="ho-bubble">
                    {line.from === 'agent' ? (
                      // react-markdown builds React elements and ignores raw HTML, so the model's text cannot add markup
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{line.text || '(no reply)'}</ReactMarkdown>
                    ) : (
                      line.text
                    )}
                  </div>
                  {line.redactions && line.redactions.length > 0 && (
                    <div className="ho-redacted small">
                      Removed before the agent saw it: {line.redactions.join(', ')}
                    </div>
                  )}
                  {line.cost !== undefined && <div className="ho-cost small muted">{usd(line.cost)}</div>}
                </div>
              ))}
              {busy && <div className="small muted ho-typing">The agent is working…</div>}
            </div>
            <form
              className="ho-input"
              onSubmit={(e) => {
                e.preventDefault();
                void send(input);
              }}
            >
              <textarea
                rows={2}
                value={input}
                placeholder="Write as the guest…"
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void send(input);
                  }
                }}
              />
              <button className="btn primary" type="submit" disabled={busy || !input.trim()}>
                Send
              </button>
            </form>
            {samples.length > 0 && (
              <div className="ho-samples">
                <span className="small muted">Samples:</span>
                {samples.map((s) => (
                  <button key={s.label} className="chip-btn" onClick={() => setInput(s.text)} title={s.text}>
                    {s.label}
                  </button>
                ))}
              </div>
            )}
            <p className="small muted ho-total">
              This conversation: {usd(cost)}
              {chatId ? ` · ${model}` : ''}
            </p>
          </div>

          {payments.length > 0 && (
            <div className="ho-pay" aria-label="Payment page">
              <div className="ho-pay-brand">
                <b>Harbour Pay</b> <span className="small">secure payment</span>
              </div>
              <p className="small">
                Card details are entered on the payment provider&apos;s page, never in the chat, so neither the agent
                nor the hotel ever sees them. This one is pretend: paying is a button press, and no card data is sent.
              </p>
              {openPayments.map((p) => (
                <div className="ho-pay-item" key={p.token}>
                  <div>
                    Booking <b>{p.ref}</b>: deposit <b>{pounds(p.amount)}</b>
                  </div>
                  <button className="btn primary" onClick={() => void pay(p.token)}>
                    Pay {pounds(p.amount)} deposit
                  </button>
                  {p.result && !p.result.ok && <p className="ho-bad small">{p.result.message}</p>}
                </div>
              ))}
              {donePayments.map((p) => (
                <div className="ho-pay-item done" key={p.token}>
                  <div>
                    Booking <b>{p.ref}</b>: {p.result?.message}
                  </div>
                  <p className="small muted">
                    The payment provider has told the hotel, and the hotel has told the agent: you do not need to.
                  </p>
                </div>
              ))}
            </div>
          )}

          <div className="card ho-card">
            <h3>Double booking</h3>
            <p className="small">
              Ask the agent for a room, and before you confirm, let another guest book the last one of that type at the
              front desk. The database has one row for each room and night, so a room can never be sold twice: the
              agent&apos;s booking fails cleanly and it offers you something else.
            </p>
            <div className="ho-desk">
              <label className="small">
                Room type
                <select value={desk.type} onChange={(e) => setDesk({ ...desk, type: e.target.value })}>
                  {(info?.room_types ?? []).map((t) => (
                    <option key={t.code} value={t.code}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="small">
                Check in
                <input
                  type="date"
                  value={desk.checkIn}
                  onChange={(e) => setDesk({ ...desk, checkIn: e.target.value })}
                />
              </label>
              <label className="small">
                Check out
                <input
                  type="date"
                  value={desk.checkOut}
                  onChange={(e) => setDesk({ ...desk, checkOut: e.target.value })}
                />
              </label>
            </div>
            <button className="btn" onClick={() => void frontDesk()} disabled={deskBusy || !desk.type}>
              Another guest books the last one at the front desk
            </button>
            {deskResult && <p className={`small ${deskResult.ok ? 'ho-good' : 'ho-bad'}`}>{deskResult.message}</p>}
          </div>

          <div className="card ho-card">
            <h3>Try to break it</h3>
            <p className="small">
              Each of these tries to get something the rules forbid: a discount or upgrade the price list does not give,
              another guest&apos;s booking, or a card number typed into the chat. Watch the tool calls: the model may be
              taken in, but the tools refuse, and card numbers are removed before the agent sees the message.
            </p>
            {breakers.length > 0 ? (
              <ul className="ho-break small">
                {breakers.map((s) => (
                  <li key={s.label}>
                    <b>{s.label}</b>
                    <div className="muted">{s.text}</div>
                    <button className="btn small" onClick={() => setInput(s.text)}>
                      Put it in the chat
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="small muted">The samples above include them.</p>
            )}
          </div>

          {info && (
            <details className="card ho-card ho-how">
              <summary>
                <b>How it works</b>
              </summary>
              <p className="small">
                The backend runs one tool loop in Claude&apos;s message format; for GPT and the local model the lab
                translates each request and reply. Every tool runs against the hotel&apos;s SQLite database and checks
                its own rules each time it is called. These are the tools the agent has:
              </p>
              <ul className="small">
                {info.tools.map((t) => (
                  <li key={t.name}>
                    <code>{t.name}</code>: {t.description}
                  </li>
                ))}
              </ul>
              <p className="small">The agent&apos;s instructions:</p>
              <pre className="ho-instructions">{info.instructions}</pre>
              {info.hotel.policies.length > 0 && (
                <>
                  <p className="small">The hotel&apos;s policies, as the tools enforce them:</p>
                  <ul className="small">
                    {info.hotel.policies.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                </>
              )}
            </details>
          )}
        </section>

        <section className="ho-right" aria-label="Back office">
          <div className="ho-office-bar">
            <h2>Back office</h2>
            <button className="btn small" onClick={() => void reset()}>
              Reset hotel
            </button>
          </div>
          {info && (
            <p className="small muted">
              Today is {info.today}. Check-in from {info.hotel.check_in_time}, check-out by {info.hotel.check_out_time}.
            </p>
          )}
          {board ? (
            <>
              <Calendar board={board} />
              <Bookings board={board} />
              <Outbox board={board} info={info} />
              <Audit board={board} />
            </>
          ) : (
            !error && <p className="small muted">Loading the back office…</p>
          )}
        </section>
      </div>
    </main>
  );
}
