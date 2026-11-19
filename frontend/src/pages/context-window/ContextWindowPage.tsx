import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { CodeBlock } from '@/components/CodeBlock';
import { statusService } from '@/services';
import { WindowFlow } from './WindowFlow';
import {
  CLEAR_TRIGGER,
  COMPACT_TRIGGER,
  SCENARIOS,
  STRATEGIES,
  k,
  n0,
  simulate,
  usd,
  type Price,
  type Run,
  type ScenarioId,
  type Strategy,
} from './contextsim';
import * as S from './snippets';
import './context-window.css';

/** The model whose list prices the page charges with. */
const PRICED_AS = 'claude-sonnet-5-5';
const STRATEGY_COLOR: Record<Strategy, string> = {
  keep: 'var(--bad)',
  clear: 'var(--s4)',
  compact: 'var(--s3)',
  subagent: 'var(--brand)',
};

/** The context window filling turn by turn, and four ways to keep it in check. */
export default function ContextWindowPage() {
  const [price, setPrice] = useState<Price | null>(null);
  const [writeMultiplier, setWriteMultiplier] = useState(1.25);
  const [bigWindow, setBigWindow] = useState(1_000_000);
  const [scenarioId, setScenarioId] = useState<ScenarioId>('research');
  const [strategy, setStrategy] = useState<Strategy>('keep');
  const [windowSize, setWindowSize] = useState(1_000_000);
  const [caching, setCaching] = useState(true);

  useEffect(() => {
    statusService
      .status()
      .then((s) => {
        if (s.prices?.[PRICED_AS]) setPrice(s.prices[PRICED_AS]);
        if (s.cache?.write_multiplier) setWriteMultiplier(s.cache.write_multiplier);
        if (s.cache?.claude_context_tokens) {
          setBigWindow(s.cache.claude_context_tokens);
          setWindowSize((w) => (w === 1_000_000 ? s.cache!.claude_context_tokens : w));
        }
      })
      .catch(() => setPrice(null));
  }, []);

  const sc = SCENARIOS.find((s) => s.id === scenarioId)!;
  const runs = useMemo(() => {
    const out = {} as Record<Strategy, Run>;
    for (const st of STRATEGIES) out[st.id] = simulate(sc, st.id, windowSize, caching, price, writeMultiplier);
    return out;
  }, [sc, windowSize, caching, price, writeMultiplier]);
  const run = runs[strategy];
  const trigger = strategy === 'compact' ? COMPACT_TRIGGER : strategy === 'clear' ? CLEAR_TRIGGER : null;
  const runKey = `${scenarioId}|${strategy}|${windowSize}|${caching}|${price ? 1 : 0}`;
  const hasTools = sc.id !== 'chat';
  const toolStrategies = (st: Strategy) => hasTools || st === 'keep' || st === 'compact';

  // The chart: the window's size before each request, for every strategy.
  const CW = 720;
  const CH = 260;
  const PAD = { l: 52, r: 16, t: 14, b: 30 };
  const maxTurns = sc.turns;
  const x = (turn: number) => PAD.l + ((turn - 1) / Math.max(1, maxTurns - 1)) * (CW - PAD.l - PAD.r);
  const y = (tokens: number) => CH - PAD.b - (Math.min(tokens, windowSize) / windowSize) * (CH - PAD.t - PAD.b);
  const line = (r: Run) =>
    r.steps
      .map((s, i) => `${i ? 'L' : 'M'}${x(s.turn).toFixed(1)},${y(Math.min(s.input, windowSize)).toFixed(1)}`)
      .join(' ');

  return (
    <main className="page-context-window">
      <div className="kicker">Building · Context window</div>
      <h1>Watch the context window fill up</h1>
      <p className="lede">
        A model has no memory between requests. Everything it should know, the instructions, the tools, every message
        and every tool result so far, is sent again on each turn, and all of it must fit in its context window. Chats
        fill it slowly; agents that read files and web pages fill it fast. Pick a task and a way to manage it, and
        watch.
      </p>

      <div className="cw-controls card">
        <div className="cw-row">
          <span className="cw-label">Task</span>
          <div className="cw-seg" role="radiogroup" aria-label="Task">
            {SCENARIOS.map((s) => (
              <button
                key={s.id}
                type="button"
                role="radio"
                aria-checked={s.id === scenarioId}
                className={s.id === scenarioId ? 'on' : ''}
                onClick={() => {
                  setScenarioId(s.id);
                  if (s.id === 'chat' && (strategy === 'clear' || strategy === 'subagent')) setStrategy('keep');
                }}
              >
                {s.name}
              </button>
            ))}
          </div>
          <span className="small muted">{sc.blurb}</span>
        </div>
        <div className="cw-row">
          <span className="cw-label">Manage it</span>
          <div className="cw-seg" role="radiogroup" aria-label="Strategy">
            {STRATEGIES.map((st) => (
              <button
                key={st.id}
                type="button"
                role="radio"
                aria-checked={st.id === strategy}
                className={st.id === strategy ? 'on' : ''}
                disabled={!toolStrategies(st.id)}
                title={toolStrategies(st.id) ? st.note : 'A chat has no tool results to clear or hand off'}
                onClick={() => setStrategy(st.id)}
              >
                <i style={{ background: STRATEGY_COLOR[st.id] }} />
                {st.name}
              </button>
            ))}
          </div>
          <span className="small muted">{STRATEGIES.find((s) => s.id === strategy)!.note}</span>
        </div>
        <div className="cw-row">
          <span className="cw-label">Window</span>
          <div className="cw-seg" role="radiogroup" aria-label="Window size">
            {[
              [200_000, '200K (older models)'],
              [bigWindow, `${k(bigWindow)} (current Claude models)`],
            ].map(([size, label], i) => (
              <button
                key={i}
                type="button"
                role="radio"
                aria-checked={size === windowSize}
                className={size === windowSize ? 'on' : ''}
                onClick={() => setWindowSize(size as number)}
              >
                {label}
              </button>
            ))}
          </div>
          <label className="cw-check">
            <input type="checkbox" checked={caching} onChange={(e) => setCaching(e.target.checked)} /> Prompt caching
          </label>
        </div>
      </div>

      <WindowFlow
        run={run}
        window={windowSize}
        strategy={strategy}
        trigger={trigger}
        hasTools={hasTools}
        totalTurns={sc.turns}
        priced={!!price}
        runKey={runKey}
      />
      <p className="small muted cw-legend">
        {[
          ['var(--ink2)', 'system prompt and tools'],
          ['var(--s1)', 'messages'],
          ['var(--s5)', 'tool results'],
          ['var(--faint)', 'cleared results'],
          ['var(--s3)', 'summaries'],
          ['var(--brand)', 'sent to the model'],
          ['var(--brand-line)', 'sent, read from the cache'],
        ].map(([c, label]) => (
          <span key={label}>
            <i style={{ background: c }} /> {label}
          </span>
        ))}
        <span className="cw-note">
          Costs at Sonnet 5.5&apos;s list prices
          {price ? '' : ' (start the backend to see them)'}.
        </span>
      </p>

      <h2>Four ways, side by side</h2>
      <p>
        The window&apos;s size on every request, for each way of managing it. Keeping everything climbs until a request
        no longer fits. Clearing old results grows slowly. Compaction is a sawtooth. Handing the reading to a sub-agent
        keeps the main window small, but the sub-agent&apos;s own reading still costs.
      </p>
      <div className="card cw-chart">
        <svg viewBox={`0 0 ${CW} ${CH}`} role="img" aria-label="The window's size on each turn for the four strategies">
          {[0, 0.25, 0.5, 0.75, 1].map((f) => (
            <g key={f}>
              <line x1={PAD.l} x2={CW - PAD.r} y1={y(f * windowSize)} y2={y(f * windowSize)} className="grid" />
              <text x={PAD.l - 8} y={y(f * windowSize) + 4} textAnchor="end">
                {k(f * windowSize)}
              </text>
            </g>
          ))}
          <line x1={PAD.l} x2={CW - PAD.r} y1={y(windowSize)} y2={y(windowSize)} className="limit" />
          {[1, Math.round(maxTurns / 2), maxTurns].map((t) => (
            <text key={t} x={x(t)} y={CH - 8} textAnchor="middle">
              turn {t}
            </text>
          ))}
          {STRATEGIES.filter((st) => toolStrategies(st.id)).map((st) => (
            <g
              key={st.id}
              className={st.id === strategy ? 'on' : ''}
              onClick={() => setStrategy(st.id)}
              style={{ cursor: 'pointer' }}
            >
              <path d={line(runs[st.id])} stroke={STRATEGY_COLOR[st.id]} />
              {runs[st.id].fullAt && (
                <text
                  x={x(runs[st.id].fullAt!)}
                  y={y(windowSize) - 4}
                  textAnchor="middle"
                  className="x"
                  fill={STRATEGY_COLOR[st.id]}
                >
                  ✕ full
                </text>
              )}
            </g>
          ))}
        </svg>
        <div className="cw-scroll">
          <table className="cw-table">
            <thead>
              <tr>
                <th>Way</th>
                <th className="num">Turns done</th>
                <th className="num">Largest request</th>
                <th className="num">Tokens sent in all</th>
                <th className="num">From the cache</th>
                <th className="num">Cost</th>
              </tr>
            </thead>
            <tbody>
              {STRATEGIES.filter((st) => toolStrategies(st.id)).map((st) => {
                const r = runs[st.id];
                const done = r.fullAt ? r.fullAt - 1 : r.steps.length;
                return (
                  <tr key={st.id} className={st.id === strategy ? 'on' : ''} onClick={() => setStrategy(st.id)}>
                    <td>
                      <i style={{ background: STRATEGY_COLOR[st.id] }} /> {st.name}
                    </td>
                    <td className="num">
                      {done} of {sc.turns}
                      {r.fullAt ? <span className="cw-bad"> · full</span> : null}
                    </td>
                    <td className="num">{k(r.peak)}</td>
                    <td className="num">{n0(r.totalInput)}</td>
                    <td className="num">
                      {caching && r.totalInput ? `${Math.round((r.totalCached / r.totalInput) * 100)}%` : '—'}
                    </td>
                    <td className="num">{price ? usd(r.cost) : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="small muted">
          Tokens sent in all counts every request, so the early part of a conversation is counted once for every turn
          after it. Clearing a little on almost every turn breaks the cache each time, while compacting pays for a
          summary now and then: which is cheaper depends on the work, so compare the research agent with the coding
          agent.{' '}
          {caching
            ? 'With caching, a request reads the part the last request sent from the cache; clearing or compacting changes the start of the conversation, so the cache breaks once each time.'
            : 'Turn on prompt caching to see how much of each request was sent before.'}
        </p>
      </div>

      <h2>What fills it</h2>
      <div className="cw-three">
        <div className="card">
          <h3>Sent every time</h3>
          <p className="small">
            The system prompt, the tool definitions and files such as CLAUDE.md. Small, but on every request: the first
            thing to cache.
          </p>
        </div>
        <div className="card">
          <h3>The conversation</h3>
          <p className="small">
            Every message and reply so far. A chat adds a few hundred tokens a turn, so it rarely fills a large window.
          </p>
        </div>
        <div className="card">
          <h3>Tool results</h3>
          <p className="small">
            A file, a test log, a web page: thousands of tokens each, and they stay. This is what fills an agent&apos;s
            window.
          </p>
        </div>
      </div>
      <p>
        A full window is not the only cost. Every request sends everything, so a long run pays for its early turns again
        and again; a long input takes longer to read before the first word comes back; and in a very long context, the
        one fact the model needs is easier to miss.
      </p>

      <h2>Four ways to keep it in check</h2>
      <div className="cw-two">
        <div className="card">
          <h3>
            <i style={{ background: STRATEGY_COLOR.clear }} /> Clear old tool results
          </h3>
          <p className="small">
            Context editing removes old tool results before the model sees the conversation, leaving a short
            placeholder, and keeps the latest few. Good when results are read once and not needed again.
          </p>
          <CodeBlock html={S.clear} />
        </div>
        <div className="card">
          <h3>
            <i style={{ background: STRATEGY_COLOR.compact }} /> Compact
          </h3>
          <p className="small">
            Compaction replaces the conversation with a summary once it passes a trigger, 150K tokens by default. Pass
            the compaction block back with the rest of the reply. Claude Code does the same with <code>/compact</code>,
            and on its own when the window is nearly full.
          </p>
          <CodeBlock html={S.compact} />
        </div>
        <div className="card">
          <h3>
            <i style={{ background: STRATEGY_COLOR.subagent }} /> Hand the reading to a sub-agent
          </h3>
          <p className="small">
            A sub-agent starts with an empty window, reads what it is given and sends back a short summary. The main
            window stays small. The reading still happens, so it still costs: it just no longer piles up where the main
            agent works.
          </p>
        </div>
        <div className="card">
          <h3>
            <i style={{ background: 'var(--s1)' }} /> Write notes, start fresh
          </h3>
          <p className="small">
            Save what matters to a file or a memory store, then start a new conversation that reads only the notes. See{' '}
            <Link to="/agent-memory">agent memory</Link> and <Link to="/memory-stores">memory stores</Link>.
          </p>
        </div>
      </div>

      <h2>Caching is not more room</h2>
      <p>
        Prompt caching makes re-sending cheap: the part the last request sent is read from the cache at a twentieth to a
        tenth of the input price. It does not make the window any bigger. Caching and keeping the window small work
        together: cache what stays the same, and clear or compact what has stopped being useful.
      </p>
      <p className="small muted">
        The workloads are illustrative, with a fixed random sequence so every run is the same. The four strategies use
        simple settings (clear past 100K keeping three results, compact at 150K to a 4,000-token summary, billed as a
        model call of its own, sub-agent summaries of 500 tokens); the APIs let you choose your own. In Claude Code,{' '}
        <code>/context</code> shows what is filling its window: see chapter 11 of{' '}
        <Link to="/claude-code-inside">Inside Claude Code</Link>. For the arithmetic of re-sending, see{' '}
        <Link to="/context">Context and Cost</Link>.
      </p>
    </main>
  );
}
