import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { statusService } from '@/services/statusService';
import {
  supportDeskService,
  type ChatReply,
  type ChoiceResult,
  type EvalEvent,
  type EvalResult,
  type EvalSummary,
  type SelectionResult,
  type SupportInfo,
  type Switches,
  type TraceItem,
} from '@/services/supportDeskService';
import './support-desk.css';

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const usd = (v: number) => `$${v < 0.1 ? v.toFixed(4) : v.toFixed(2)}`;
const pct = (v: number | null | undefined) => (v === null || v === undefined ? '–' : `${Math.round(v * 100)}%`);
const json = (v: unknown) => JSON.stringify(v);
const short = (v: unknown, n = 260) => {
  const s = typeof v === 'string' ? v : json(v);
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

const DEFAULTS: Switches = {
  enforce_gate: true,
  hooks: true,
  trim: true,
  case_facts: true,
  vague_tools: false,
  dangerous_tool: false,
};

const OUTCOME: Record<string, string> = {
  resolved: 'Resolved',
  escalated: 'Escalated',
  asked_identifier: 'Asked for an identifier',
  unresolved: 'Unresolved',
};

type ToolItem = Extract<TraceItem, { kind: 'tool' }>;
const toolItems = (reply: ChatReply | null): ToolItem[] =>
  (reply?.trace.filter((t) => t.kind === 'tool') ?? []) as ToolItem[];

/** The trace of one run: each model turn, the decision the loop took on its stop_reason, each tool call and result. */
function Trace({ trace }: { trace: TraceItem[] }) {
  return (
    <ol className="sd-trace">
      {trace.map((t, i) => {
        if (t.kind === 'user')
          return (
            <li key={i} className="sd-user">
              <span className="sd-who">Customer</span>
              {t.text}
            </li>
          );
        if (t.kind === 'model')
          return (
            <li key={i} className="sd-model">
              <span className="sd-who">Model turn {t.iteration}</span>
              <span className="mono small">stop_reason: {t.stop_reason}</span>{' '}
              <span className="sd-pill">{t.decision}</span>
              {t.text && <div className="sd-text">{t.text}</div>}
              {t.tool_uses.map((u) => (
                <div key={u.id} className="mono small">
                  tool_use {u.name}({short(u.input, 200)})
                </div>
              ))}
              <div className="small muted">
                {t.input_tokens} in, {t.output_tokens} out, {usd(t.cost_usd)}
              </div>
            </li>
          );
        if (t.kind === 'tool')
          return (
            <li key={i} className={`sd-tool${t.result.isError ? ' err' : ''}${t.dangerous ? ' danger' : ''}`}>
              <span className="sd-who">Tool</span>
              <span className="mono small">
                {t.name}({short(t.input, 200)})
              </span>
              {t.blocked_by && (
                <span className="sd-pill bad">
                  blocked by {t.blocked_by === 'gate' ? 'the gate' : 'the pre-tool hook'}
                </span>
              )}
              {t.result.isError && !t.blocked_by && <span className="sd-pill bad">isError</span>}
              {t.dangerous && <span className="sd-pill bad">dangerous tool ran</span>}
              <div className="mono small sd-result">{short(t.result.structuredContent, 360)}</div>
              {t.changes.length > 0 && (
                <div className="small muted">
                  The post-tool hook changed {t.changes.length} values before the model saw them.
                </div>
              )}
              {t.raw_tokens > t.context_tokens && (
                <div className="small muted">
                  Context: about {t.raw_tokens} tokens from the tool, {t.context_tokens} kept.
                </div>
              )}
              {t.audit && <div className="small mono">{t.audit} (written after the account was already gone)</div>}
            </li>
          );
        return (
          <li key={i} className="sd-tool err">
            <b>{t.message}</b>
          </li>
        );
      })}
    </ol>
  );
}

function Pill({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return <span className={`sd-pill ${ok ? 'good' : 'bad'}`}>{children}</span>;
}

export default function SupportDeskPage() {
  const [info, setInfo] = useState<SupportInfo | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState('');
  const [sw, setSw] = useState<Switches>(DEFAULTS);
  const [error, setError] = useState('');

  const [message, setMessage] = useState('');
  const [caseId, setCaseId] = useState<string | null>(null);
  const [turns, setTurns] = useState<{ user: string; reply: ChatReply }[]>([]);
  const [busy, setBusy] = useState('');
  const [spent, setSpent] = useState(0);

  const [selection, setSelection] = useState<Record<string, SelectionResult>>({});
  const [choice, setChoice] = useState<ChoiceResult | null>(null);
  const [choiceMessage, setChoiceMessage] = useState('');

  const [results, setResults] = useState<EvalResult[]>([]);
  const [summary, setSummary] = useState<EvalSummary | null>(null);
  const [evalStep, setEvalStep] = useState('');
  const [evalCost, setEvalCost] = useState(0);
  const [evalNote, setEvalNote] = useState('');
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    Promise.all([supportDeskService.info(), statusService.status()])
      .then(([i, s]) => {
        setInfo(i);
        setChoiceMessage(i.choice_message);
        const offered = s.models || [];
        setModels(offered);
        setModel(s.default_model || offered[0] || '');
      })
      .catch((err) => setError(errorText(err)));
    return () => abort.current?.abort();
  }, []);

  const last = turns.length ? turns[turns.length - 1].reply : null;
  const tools = useMemo(() => toolItems(last), [last]);
  const flip = (k: keyof Switches) => setSw((s) => ({ ...s, [k]: !s[k] }));

  async function send(text: string, fresh: boolean) {
    const t = text.trim();
    if (!t || busy) return;
    setBusy('chat');
    setError('');
    try {
      const reply = await supportDeskService.chat(t, model, sw, fresh ? null : caseId);
      setCaseId(reply.case_id);
      setTurns((p) => [...(fresh ? [] : p), { user: t, reply }]);
      setSpent((s) => s + reply.cost_usd);
      setMessage('');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy('');
    }
  }

  async function select(vague: boolean) {
    setBusy('select');
    setError('');
    try {
      const r = await supportDeskService.toolSelection(model, vague, sw.dangerous_tool);
      setSelection((s) => ({ ...s, [r.set]: r }));
      setSpent((s) => s + r.cost_usd);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy('');
    }
  }

  async function runChoice() {
    setBusy('choice');
    setError('');
    try {
      const r = await supportDeskService.toolChoice(model, choiceMessage);
      setChoice(r);
      setSpent((s) => s + r.cost_usd);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy('');
    }
  }

  async function runAll() {
    if (busy) return;
    setBusy('eval');
    setError('');
    setResults([]);
    setSummary(null);
    setEvalNote('');
    setEvalCost(0);
    abort.current = new AbortController();
    try {
      await supportDeskService.evaluate(
        model,
        sw,
        (e: EvalEvent) => {
          if (e.type === 'progress') setEvalStep(e.step);
          else if (e.type === 'case') {
            setResults((r) => [...r, e.result]);
            setEvalCost(e.spent_usd);
          } else if (e.type === 'done') {
            setSummary(e.summary);
            setEvalNote(e.stopped ?? '');
            setEvalCost(e.cost_usd);
            setSpent((s) => s + e.cost_usd);
          } else if (e.type === 'error') setError(e.message);
        },
        abort.current.signal,
      );
    } catch (err) {
      if ((err as Error).name !== 'AbortError') setError(errorText(err));
    } finally {
      setEvalStep('');
      setBusy('');
    }
  }

  const tryIt = (label: string, text: string) => (
    <button key={label} className="btn small" disabled={!!busy || !model} onClick={() => send(text, true)}>
      {label}
    </button>
  );
  const example = (label: string) => info?.examples.find((e) => e.label === label)?.message ?? '';
  const handoffs = tools.filter((t) => t.name === 'escalate_to_human' && !t.result.isError);
  const errored = tools.filter((t) => t.result.isError);
  const changed = tools.flatMap((t) => t.changes);

  return (
    <main className="page-support-desk">
      <div className="kicker">Agents · Architect exam scenario 1</div>
      <h1>Support desk agent</h1>
      <p className="lede">
        A support agent for an invented shop, {info?.shop ?? 'Larkfield Home Goods'}. It has four tools, shaped like MCP
        tools, and aims to settle most requests in one contact while knowing when to hand over to a person. Each
        mechanism below actually runs, and each has a switch, so you can turn it off and see what it was doing. The
        agent loop is in our code, on the Claude Messages API. See <Link to="/red-team">red team</Link> for attacks on a
        similar agent.
      </p>

      <section className="card sd-bar">
        <label className="small">
          Model{' '}
          <select value={model} onChange={(e) => setModel(e.target.value)}>
            {models.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
        </label>
        <div className="sd-switches small">
          <label>
            <input type="checkbox" checked={sw.enforce_gate} onChange={() => flip('enforce_gate')} /> Gate in code
          </label>
          <label>
            <input type="checkbox" checked={sw.hooks} onChange={() => flip('hooks')} /> Hooks (refund limit and
            normalising)
          </label>
          <label>
            <input type="checkbox" checked={sw.trim} onChange={() => flip('trim')} /> Trim order records
          </label>
          <label>
            <input type="checkbox" checked={sw.case_facts} onChange={() => flip('case_facts')} /> Case facts block
          </label>
          <label>
            <input type="checkbox" checked={sw.vague_tools} onChange={() => flip('vague_tools')} /> Vague tool set
          </label>
          <label>
            <input type="checkbox" checked={sw.dangerous_tool} onChange={() => flip('dangerous_tool')} /> Add
            delete_account
          </label>
        </div>
        <div className="small muted">
          Spent on this page: {usd(spent)}. Every call is charged to the server's budget.
        </div>
        {error && <p className="sd-bad small">{error}</p>}
      </section>

      {info && (
        <section className="card">
          <h2>The shop</h2>
          <p className="small">
            Invented customers and orders. Refunds are allowed up to ${info.refund_limit_usd} on a delivered order
            within {info.refund_window_days} days of delivery. The shop's date is fixed at {info.today}. Nothing is
            really refunded or deleted.
          </p>
          <div className="table-wrap">
            <table className="t small">
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Email</th>
                  <th>Postcode</th>
                  <th>Orders</th>
                </tr>
              </thead>
              <tbody>
                {info.customers.map((c) => (
                  <tr key={c.id}>
                    <td>
                      {c.name} <span className="muted">{c.id}</span>
                    </td>
                    <td className="mono">{c.email}</td>
                    <td className="mono">{c.postcode}</td>
                    <td className="mono">{c.orders.join(', ') || 'none'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="card" id="loop">
        <h2>1. The agent loop</h2>
        <p className="small">
          Our code sends the history and reads <span className="mono">stop_reason</span>. On{' '}
          <span className="mono">tool_use</span> it runs the tools, appends the results to the history and calls again.
          On <span className="mono">end_turn</span> it stops. Nothing else decides when the work is finished.
        </p>
        <ul className="small">
          <li>
            <b>Anti-pattern: parsing the reply for "done".</b> Wording changes between models and between runs. The stop
            reason is the contract.
          </li>
          <li>
            <b>Anti-pattern: using the iteration cap as the plan.</b> The cap ({info?.max_iterations ?? 8} turns) is
            only a safety stop for a runaway loop. A run that hits it is a bug to look at, not a normal ending.
          </li>
        </ul>
        <div className="sd-row">
          <span className="small muted">Try:</span>
          {info?.examples.map((e) => tryIt(e.label, e.message))}
        </div>
        <div className="sd-chat">
          <textarea
            rows={3}
            value={message}
            placeholder="Chat as a customer. Use an email from the table above."
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(message, false);
            }}
          />
          <div className="sd-row">
            <button
              className="btn primary"
              disabled={!!busy || !model || !message.trim()}
              onClick={() => send(message, false)}
            >
              {busy === 'chat' ? 'Working…' : caseId ? 'Send in this case' : 'Send'}
            </button>
            <button
              className="btn"
              disabled={!!busy}
              onClick={() => {
                setCaseId(null);
                setTurns([]);
              }}
            >
              New case
            </button>
            {last && (
              <span className="small muted">
                Case {last.case_id}, outcome from the tools: <b>{OUTCOME[last.outcome]}</b>
              </span>
            )}
          </div>
        </div>
        {turns.map((t, i) => (
          <div key={i} className="sd-turn">
            <Trace trace={t.reply.trace} />
            <div className="sd-reply">
              <span className="sd-who">Agent to customer</span>
              {t.reply.reply || <i className="muted">(no text)</i>}
            </div>
            <div className="small muted">
              {t.reply.iterations} model turns, ended on stop_reason {t.reply.stop_reason}, {usd(t.reply.cost_usd)}.
              {t.reply.stopped && <b className="sd-bad"> {t.reply.stopped}</b>}
            </div>
          </div>
        ))}
      </section>

      <section className="card" id="gate">
        <h2>2. A prerequisite enforced in code</h2>
        <p className="small">
          <span className="mono">process_refund</span>, and any look-up of orders, is refused by our code until{' '}
          <span className="mono">get_customer</span> has returned a verified customer id in this conversation. Once
          verified, only that customer's orders are reachable, and "not found" and "someone else's" give the same
          answer, so order ids cannot be probed. The refusal is a structured permission error that names the missing
          step, so the model can recover.
        </p>
        <p className="small">
          <b>Against a prompt-only rule.</b> The system prompt also says "verify first". A prompt is a request, and a
          model follows it nearly always, not always. A customer who pushes, or a long conversation, can get it skipped,
          and a skipped step on a refund is money. A code gate holds every time, so the prompt rule is there for good
          behaviour and the gate is there for the guarantee. Untick "Gate in code" above and try the unverified refund
          to see the prompt on its own.
        </p>
        <div className="sd-row">
          {tryIt('Refund without verifying', example('Refund without verifying'))}
          {tryIt("Someone else's order", example("Someone else's order"))}
        </div>
        {last && tools.some((t) => t.blocked_by === 'gate' || t.name === 'process_refund') && (
          <ul className="small">
            {tools
              .filter((t) => t.name === 'process_refund' || t.blocked_by === 'gate')
              .map((t, i) => (
                <li key={i}>
                  <span className="mono">
                    {t.name}({short(t.input, 120)})
                  </span>
                  : {t.blocked_by === 'gate' ? 'refused by the gate. ' : ''}
                  {short(t.result.structuredContent, 220)}
                </li>
              ))}
          </ul>
        )}
      </section>

      <section className="card" id="hooks">
        <h2>3. Hooks around every tool call</h2>
        <p className="small">
          <b>Pre-tool hook.</b> Before <span className="mono">process_refund</span> runs, code checks the amount. Above
          ${info?.refund_limit_usd ?? 500} the call does not run. The hook returns a permission error that says to use{' '}
          <span className="mono">escalate_to_human</span> and gives the reason, and the model follows it. This is a
          deterministic rule, not a request. It is also how you stop a destructive action: the model can ask, the hook
          decides.
        </p>
        <p className="small">
          <b>Post-tool hook.</b> The order system returns Unix timestamps, ISO 8601 strings, day/month/year strings like{' '}
          <span className="mono">03/11/2026</span>, and status codes like <span className="mono">3</span>. Before the
          model sees a result, code turns them all into ISO dates and words. Without it the model has to guess whether{' '}
          <span className="mono">03/11/2026</span> is March or November, and the refund window depends on the answer.
        </p>
        <div className="sd-row">
          {tryIt('Refund over $500', info?.eval_cases.find((c) => c.id === 'over_limit')?.message ?? '')}
          {tryIt('Refund and another order', info?.eval_cases.find((c) => c.id === 'two_orders')?.message ?? '')}
        </div>
        {info && (
          <>
            <h3>Raw against normalised {changed.length ? '(from the last run)' : '(order LF-2001, no run needed)'}</h3>
            <div className="table-wrap">
              <table className="t small">
                <thead>
                  <tr>
                    <th>Field</th>
                    <th>Order system sent</th>
                    <th>Model sees</th>
                  </tr>
                </thead>
                <tbody>
                  {(changed.length ? changed : info.context.changes)
                    .filter((c) => /status|_on$|_at$/.test(c.field))
                    .slice(0, 12)
                    .map((c, i) => (
                      <tr key={i}>
                        <td className="mono">{c.field}</td>
                        <td className="mono">{json(c.raw)}</td>
                        <td className="mono">{json(c.normalised)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        {tools.some((t) => t.blocked_by === 'pre_hook') && (
          <p className="small">
            <Pill ok={false}>blocked</Pill> In the last run the pre-tool hook stopped a refund and pointed the model at
            escalation.
          </p>
        )}
      </section>

      <section className="card" id="errors">
        <h2>4. Structured tool errors</h2>
        <p className="small">
          A tool that fails returns <span className="mono">isError: true</span> with an{' '}
          <span className="mono">errorCategory</span>, <span className="mono">isRetryable</span> and a message safe to
          read to the customer. The category tells the agent what to do next. A plain "something went wrong" tells it
          nothing, and it will either give up or retry something that can never work.
        </p>
        <div className="table-wrap">
          <table className="t small">
            <thead>
              <tr>
                <th>Category</th>
                <th>Retry?</th>
                <th>Example here</th>
                <th>What the agent should do</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="mono">transient</td>
                <td>Yes</td>
                <td>The order system times out once (order LF-2006)</td>
                <td>Call again</td>
              </tr>
              <tr>
                <td className="mono">validation</td>
                <td>After a fix</td>
                <td>Bad amount, or an order id not on the account</td>
                <td>Correct the input or ask the customer</td>
              </tr>
              <tr>
                <td className="mono">business</td>
                <td>No</td>
                <td>Refund window closed (order LF-2008)</td>
                <td>Explain the rule plainly</td>
              </tr>
              <tr>
                <td className="mono">permission</td>
                <td>No</td>
                <td>Not verified yet, or a refund over the limit</td>
                <td>Do the missing step, or escalate</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="small">
          <b>An empty result is not an error.</b> A customer with no orders returns{' '}
          <span className="mono">isError: false</span> with an empty list and the message "This customer has no orders."
          The look-up worked, and the answer is "none". If that were an error, the agent would retry or apologise for a
          fault that is not there.
        </p>
        <div className="sd-row">
          {tryIt('Order system outage', example('Order system outage'))}
          {tryIt('Refund window closed', example('Refund window closed'))}
          {tryIt('No orders', example('No orders'))}
        </div>
        {errored.length > 0 && (
          <ul className="small">
            {errored.map((t, i) => (
              <li key={i}>
                <span className="mono">{t.name}</span>: {short(t.result.structuredContent, 260)}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card" id="tools">
        <h2>5. Tool descriptions, and least privilege</h2>
        <p className="small">
          The model chooses a tool from its name and description. Two near-identical tools with thin descriptions (
          <span className="mono">check_order</span> and <span className="mono">lookup_order</span>) leave it guessing,
          and it will split its calls between them. The clear set has one order tool, and each description says what it
          returns, when to use it and when not to. The test below sends six fixed requests with{' '}
          <span className="mono">tool_choice: any</span>, so the model must pick a tool, and records which one it calls
          first. Results vary a little between runs.
        </p>
        {info && (
          <div className="sd-cols">
            <div>
              <h3>Vague set</h3>
              <ul className="small">
                {info.tools.vague.map((t) => (
                  <li key={t.name}>
                    <span className="mono">{t.name}</span>: {t.description}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h3>Clear set</h3>
              <ul className="small">
                {info.tools.clear.map((t) => (
                  <li key={t.name}>
                    <span className="mono">{t.name}</span>: {short(t.description, 150)}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
        <label className="small sd-block">
          <input type="checkbox" checked={sw.dangerous_tool} onChange={() => flip('dangerous_tool')} /> Add an unneeded{' '}
          <span className="mono">delete_account</span> tool to both sets (also used in the chat above)
        </label>
        <div className="sd-row">
          <button
            className="btn primary"
            disabled={!!busy || !model}
            onClick={() => select(true).then(() => select(false))}
          >
            {busy === 'select' ? 'Running…' : 'Run the selection test on both sets'}
          </button>
        </div>
        <div className="sd-cols">
          {(['vague', 'clear'] as const).map(
            (k) =>
              selection[k] && (
                <div key={k}>
                  <h3>
                    {k === 'vague' ? 'Vague set' : 'Clear set'}: {selection[k].correct} of {selection[k].total} correct
                  </h3>
                  <div className="table-wrap">
                    <table className="t small">
                      <thead>
                        <tr>
                          <th>Request</th>
                          <th>Expected</th>
                          <th>Called first</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selection[k].rows.map((r, i) => (
                          <tr key={i}>
                            <td>{r.message}</td>
                            <td className="mono">{r.expect}</td>
                            <td>
                              <span className="mono">{r.called ?? 'none'}</span>{' '}
                              <Pill ok={r.correct}>
                                {r.correct ? 'right' : r.dangerous ? 'dangerous' : r.overlap ? 'overlap' : 'misrouted'}
                              </Pill>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ),
          )}
        </div>
        <h3>Least privilege</h3>
        <p className="small">
          The support agent has no reason to delete accounts. If the tool is on the list, the model can call it, whether
          from a mistake, a persuasive customer or an injected instruction. With the box ticked, the seventh request
          asks the agent to "make my account disappear". A person should decide that, and a model with the tool in reach
          may not wait for one. <b>Removing the tool beats logging its use</b>: a log line is written after the account
          is gone, and it tells you what happened, not that it was allowed to. A tool that is not in the request cannot
          be called at all. Grant each agent the few tools its job needs.
        </p>
        {tools.some((t) => t.dangerous) && (
          <p className="small sd-bad">In the last chat run, delete_account ran. The audit line came afterwards.</p>
        )}
      </section>

      <section className="card" id="tool-choice">
        <h2>6. tool_choice</h2>
        <p className="small">
          One request, three settings. <span className="mono">auto</span> lets the model reply in text or call a tool.{' '}
          <span className="mono">any</span> forces a tool call but leaves the choice to the model. A forced{' '}
          <span className="mono">{'{"type":"tool","name":"get_customer"}'}</span> makes that exact call. Forcing fits a
          fixed first step, such as always verifying first. It does not fit a whole loop: a forced call every turn never
          ends, so the loop here uses it, if at all, only on the first call.
        </p>
        <textarea rows={2} value={choiceMessage} onChange={(e) => setChoiceMessage(e.target.value)} />
        <div className="sd-row">
          <button className="btn primary" disabled={!!busy || !model || !choiceMessage.trim()} onClick={runChoice}>
            {busy === 'choice' ? 'Running…' : 'Run auto, any and forced'}
          </button>
        </div>
        {choice && (
          <div className="sd-cols three">
            {choice.runs.map((r) => (
              <div key={r.mode} className="sd-mini">
                <h3 className="mono">{r.mode}</h3>
                <div className="small mono muted">{json(r.tool_choice)}</div>
                <div className="small">stop_reason: {r.stop_reason}</div>
                {r.text && <div className="small sd-text">{short(r.text, 300)}</div>}
                {r.tool_calls.map((c, i) => (
                  <div key={i} className="small mono">
                    tool_use {c.name}({short(c.input, 160)})
                  </div>
                ))}
                {!r.tool_calls.length && <div className="small muted">No tool call.</div>}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="card" id="escalation">
        <h2>7. Escalation rules and the handoff</h2>
        <p className="small">The system prompt carries the rules and a few worked examples:</p>
        <ul className="small">
          <li>
            <b>The customer asks for a person:</b> escalate at once. Do not try to resolve it first.
          </li>
          <li>
            <b>Policy is silent</b> (a competitor price match): escalate. Do not invent a policy.
          </li>
          <li>
            <b>Several customers match:</b> ask for another identifier, such as the email or postcode. Do not guess, and
            do not escalate.
          </li>
          <li>
            <b>Frustration alone is not a trigger:</b> apologise, resolve what you can, and offer a person only if that
            does not settle it. Sentiment is a poor signal. A calm customer can have a case only a person can handle,
            and an angry one can have a simple question.
          </li>
        </ul>
        <details className="sd-details">
          <summary>Show the system prompt</summary>
          <pre>{info?.system_prompt}</pre>
        </details>
        <p className="small">
          The person who picks up an escalation <b>cannot see the transcript</b>, so the handoff is structured: customer
          id, issue, root cause, amount, what was tried and a recommended action. The model fills the fields it knows.
          Code adds the rest, such as the tool log, from what it saw.
        </p>
        <div className="sd-row">
          {tryIt('Asks for a person', example('Asks for a person'))}
          {tryIt('Price match', example('Price match'))}
          {tryIt('Refund over $500', info?.eval_cases.find((c) => c.id === 'over_limit')?.message ?? '')}
          {tryIt('Several customers', info?.eval_cases.find((c) => c.id === 'several')?.message ?? '')}
          {tryIt('Angry, simple', info?.eval_cases.find((c) => c.id === 'angry')?.message ?? '')}
        </div>
        {handoffs.map((t, i) => (
          <pre key={i} className="sd-json">
            {JSON.stringify((t.result.structuredContent as { handoff?: unknown }).handoff, null, 2)}
          </pre>
        ))}
        {last && !handoffs.length && (
          <p className="small muted">The last run made no handoff: outcome {OUTCOME[last.outcome]}.</p>
        )}
      </section>

      <section className="card" id="context">
        <h2>8. Case facts and trimming</h2>
        <p className="small">
          Two habits keep a long conversation accurate. First, code keeps a <b>case facts</b> block outside the history:
          the customer, order ids, amounts, dates, statuses, refunds and what the customer asked for. It is rebuilt from
          tool results and sent with every turn, so a fact does not get lost in the middle of a long history or
          rewritten by summarising. Second, a verbose order record is <b>trimmed</b> to the fields that matter before it
          enters the context.
        </p>
        {info && (
          <div className="sd-compare">
            <div>
              <b>{info.context.fields_raw} fields</b>, about {info.context.tokens_raw} tokens
              <pre className="sd-json small">{short(info.context.raw, 520)}</pre>
            </div>
            <div>
              <b>{info.context.fields_trimmed} fields</b>, about {info.context.tokens_trimmed} tokens
              <pre className="sd-json small">{JSON.stringify(info.context.trimmed, null, 2)}</pre>
              <div className="small muted">
                Token counts are estimates at four characters a token. That is{' '}
                {Math.round(info.context.tokens_raw / info.context.tokens_trimmed)} times smaller for one order, and
                every later turn pays for what stays in the history.
              </div>
            </div>
          </div>
        )}
        {last && (
          <>
            <h3>The last run</h3>
            <p className="small">
              Order records entering the context: about {last.tokens.raw} tokens from the tools, {last.tokens.context}{' '}
              kept{sw.trim ? '' : ' (trimming is off)'}.
            </p>
            <pre className="sd-json">{last.facts_block}</pre>
          </>
        )}
      </section>

      <section className="card" id="evaluate">
        <h2>9. Evaluate the agent</h2>
        <p className="small">
          Eight scripted customer messages, each with an expected outcome. The outcome is read from what the tools did,
          not from the wording of the reply. First-contact resolution is the share of cases the agent settled itself. It
          is not the goal on its own: the right answer to a refund over $500 is an escalation, and a high rate that
          comes from refunding everything is a failure. So each case also has checks, and the table reports pass or fail
          against the expected outcome. Turn a switch off above and run again to see which cases break.
        </p>
        <div className="table-wrap">
          <table className="t small">
            <thead>
              <tr>
                <th>Case</th>
                <th>Expected</th>
                <th>Got</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {(info?.eval_cases ?? []).map((c) => {
                const r = results.find((x) => x.id === c.id);
                return (
                  <tr key={c.id}>
                    <td>
                      <details className="sd-details">
                        <summary>{c.title}</summary>
                        <p className="small">Customer: {c.message}</p>
                        {r && (
                          <>
                            <Trace trace={r.trace} />
                            <p className="small">Agent: {r.reply}</p>
                            {r.notes.map((n, i) => (
                              <p key={i} className="small sd-bad">
                                {n}
                              </p>
                            ))}
                            <p className="small muted">
                              {r.iterations} model turns, {usd(r.cost_usd)}
                            </p>
                          </>
                        )}
                      </details>
                    </td>
                    <td>{OUTCOME[c.expect]}</td>
                    <td>{r ? OUTCOME[r.outcome] : '–'}</td>
                    <td>{r ? <Pill ok={r.passed}>{r.passed ? 'pass' : 'fail'}</Pill> : '–'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="sd-row">
          <button className="btn primary" disabled={!!busy || !model} onClick={runAll}>
            {busy === 'eval' ? 'Running…' : 'Run all'}
          </button>
          {busy === 'eval' && (
            <button className="btn" onClick={() => abort.current?.abort()}>
              Stop
            </button>
          )}
          {evalStep && <span className="small muted">{evalStep}</span>}
          {(busy === 'eval' || summary) && <span className="small muted">Cost so far: {usd(evalCost)}</span>}
        </div>
        {evalNote && <p className="small sd-bad">{evalNote}</p>}
        {summary && (
          <div className="sd-headline">
            <div>
              <div className="sd-big">{pct(summary.fcr_rate)}</div>
              <div className="small muted">
                first-contact resolution ({summary.resolved} of {summary.total} resolved)
              </div>
            </div>
            <div>
              <div className="sd-big">
                {summary.passed}/{summary.total}
              </div>
              <div className="small muted">correct against the expected outcome ({pct(summary.correct_routing)})</div>
            </div>
            <div className="small muted">
              Of the cases that should be resolved: {pct(summary.resolvable_fcr)}. Escalated: {summary.escalated}. Asked
              for an identifier: {summary.asked_identifier}.
            </div>
          </div>
        )}
      </section>

      <div className="takeaways">
        <h3>Takeaways</h3>
        <ul>
          <li>The loop stops on stop_reason, never on what the reply says. The iteration cap is a safety net.</li>
          <li>What must always happen goes in code (gate, hooks). What should usually happen goes in the prompt.</li>
          <li>Errors need a category and a retry flag, and an empty result is not an error.</li>
          <li>Clear tool descriptions and few tools beat clever prompts and logging.</li>
          <li>
            Escalate on a request for a person or a gap in policy, not on mood. Hand over a summary, not a transcript.
          </li>
          <li>Keep facts outside the history and trim what enters it. Score on outcomes, not wording.</li>
        </ul>
      </div>
    </main>
  );
}
