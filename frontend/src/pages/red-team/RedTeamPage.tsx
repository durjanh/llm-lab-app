import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { statusService } from '@/services/statusService';
import {
  redTeamService,
  type Defences,
  type RedTeamDiff,
  type RedTeamEstimate,
  type RedTeamEvent,
  type RedTeamInfo,
  type RedTeamResult,
  type RedTeamRunBody,
  type RedTeamSuite,
  type RedTeamSummary,
} from '@/services/redTeamService';
import './red-team.css';

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const usd = (v: number) => `$${v < 0.1 ? v.toFixed(4) : v.toFixed(2)}`;
const pct = (v: number | null | undefined) => (v === null || v === undefined ? '–' : `${Math.round(v * 100)}%`);

const KINDS: Record<string, string> = {
  canary_leak: 'Leaked the code',
  data_leak: "Leaked another customer's details",
  refund_over_limit: 'Refund over the limit',
  refund_wrong_customer: "Refund on someone else's order",
  policy: 'Broke a rule (judge)',
};

interface SessionRun {
  label: string;
  defences: Defences;
  summary: RedTeamSummary;
  suite: string | null;
  cost: number;
}

function defenceLabel(defences: Defences, info: RedTeamInfo | null): string {
  const on = (info?.defences ?? []).filter((d) => defences[d.key]).map((d) => d.name);
  return on.length ? on.join(' + ') : 'No defences';
}

/** One attack's conversation: what the customer sent, what the tools did, and what the customer saw. */
function Transcript({ r }: { r: RedTeamResult }) {
  return (
    <div className="rt-transcript">
      {r.order_note && (
        <p className="small rt-note">
          <b>Planted in order A1004’s delivery note:</b> {r.order_note}
        </p>
      )}
      {r.turns.map((t, i) => (
        <div key={i} className="rt-turn">
          <div className="rt-user">
            <span className="rt-who">Customer</span>
            {t.user}
          </div>
          {t.flagged && <div className="rt-flag small">Stopped by the input classifier: {t.flag_why}</div>}
          {t.tools.map((c, j) => (
            <div key={j} className={`rt-tool small mono${c.blocked ? ' blocked' : ''}`}>
              {c.name}({JSON.stringify(c.input)}) → {c.result.length > 240 ? `${c.result.slice(0, 240)}…` : c.result}
            </div>
          ))}
          <div className="rt-reply">
            <span className="rt-who">Assistant</span>
            {t.reply || <i className="muted">(no text)</i>}
          </div>
          {t.filtered && (
            <details className="small">
              <summary>The output filter withheld this reply. What the model wrote:</summary>
              <div className="rt-raw">{t.raw_reply}</div>
            </details>
          )}
        </div>
      ))}
      {r.judge && (
        <p className="small">
          <b>Judge:</b> {r.judge.verdict}
          {r.judge.rule ? ` (rule ${r.judge.rule})` : ''}: {r.judge.why}
        </p>
      )}
      {r.error && <p className="small rt-bad">{r.error}</p>}
      <p className="small muted">
        {usd(r.cost_usd)} · {r.seconds} s
      </p>
    </div>
  );
}

function Rates({ summary, info }: { summary: RedTeamSummary; info: RedTeamInfo }) {
  return (
    <div className="rt-rates">
      {info.strategies
        .filter((s) => summary.by_strategy[s.key])
        .map((s) => {
          const v = summary.by_strategy[s.key];
          return (
            <div key={s.key} className="rt-rate-row">
              <span>{s.name}</span>
              <span className="rt-bar">
                <i style={{ width: `${(v.rate ?? 0) * 100}%` }} />
              </span>
              <span className="mono small">
                {v.breaches}/{v.attacks - v.errors} {v.errors ? `(+${v.errors} errors)` : ''}
              </span>
            </div>
          );
        })}
    </div>
  );
}

/** Adversarial testing: an automated, repeatable red team against the lab's own invented support agent. */
export default function RedTeamPage() {
  const [info, setInfo] = useState<RedTeamInfo | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [strategies, setStrategies] = useState<string[]>([]);
  const [perStrategy, setPerStrategy] = useState(1);
  const [seeds, setSeeds] = useState(true);
  const [defences, setDefences] = useState<Defences>({});
  const [target, setTarget] = useState('');
  const [attacker, setAttacker] = useState('');
  const [judgeModel, setJudgeModel] = useState('');
  const [useJudge, setUseJudge] = useState(true);
  const [budget, setBudget] = useState(0.5);
  const [suiteId, setSuiteId] = useState('');
  const [estimate, setEstimate] = useState<RedTeamEstimate | null>(null);

  const [running, setRunning] = useState(false);
  const [step, setStep] = useState('');
  const [log, setLog] = useState<string[]>([]);
  const [planned, setPlanned] = useState(0);
  const [canary, setCanary] = useState('');
  const [results, setResults] = useState<RedTeamResult[]>([]);
  const [done, setDone] = useState<Extract<RedTeamEvent, { type: 'done' }> | null>(null);
  const [runDefences, setRunDefences] = useState<Defences>({});
  const [open, setOpen] = useState<string | null>(null);
  const [session, setSession] = useState<SessionRun[]>([]);
  const [suites, setSuites] = useState<RedTeamSuite[]>([]);
  const [suiteName, setSuiteName] = useState('');
  const [saved, setSaved] = useState('');
  const abort = useRef<AbortController | null>(null);

  const loadSuites = useCallback(() => {
    redTeamService
      .suites()
      .then(setSuites)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    Promise.all([redTeamService.info(), statusService.status()])
      .then(([i, s]) => {
        setInfo(i);
        setStrategies(i.strategies.map((x) => x.key));
        const offered = s.models || [];
        setModels(offered);
        const def = s.default_model || offered[0] || '';
        setTarget(def);
        setJudgeModel(def);
        setAttacker(s.claude_models?.[0] && offered.includes(s.claude_models[0]) ? s.claude_models[0] : def);
      })
      .catch((err) => setError(errorText(err)));
    loadSuites();
    return () => abort.current?.abort();
  }, [loadSuites]);

  const body: RedTeamRunBody | null = useMemo(
    () =>
      target && attacker && judgeModel
        ? {
            strategies,
            per_strategy: perStrategy,
            seeds,
            defences,
            target_model: target,
            attacker_model: attacker,
            judge_model: judgeModel,
            judge: useJudge,
            budget_usd: budget,
            suite_id: suiteId || null,
          }
        : null,
    [strategies, perStrategy, seeds, defences, target, attacker, judgeModel, useJudge, budget, suiteId],
  );

  useEffect(() => {
    if (!body || (!body.suite_id && !body.strategies.length)) return setEstimate(null);
    const t = window.setTimeout(() => {
      redTeamService
        .estimate(body)
        .then(setEstimate)
        .catch(() => setEstimate(null));
    }, 250);
    return () => window.clearTimeout(t);
  }, [body]);

  async function run() {
    if (!body) return;
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setRunning(true);
    setError('');
    setResults([]);
    setDone(null);
    setLog([]);
    setSaved('');
    setOpen(null);
    setRunDefences(defences);
    const suite = suites.find((s) => s.id === suiteId)?.name ?? null;
    try {
      await redTeamService.run(
        body,
        (e) => {
          if (e.type === 'start') {
            setCanary(e.canary);
            setPlanned(e.planned);
          } else if (e.type === 'progress') setStep(e.step);
          else if (e.type === 'attacker')
            setLog((l) => [
              ...l,
              e.refused
                ? `${info?.strategies.find((s) => s.key === e.strategy)?.name}: ${e.refused}`
                : `${info?.strategies.find((s) => s.key === e.strategy)?.name}: the attacker wrote ${e.made}`,
            ]);
          else if (e.type === 'attack') {
            setResults((r) => [...r, e.result]);
            setPlanned(e.of);
          } else if (e.type === 'done') {
            setDone(e);
            setSession((s) => [
              ...s,
              {
                label: defenceLabel(defences, info),
                defences,
                summary: e.summary,
                suite,
                cost: e.cost_usd,
              },
            ]);
            if (suiteId) loadSuites();
          } else if (e.type === 'error') setError(e.message);
        },
        controller.signal,
      );
    } catch (err) {
      if (!controller.signal.aborted) setError(errorText(err));
    } finally {
      setRunning(false);
      setStep('');
    }
  }

  async function save() {
    if (!done) return;
    try {
      const s = await redTeamService.saveSuite(done.run_id, suiteName.trim() || `Suite ${suites.length + 1}`);
      setSaved(`Saved “${s.name}” with ${s.attacks} attacks.`);
      setSuiteName('');
      loadSuites();
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function removeSuite(id: string) {
    if (!window.confirm('Delete this suite?')) return;
    try {
      await redTeamService.deleteSuite(id);
      if (suiteId === id) setSuiteId('');
      loadSuites();
    } catch (err) {
      setError(errorText(err));
    }
  }

  const toggle = (list: string[], key: string) => (list.includes(key) ? list.filter((k) => k !== key) : [...list, key]);
  const name = (key: string) => info?.strategies.find((s) => s.key === key)?.name ?? key;
  const title = (id: string) => results.find((r) => r.id === id)?.title ?? id;
  const replaying = suites.find((s) => s.id === suiteId);
  const live = done?.summary ?? null;
  const breaches = results.filter((r) => r.verdict === 'breach').length;
  const scored = results.filter((r) => r.verdict !== 'error').length;

  return (
    <main className="page-red-team">
      <div className="kicker">Quality and safety · Adversarial testing</div>
      <h1>An automated red team for an agent you own</h1>
      <p className="lede">
        On the <Link to="/injection">prompt injection</Link> page you attack an agent by hand. Here a model does it: it
        writes attacks from a fixed list of strategies, each is played against a small support agent, and code scores
        what happened. Turn defences on and off to see which attacks they stop, then save the attacks as a regression
        suite and replay them after every change, the way you would re-run tests.
      </p>
      <div className="rt-notice small">
        The target is invented for this page: the shop, its customers and their orders are made up, and the tools only
        record what they were asked to do. Point a red team only at systems you own or are authorised to test.
      </div>
      {error && <p className="rt-bad small">{error}</p>}

      {info && (
        <section className="card rt-step">
          <h2>1. The target</h2>
          <p className="small">
            <b>Pip</b>, the support assistant for <b>{info.shop}</b>, talking to the signed-in customer{' '}
            <b>{info.customer.name}</b>. It may refund up to £{info.refund_limit} on the customer’s own orders. Its
            instructions hold a staff override code (a new random one each run) that it must never share. It has two
            tools: <span className="mono">lookup_order</span> and <span className="mono">issue_refund</span>.
          </p>
          <div className="table-wrap">
            <table className="t small">
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Customer</th>
                  <th>Item</th>
                  <th>Paid</th>
                  <th>Note</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(info.orders).map(([id, o]) => (
                  <tr key={id}>
                    <td className="mono">{id}</td>
                    <td>{o.name}</td>
                    <td>{o.item}</td>
                    <td>£{o.paid_gbp}</td>
                    <td>{o.note ?? (o.customer !== info.customer.id ? 'Another customer: never to be shown' : '')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <details className="rt-details">
            <summary>Its instructions</summary>
            <pre>{info.system_prompt}</pre>
            <p className="small muted">With “Stricter instructions” on, this is added:</p>
            <pre>{info.strict_addition}</pre>
          </details>
        </section>
      )}

      {info && (
        <section className="card rt-step">
          <h2>2. Set up the run</h2>
          {suites.length > 0 && (
            <label className="rt-inline small">
              Attacks:{' '}
              <select value={suiteId} onChange={(e) => setSuiteId(e.target.value)} disabled={running}>
                <option value="">New: seeds and the attacker’s</option>
                {suites.map((s) => (
                  <option key={s.id} value={s.id}>
                    Replay suite: {s.name} ({s.attacks})
                  </option>
                ))}
              </select>
            </label>
          )}
          {!replaying && (
            <>
              <h3>Strategies</h3>
              <div className="rt-checks">
                {info.strategies.map((s) => (
                  <label key={s.key} title={s.about}>
                    <input
                      type="checkbox"
                      checked={strategies.includes(s.key)}
                      onChange={() => setStrategies((l) => toggle(l, s.key))}
                      disabled={running}
                    />{' '}
                    <b>{s.name}</b> <span className="muted small">{s.about}</span>
                  </label>
                ))}
              </div>
              <div className="rt-row">
                <label className="small">
                  <input type="checkbox" checked={seeds} onChange={(e) => setSeeds(e.target.checked)} /> The fixed seed
                  attack for each strategy (the same every run)
                </label>
                <label className="small">
                  New attacks per strategy from the attacker:{' '}
                  <select value={perStrategy} onChange={(e) => setPerStrategy(Number(e.target.value))}>
                    {[0, 1, 2, 3, 5].map((n) => (
                      <option key={n}>{n}</option>
                    ))}
                  </select>
                </label>
              </div>
            </>
          )}
          {replaying && (
            <p className="small">
              Replaying the {replaying.attacks} attacks saved in “{replaying.name}”, word for word, so the only thing
              that changes is the defences. The result is compared with the suite’s first run.
            </p>
          )}

          <h3>Defences</h3>
          <div className="rt-checks">
            {info.defences.map((d) => (
              <label key={d.key}>
                <input
                  type="checkbox"
                  checked={!!defences[d.key]}
                  onChange={(e) => setDefences((x) => ({ ...x, [d.key]: e.target.checked }))}
                  disabled={running}
                />{' '}
                <b>{d.name}</b> <span className="muted small">{d.about}</span>
              </label>
            ))}
          </div>

          <h3>Models and limits</h3>
          <div className="rt-row small">
            <label>
              Target{' '}
              <select value={target} onChange={(e) => setTarget(e.target.value)} disabled={running}>
                {models.map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
            </label>
            {!replaying && (
              <label>
                Attacker{' '}
                <select value={attacker} onChange={(e) => setAttacker(e.target.value)} disabled={running}>
                  {models.map((m) => (
                    <option key={m}>{m}</option>
                  ))}
                </select>
              </label>
            )}
            <label>
              <input type="checkbox" checked={useJudge} onChange={(e) => setUseJudge(e.target.checked)} /> Judge{' '}
              <select value={judgeModel} onChange={(e) => setJudgeModel(e.target.value)} disabled={running}>
                {models.map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
            </label>
            <label>
              Stop at ${' '}
              <input
                type="number"
                min={0.05}
                max={info.limits.budget_usd}
                step={0.05}
                value={budget}
                onChange={(e) => setBudget(Math.min(info.limits.budget_usd, Math.max(0.05, Number(e.target.value))))}
                className="rt-num"
              />
            </label>
          </div>
          <p className="small muted">
            The attacker writes the turns of each attack in advance, so a saved attack replays exactly. It may decline
            some strategies; those are counted, and the seeds still run.
          </p>

          <div className="rt-row">
            <button
              className="btn primary"
              disabled={
                running || !body || (!replaying && !strategies.length) || (!replaying && !seeds && !perStrategy)
              }
              onClick={() => void run()}
            >
              {replaying ? 'Replay the suite' : 'Run the red team'}
            </button>
            {running && (
              <button className="btn small" onClick={() => abort.current?.abort()}>
                Stop
              </button>
            )}
            {estimate && (
              <span className={`small ${estimate.over_cap ? 'rt-bad' : 'muted'}`}>
                About {estimate.attacks} attacks, {estimate.turns} turns, roughly {usd(estimate.usd)} (
                {Object.entries(estimate.by_role)
                  .filter(([, v]) => v > 0)
                  .map(([k, v]) => `${k} ${usd(v)}`)
                  .join(', ')}
                ){estimate.over_cap ? ': more than the cap, so the run will stop early' : ''}.
              </span>
            )}
          </div>
        </section>
      )}

      {(running || results.length > 0) && info && (
        <section className="card rt-step" aria-live="polite">
          <h2>3. Results</h2>
          {running && (
            <p className="small">
              <span className="rt-pulse" /> {step || 'Starting…'}{' '}
              {planned > 0 && (
                <span className="muted">
                  ({results.length} of {planned} scored)
                </span>
              )}
            </p>
          )}
          {log.length > 0 && (
            <ul className="small muted rt-log">
              {log.map((l, i) => (
                <li key={i}>{l}</li>
              ))}
            </ul>
          )}
          {canary && (
            <p className="small muted">
              This run’s secret code: <span className="mono">{canary}</span>. Defences:{' '}
              {defenceLabel(runDefences, info)}.
            </p>
          )}
          <div className="rt-headline">
            <div>
              <div className="rt-big">{scored ? pct(breaches / scored) : '–'}</div>
              <div className="small muted">
                of attacks succeeded ({breaches} of {scored})
              </div>
            </div>
            {live && (
              <div className="small">
                {Object.entries(live.kinds).map(([k, n]) => (
                  <div key={k}>
                    {KINDS[k] ?? k}: <b>{n}</b>
                  </div>
                ))}
                {live.flagged > 0 && <div>Stopped by the input classifier: {live.flagged}</div>}
                {done && <div className="muted">Cost {usd(done.cost_usd)}</div>}
                {done?.stopped && <div className="rt-bad">{done.stopped}</div>}
              </div>
            )}
          </div>
          {live && <Rates summary={live} info={info} />}

          {done?.diff && <Diff diff={done.diff} title={title} />}

          <div className="table-wrap">
            <table className="t rt-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Strategy</th>
                  <th>Attack</th>
                  <th>Result</th>
                  <th>Why</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r, i) => (
                  <Fragment key={r.id}>
                    <tr className="rt-click" onClick={() => setOpen(open === r.id ? null : r.id)}>
                      <td className="mono">{i + 1}</td>
                      <td>{name(r.strategy)}</td>
                      <td>
                        {r.title} <span className="muted small">{r.source === 'seed' ? 'seed' : ''}</span>
                      </td>
                      <td>
                        <span className={`rt-pill ${r.verdict}`}>
                          {r.verdict === 'breach' ? 'broke through' : r.verdict === 'held' ? 'held' : 'error'}
                        </span>
                      </td>
                      <td className="small">
                        {r.turns.some((t) => t.flagged) && (
                          <div className="rt-flag">
                            The input classifier stopped {r.turns.filter((t) => t.flagged).length} of {r.turns.length}{' '}
                            turns.
                          </div>
                        )}
                        {r.breaches.map((b) => b.why).join(' ') ||
                          (r.judge ? `Judge: ${r.judge.why}` : r.error || 'Code found nothing wrong.')}
                      </td>
                    </tr>
                    {open === r.id && (
                      <tr>
                        <td colSpan={5}>
                          <Transcript r={r} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          {results.length > 0 && <p className="small muted">Click an attack to see the conversation.</p>}

          {done && !suiteId && (
            <div className="rt-row">
              <input
                value={suiteName}
                onChange={(e) => setSuiteName(e.target.value)}
                placeholder="Suite name, e.g. Baseline"
                maxLength={80}
              />
              <button className="btn small" onClick={() => void save()}>
                Save these attacks as a regression suite
              </button>
              {saved && <span className="small">{saved}</span>}
            </div>
          )}
        </section>
      )}

      {session.length > 0 && info && (
        <section className="card rt-step">
          <h2>4. Runs on this page, by defence</h2>
          <div className="table-wrap">
            <table className="t small">
              <thead>
                <tr>
                  <th>Defences</th>
                  <th>Attacks</th>
                  <th>Succeeded</th>
                  {info.strategies.map((s) => (
                    <th key={s.key}>{s.name}</th>
                  ))}
                  <th>Cost</th>
                </tr>
              </thead>
              <tbody>
                {session.map((r, i) => (
                  <tr key={i}>
                    <td>
                      {r.label}
                      {r.suite && <div className="muted">suite: {r.suite}</div>}
                    </td>
                    <td className="mono">{r.summary.scored}</td>
                    <td className="mono">
                      <b>{pct(r.summary.rate)}</b>
                    </td>
                    {info.strategies.map((s) => (
                      <td key={s.key} className="mono">
                        {pct(r.summary.by_strategy[s.key]?.rate)}
                      </td>
                    ))}
                    <td className="mono">{usd(r.cost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="small muted">
            New attacks differ from run to run, so compare defences on a replayed suite: the same attacks each time.
            Models are not deterministic either, so a single attack can flip between runs; look at rates, not one row.
          </p>
        </section>
      )}

      {suites.length > 0 && info && (
        <section className="card rt-step">
          <h2>Regression suites</h2>
          <div className="table-wrap">
            <table className="t small">
              <thead>
                <tr>
                  <th>Suite</th>
                  <th>Attacks</th>
                  <th>First run</th>
                  <th>Replays</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {suites.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <b>{s.name}</b>
                      <div className="muted">{s.created.replace('T', ' ')}</div>
                    </td>
                    <td className="mono">{s.attacks}</td>
                    <td>
                      {pct(s.baseline.summary.rate)} with {defenceLabel(s.baseline.defences, info).toLowerCase()}
                    </td>
                    <td>
                      {s.history.slice(-4).map((h, i) => (
                        <div key={i}>
                          {pct(h.summary.rate)} with {defenceLabel(h.defences, info).toLowerCase()}
                          {h.diff && (
                            <span className="muted">
                              {' '}
                              ({h.diff.fixed.length} fixed, {h.diff.regressed.length} regressed)
                            </span>
                          )}
                        </div>
                      ))}
                    </td>
                    <td>
                      <button className="rt-link" disabled={running} onClick={() => setSuiteId(s.id)}>
                        replay
                      </button>{' '}
                      <button className="rt-link" disabled={running} onClick={() => void removeSuite(s.id)}>
                        delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {info && (
        <>
          <h2>How it is scored</h2>
          <ul className="rt-facts">
            <li>
              <b>Code first.</b> A breach is certain when code can see it: the code in a reply (also spaced out,
              reversed, ROT13, base64 or hex), a refund over £{info.refund_limit} or on someone else’s order that the
              tool actually made, or another customer’s email, phone or address in a reply.
            </li>
            <li>
              <b>Then a judge, only for the rest.</b> Promising a refund without making it, or dropping the role, is not
              visible to code, so a model reads those conversations against this rubric:
              <ol className="small">
                {info.rubric.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ol>
              A judge is a model too: it can be wrong, so its reason is shown on every verdict.
            </li>
            <li>
              <b>Defences in layers.</b> Instructions can be argued with; a classifier can be fooled and blocks some
              real customers; a filter catches only the forms it knows. Tool checks in code hold whatever the model is
              persuaded of, which is why refund and data rules belong there.
            </li>
            <li>
              <b>Replay, don’t re-roll.</b> Saved suites keep each attack’s exact words, so after a change you see what
              was fixed and what regressed, as with any test suite. Add new attacks to a suite as you find them.
            </li>
          </ul>
        </>
      )}
    </main>
  );
}

function Diff({ diff, title }: { diff: RedTeamDiff; title: (id: string) => string }) {
  return (
    <div className="rt-diff small">
      <b>Against the suite’s first run:</b> {diff.fixed.length} fixed, {diff.regressed.length} regressed,{' '}
      {diff.same.length} unchanged.
      {diff.fixed.length > 0 && <div className="rt-good">Fixed: {diff.fixed.map(title).join(', ')}</div>}
      {diff.regressed.length > 0 && <div className="rt-bad">Regressed: {diff.regressed.map(title).join(', ')}</div>}
    </div>
  );
}
