import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { CodeBlock } from '@/components/CodeBlock';
import { statusService } from '@/services';
import { TokenFlow } from './TokenFlow';
import {
  EFFORTS,
  MODELS,
  TASKS,
  bill,
  n0,
  tokensOf,
  turnsFor,
  usd,
  type Effort,
  type ModelId,
  type Price,
  type Task,
} from './workload';
import * as S from './snippets';
import './effort-cost.css';

const EFFORT_NOTE: Record<Effort, string> = {
  low: 'Short thinking, few tool calls, terse replies',
  medium: 'Some thinking: the default on Opus 5.5 and Haiku 5.5',
  high: 'Thinks things through: the default on Sonnet 5.5',
  xhigh: 'Longer reasoning, more checking',
  max: 'As much as it needs, whatever it costs',
};

/** Why a bigger model or more effort costs more: price per token times the number of tokens, drawn as it happens. */
export default function EffortCostPage() {
  const [prices, setPrices] = useState<Record<string, Price> | null>(null);
  const [writeMultiplier, setWriteMultiplier] = useState(1.25);
  const [taskId, setTaskId] = useState<Task['id']>('agent');
  const [model, setModel] = useState<ModelId>('claude-sonnet-5-5');
  const [effort, setEffort] = useState<Effort>('medium');
  const [caching, setCaching] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [perMonth, setPerMonth] = useState(10000);

  useEffect(() => {
    statusService
      .status()
      .then((s) => {
        if (s.prices && Object.keys(s.prices).length) setPrices(s.prices);
        if (s.cache?.write_multiplier) setWriteMultiplier(s.cache.write_multiplier);
      })
      .catch(() => setPrices(null));
  }, []);

  const task = TASKS.find((t) => t.id === taskId)!;
  const m = MODELS.find((x) => x.id === model)!;
  const price = prices?.[model] ?? null;
  const turns = useMemo(() => turnsFor(task, effort), [task, effort]);
  const b = useMemo(
    () => bill(turns, price ?? { input: 0, output: 0, cache_read: 0 }, caching, writeMultiplier),
    [turns, price, caching, writeMultiplier],
  );

  const costOf = (mid: ModelId, e: Effort) => {
    const p = prices?.[mid];
    return p ? bill(turnsFor(task, e), p, caching, writeMultiplier).total : null;
  };
  const grid = MODELS.map((x) => EFFORTS.map((e) => costOf(x.id, e)));
  const allCosts = grid.flat().filter((x): x is number => x !== null);
  const cheapest = allCosts.length ? Math.min(...allCosts) : null;
  const dearest = allCosts.length ? Math.max(...allCosts) : null;
  const heat = (c: number | null) => {
    if (c === null || cheapest === null || dearest === null || dearest === cheapest) return 0;
    return Math.log(c / cheapest) / Math.log(dearest / cheapest);
  };

  const runKey = `${taskId}|${model}|${effort}|${caching}|${prices ? 1 : 0}`;
  const effortIndex = EFFORTS.indexOf(effort);
  const parts = [
    { key: 'input', label: 'Read (input)', color: 'var(--s1)', tokens: b.inputTokens, dollars: b.input },
    { key: 'cached', label: 'Read from cache', color: 'var(--faint)', tokens: b.cachedTokens, dollars: b.cached },
    {
      key: 'thinking',
      label: 'Thinking (output)',
      color: 'var(--brand)',
      tokens: b.thinkingTokens,
      dollars: b.thinking,
    },
    {
      key: 'written',
      label: 'Tool calls and answer (output)',
      color: 'var(--s3)',
      tokens: b.writtenTokens,
      dollars: b.written,
    },
  ].filter((p) => p.tokens > 0);
  const totalTokens = tokensOf(b);
  const base = costOf('claude-haiku-5-5', 'low');

  // The staircase: what each call sends and writes.
  const tallest = Math.max(...turns.map((t) => t.input + t.thinking + t.written));

  // Cost per finished task, comparing the cheapest setting with the one chosen.
  const [cheapRate, setCheapRate] = useState(55);
  const [chosenRate, setChosenRate] = useState(95);

  return (
    <main className="page-effort-cost">
      <div className="kicker">Cost and operations · Model and effort</div>
      <h1>Why a bigger model, or more effort, costs more</h1>
      <p className="lede">
        Every bill is the same sum: <b>tokens × price per token</b>. Choosing a bigger model raises the price of each
        token. Turning up effort raises the number of tokens: the model thinks for longer, and an agent takes more
        steps, each of which sends the whole conversation again. Change the dials below and watch where the tokens go.
      </p>

      <div className="ec-controls card">
        <div className="ec-row">
          <span className="ec-label">Task</span>
          <div className="ec-seg" role="radiogroup" aria-label="Task">
            {TASKS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="radio"
                aria-checked={t.id === taskId}
                className={t.id === taskId ? 'on' : ''}
                onClick={() => setTaskId(t.id)}
              >
                {t.name}
              </button>
            ))}
          </div>
          <span className="small muted">{task.blurb}</span>
        </div>
        <div className="ec-row">
          <span className="ec-label">Model</span>
          <div className="ec-seg" role="radiogroup" aria-label="Model">
            {MODELS.map((x) => (
              <button
                key={x.id}
                type="button"
                role="radio"
                aria-checked={x.id === model}
                className={x.id === model ? 'on' : ''}
                onClick={() => setModel(x.id)}
              >
                <span className="ec-dot" style={{ width: 8 + 8 * x.size, height: 8 + 8 * x.size }} />
                {x.name}
                {prices?.[x.id] && (
                  <small>
                    ${prices[x.id].input} / ${prices[x.id].output}
                  </small>
                )}
              </button>
            ))}
          </div>
        </div>
        <div className="ec-row">
          <span className="ec-label">Effort</span>
          <div className="ec-effort">
            <input
              type="range"
              min={0}
              max={EFFORTS.length - 1}
              step={1}
              value={effortIndex}
              onChange={(e) => setEffort(EFFORTS[+e.target.value])}
              aria-label="Effort"
              aria-valuetext={effort}
              style={{ '--fill': `${(effortIndex / (EFFORTS.length - 1)) * 100}%` } as React.CSSProperties}
            />
            <div className="ec-ticks">
              {EFFORTS.map((e) => (
                <button key={e} type="button" className={e === effort ? 'on' : ''} onClick={() => setEffort(e)}>
                  {e}
                  {m.defaultEffort === e && <i>default</i>}
                </button>
              ))}
            </div>
            <span className="small muted">{EFFORT_NOTE[effort]}</span>
          </div>
        </div>
        <div className="ec-row ec-toggles">
          <label>
            <input type="checkbox" checked={caching} onChange={(e) => setCaching(e.target.checked)} /> Prompt caching
          </label>
          <label>
            <input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} /> Hide the thinking
            (display: omitted)
          </label>
        </div>
      </div>

      <TokenFlow
        turns={turns}
        price={price}
        caching={caching}
        writeMultiplier={writeMultiplier}
        modelName={m.name}
        modelSize={m.size}
        hideThinking={hidden}
        runKey={runKey}
      />
      <p className="small muted ec-legend">
        Each dot is {n0(100)} tokens.
        {[
          ['var(--s1)', 'read'],
          ['var(--faint)', 'read from the cache'],
          ['var(--brand)', 'thinking'],
          ['var(--s4)', 'tool call'],
          ['var(--s5)', 'tool result'],
          ['var(--s3)', 'answer'],
        ].map(([c, label]) => (
          <span key={label}>
            <i style={{ background: c }} /> {label}
          </span>
        ))}
        <span>A long run is played faster so it fits.</span>
      </p>

      <section className="ec-bill card" aria-label="The bill for this run">
        <div className="ec-bill-head">
          <div>
            <span className="small muted">
              {m.name} · {effort} effort · {task.turns[effort]} model call{task.turns[effort] === 1 ? '' : 's'}
            </span>
            <div className="ec-big">{price ? usd(b.total) : '—'}</div>
            <span className="small muted">{n0(totalTokens)} tokens for one task</span>
          </div>
          <div className="ec-compare">
            {price && base ? (
              <>
                <b>×{(b.total / base).toFixed(b.total / base < 10 ? 1 : 0)}</b>
                <span className="small muted">the cost of Haiku 5.5 at low effort</span>
              </>
            ) : null}
            {price && (
              <span className="small">
                {usd(b.total * perMonth)} a month at{' '}
                <input
                  type="number"
                  min={0}
                  step={1000}
                  value={perMonth}
                  onChange={(e) => setPerMonth(Math.max(0, +e.target.value || 0))}
                  aria-label="Tasks a month"
                />{' '}
                tasks
              </span>
            )}
          </div>
        </div>
        <div className="ec-stack" aria-hidden="true">
          {parts.map((p) => (
            <span
              key={p.key}
              style={{ flexGrow: price ? p.dollars : p.tokens, background: p.color }}
              title={`${p.label}: ${usd(p.dollars)}`}
            />
          ))}
        </div>
        <table className="ec-parts">
          <tbody>
            {parts.map((p) => (
              <tr key={p.key}>
                <td>
                  <i style={{ background: p.color }} /> {p.label}
                </td>
                <td className="num">{n0(p.tokens)} tokens</td>
                <td className="num">{price ? usd(p.dollars) : '—'}</td>
                <td className="num muted">{price && b.total ? `${Math.round((p.dollars / b.total) * 100)}%` : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!prices && (
          <p className="small muted">
            Prices come from the lab backend. Start it to see dollars; the tokens are the same.
          </p>
        )}
      </section>

      <h2>Two dials, one bill</h2>
      <div className="ec-two">
        <div className="card">
          <h3>The model sets the price of each token</h3>
          <p className="small">
            Per million tokens, from the lab&apos;s price list. Output costs five times input on all three, and thinking
            is output.
          </p>
          <div className="ec-prices">
            {MODELS.map((x) => {
              const p = prices?.[x.id];
              const top = prices ? Math.max(...MODELS.map((y) => prices[y.id]?.output ?? 0)) : 1;
              return (
                <div key={x.id} className={x.id === model ? 'on' : ''}>
                  <span className="ec-pname">{x.short}</span>
                  <span className="ec-pbar">
                    <span style={{ width: p ? `${(p.input / top) * 100}%` : 0, background: 'var(--s1)' }} />
                  </span>
                  <span className="num small">{p ? `$${p.input}` : '—'}</span>
                  <span className="ec-pbar">
                    <span style={{ width: p ? `${(p.output / top) * 100}%` : 0, background: 'var(--brand)' }} />
                  </span>
                  <span className="num small">{p ? `$${p.output}` : '—'}</span>
                </div>
              );
            })}
          </div>
          <p className="small muted">Blue: input. Purple: output, which includes thinking.</p>
        </div>
        <div className="card">
          <h3>Effort sets how many tokens</h3>
          <p className="small">
            {task.id === 'agent'
              ? 'For an agent, more effort means more thinking on every step and more steps.'
              : 'For a single call, more effort means more thinking before the answer.'}
          </p>
          <div className="ec-efforts">
            {EFFORTS.map((e) => {
              const t = turnsFor(task, e);
              const think = t.reduce((s, x) => s + x.thinking, 0);
              const most = task.thinking.max * task.turns.max;
              return (
                <button key={e} type="button" className={e === effort ? 'on' : ''} onClick={() => setEffort(e)}>
                  <span className="ec-ename">{e}</span>
                  <span className="ec-ebar">
                    <span style={{ width: `${(think / most) * 100}%` }} />
                  </span>
                  <span className="num small">
                    {n0(think)} thinking{task.id === 'agent' ? ` · ${t.length} calls` : ''}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <h2>Every setting, side by side</h2>
      <p>
        The same task priced for each model and effort. The colour runs from the cheapest to the dearest on a log scale,
        because the range is wide. Choose a cell to watch it run.
      </p>
      <div className="ec-grid" role="grid" aria-label="Cost per task for each model and effort">
        <div className="ec-gh" />
        {EFFORTS.map((e) => (
          <div key={e} className="ec-gh">
            {e}
          </div>
        ))}
        {MODELS.map((x, i) => (
          <div key={x.id} className="ec-grow" role="row">
            <div className="ec-gh ec-gm">{x.name}</div>
            {EFFORTS.map((e, j) => {
              const c = grid[i][j];
              const on = x.id === model && e === effort;
              return (
                <button
                  key={e}
                  type="button"
                  role="gridcell"
                  className={`ec-cell${on ? ' on' : ''}${heat(c) > 0.72 ? ' deep' : ''}`}
                  style={{ '--h': heat(c) } as React.CSSProperties}
                  onClick={() => {
                    setModel(x.id);
                    setEffort(e);
                  }}
                  aria-label={`${x.name} at ${e} effort: ${c === null ? 'no price' : usd(c)}`}
                >
                  <b>{c === null ? '—' : usd(c)}</b>
                  {c !== null && cheapest ? <small>×{(c / cheapest).toFixed(c / cheapest < 10 ? 1 : 0)}</small> : null}
                </button>
              );
            })}
          </div>
        ))}
      </div>
      {cheapest !== null && dearest !== null && (
        <p className="small muted">
          From {usd(cheapest)} to {usd(dearest)} for the same task: {Math.round(dearest / cheapest)} times. Most of that
          is the model; the rest is effort.
        </p>
      )}

      <h2>Why effort costs more than the thinking alone</h2>
      <p>
        An agent works in steps. Each step is a new request, and each request sends the whole conversation so far: the
        instructions, the tools, and every earlier tool call and result. More effort means more steps, so the early part
        of the conversation is paid for again and again. This is the staircase for the setting above.
      </p>
      <div className="ec-stairs card" key={runKey}>
        <div className="ec-steps">
          {turns.map((t, i) => (
            <div key={i} className="ec-step" style={{ animationDelay: `${i * 90}ms` }}>
              <div className="ec-col" style={{ height: `${((t.input + t.thinking + t.written) / tallest) * 100}%` }}>
                <span style={{ flexGrow: t.written, background: 'var(--s3)' }} title={`${n0(t.written)} written`} />
                <span
                  style={{ flexGrow: t.thinking, background: 'var(--brand)' }}
                  title={`${n0(t.thinking)} thinking`}
                />
                <span
                  style={{ flexGrow: t.input - (caching ? t.repeated : 0), background: 'var(--s1)' }}
                  title={`${n0(t.input - (caching ? t.repeated : 0))} read`}
                />
                {caching && t.repeated > 0 && (
                  <span
                    style={{ flexGrow: t.repeated, background: 'var(--faint)' }}
                    title={`${n0(t.repeated)} from the cache`}
                  />
                )}
              </div>
              <span className="small muted">{i + 1}</span>
            </div>
          ))}
        </div>
        <p className="small muted">
          Model calls in order, scaled to the largest.{' '}
          {task.id === 'agent'
            ? `The last call sends ${n0(turns[turns.length - 1].input)} tokens to write a ${n0(task.answer)}-token answer.`
            : 'A single call has no staircase: here effort only adds thinking.'}{' '}
          {caching
            ? 'With caching on, the grey part was sent before and is read from the cache at a tenth of the input price or less.'
            : 'Turn on prompt caching to see how much of each step was already sent.'}
        </p>
      </div>

      <h2>Hidden thinking is still billed</h2>
      <p>
        Thinking can be summarised or left out of the reply (<code>display: &quot;omitted&quot;</code> is the default on
        the current models). That changes what you see, not what you pay: the model still thinks, and the thinking is
        still counted in <code>output_tokens</code>. Tick <i>Hide the thinking</i> above: the dots are frosted over, and
        the meter still counts them.
      </p>

      <h2>Cost per finished task, not per request</h2>
      <p>
        A cheap setting that fails has to be run again, or fixed by a person. Divide the cost of a run by how often it
        finishes the task to compare fairly. The success rates here are placeholders: measure yours with an evaluation
        set.
      </p>
      <div className="ec-two">
        {[
          { name: 'Haiku 5.5, low effort', cost: base, rate: cheapRate, set: setCheapRate },
          { name: `${m.name}, ${effort} effort`, cost: price ? b.total : null, rate: chosenRate, set: setChosenRate },
        ].map((o) => (
          <div className="card ec-finish" key={o.name}>
            <h3>{o.name}</h3>
            <label className="small">
              <span>
                Finishes the task <b>{o.rate}%</b> of the time <span className="ec-ph">placeholder</span>
              </span>
              <input type="range" min={5} max={100} value={o.rate} onChange={(e) => o.set(+e.target.value)} />
            </label>
            <div className="ec-tries" aria-hidden="true">
              {Array.from({ length: Math.min(12, Math.ceil(100 / o.rate)) }, (_, i) => (
                <span
                  key={i}
                  className={i === Math.ceil(100 / o.rate) - 1 ? 'ok' : ''}
                  style={{ animationDelay: `${i * 120}ms` }}
                />
              ))}
            </div>
            <p className="small">
              {o.cost === null ? (
                'Needs prices from the backend.'
              ) : (
                <>
                  {usd(o.cost)} a run ÷ {o.rate}% = <b>{usd(o.cost / (o.rate / 100))}</b> per finished task, about{' '}
                  {(100 / o.rate).toFixed(1)} runs each.
                </>
              )}
            </p>
          </div>
        ))}
      </div>

      <h2>Setting it in code</h2>
      <p>
        Effort is a field in <code>output_config</code>. All three current models accept <code>low</code>,{' '}
        <code>medium</code>, <code>high</code>, <code>xhigh</code> and <code>max</code>. The default is{' '}
        <code>medium</code> on Opus 5.5 and Haiku 5.5, and <code>high</code> on Sonnet 5.5, so set it yourself rather
        than rely on it. Opus 5.5 cannot turn thinking off: lower effort is how you make it think less.
      </p>
      <CodeBlock html={S.effort} />

      <h2>Choosing</h2>
      <ul className="ec-take">
        <li>
          <b>Low effort</b> for chat, classification, extraction and short rewrites, and for sub-agents doing simple
          jobs. Extra thinking buys little there and adds delay.
        </li>
        <li>
          <b>Medium or high</b> for code, agents and multi-step work. These respond to effort; measure where the gain
          stops.
        </li>
        <li>
          <b>Try the stronger model at lower effort</b> before building a cascade of models. It often matches a weaker
          model at higher effort, with one cache instead of two.
        </li>
        <li>
          <b>Cache the conversation</b> in agent loops: the staircase is mostly repeated input.
        </li>
        <li>
          <b>Judge by cost per finished task</b>, on your own examples, at two or three settings. Pick the cheapest one
          that holds your quality bar.
        </li>
      </ul>
      <p className="small muted">
        Prices are the lab&apos;s list prices (<code>python/common.py</code>); check Anthropic&apos;s pricing page
        before relying on them. Haiku 5.5&apos;s price is for prompts up to 100,000 tokens, which every request here
        stays under. The token counts are an illustrative workload, not a measurement: real models use different numbers
        of tokens on the same task, and the <Link to="/reasoning-models">reasoning models</Link> page shows how accuracy
        flattens as thinking grows. To count your own prompts, use the <Link to="/token-counter">token counter</Link>.
      </p>
    </main>
  );
}
