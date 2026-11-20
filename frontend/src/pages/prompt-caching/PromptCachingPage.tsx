import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { CodeBlock } from '@/components/CodeBlock';
import { statusService } from '@/services';
import {
  type Block,
  type Event,
  type Request,
  type Rules,
  AZURE_MIN,
  AZURE_STEP,
  TTL_MINUTES,
  TURNS,
  simulate,
  usd,
} from './cachesim';
import { type Price, n0 } from '@/lib/format';
import * as S from './snippets';
import './prompt-caching.css';

const MODELS: { id: string; name: string; rules: Rules }[] = [
  { id: 'claude-haiku-5-5', name: 'Haiku 5.5', rules: 'anthropic' },
  { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5', rules: 'anthropic' },
  { id: 'claude-opus-5-5', name: 'Opus 5.5', rules: 'anthropic' },
  { id: 'gpt-5.4-mini', name: 'GPT-5.4 mini (Azure OpenAI)', rules: 'azure' },
];
const MS_DOCS = 'https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/prompt-caching';
const KIND_COLOR: Record<Block['kind'], string> = {
  tools: 'var(--ink2)',
  system: 'var(--s4)',
  user: 'var(--s1)',
  document: 'var(--s5)',
  reply: 'var(--brand)',
};
/** The steps of one request, and how long each shows (ms). */
const STEPS = ['send', 'compare', 'work', 'reply', 'done'] as const;
type Step = (typeof STEPS)[number];

/** One request drawn as a bar: each block as wide as its tokens, on a shared scale. */
function Bar({
  blocks,
  scale,
  mark,
  className,
}: {
  blocks: Block[];
  scale: number;
  mark?: (b: Block, i: number) => string;
  className?: string;
}) {
  return (
    <div className={`pc-bar ${className ?? ''}`}>
      {blocks.map((b, i) => (
        <span
          key={b.id + i}
          className={`pc-blk ${mark ? mark(b, i) : ''}`}
          style={{ width: `${(b.tokens / scale) * 100}%`, ['--c' as string]: KIND_COLOR[b.kind] }}
          title={`${b.label}: ${n0(b.tokens)} tokens`}
        />
      ))}
    </div>
  );
}

/** Prompt caching: what is sent every time, what the server reuses, and what it costs. */
export default function PromptCachingPage() {
  const [prices, setPrices] = useState<Record<string, Price> | null>(null);
  const [writeMultiplier, setWriteMultiplier] = useState(1.25);
  const [modelId, setModelId] = useState('claude-sonnet-5-5');
  const [caching, setCaching] = useState(true);
  const [events, setEvents] = useState<Record<number, Event>>({});
  const [turn, setTurn] = useState(0); // index of the request on screen
  const [step, setStep] = useState<Step>('send');
  const [auto, setAuto] = useState(false);
  const reduce = useRef(window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  useEffect(() => {
    statusService
      .status()
      .then((s) => {
        if (s.prices) setPrices(s.prices);
        if (s.cache?.write_multiplier) setWriteMultiplier(s.cache.write_multiplier);
      })
      .catch(() => setPrices(null));
  }, []);

  const price = prices?.[modelId] ?? null;
  const rules = MODELS.find((m) => m.id === modelId)!.rules;
  const azure = rules === 'azure';
  const on = azure || caching; // Azure caches supported models automatically, with no switch
  const run = useMemo(
    () => simulate(caching, events, price, writeMultiplier, rules),
    [caching, events, price, writeMultiplier, rules],
  );
  const req: Request = run[turn];
  const prev: Request | undefined = run[turn - 1];
  const scale = run[run.length - 1].total;

  // Play one request through its steps.
  useEffect(() => {
    if (reduce.current) {
      setStep('done');
      return;
    }
    setStep('send');
    const newShare = req.total ? (req.total - req.read) / req.total : 1;
    const times = [900, 1400, 700 + 1600 * newShare, 1100];
    const ids: number[] = [];
    let at = 0;
    STEPS.slice(1).forEach((s, i) => {
      at += times[i];
      ids.push(window.setTimeout(() => setStep(s), at));
    });
    return () => ids.forEach((id) => window.clearTimeout(id));
  }, [turn, req.total, req.read, req.miss, rules]);

  // Play all: move on a moment after each request finishes.
  useEffect(() => {
    if (!auto || step !== 'done') return;
    if (turn >= TURNS.length - 1) {
      setAuto(false);
      return;
    }
    const id = window.setTimeout(() => setTurn((t) => t + 1), 1500);
    return () => window.clearTimeout(id);
  }, [auto, step, turn]);

  const at = STEPS.indexOf(step);
  const shown = (s: Step) => at >= STEPS.indexOf(s);
  const totals = run
    .slice(0, turn + 1)
    .reduce((a, r) => ({ with: a.with + r.cost, without: a.without + r.costWithout }), { with: 0, without: 0 });
  // The first request with caching costs a little more (the write), so both bars share the larger total as their scale.
  const top = Math.max(totals.with, totals.without) || 1;
  const next = turn + 1;
  const setEvent = (patch: Event) => setEvents((e) => ({ ...e, [next]: { ...e[next], ...patch } }));
  const restart = () => {
    setTurn(0);
    setAuto(false);
    setEvents({});
  };
  const missText: Record<NonNullable<Request['miss']>, string> = {
    first: 'Nothing cached yet: the whole request is processed and written to the cache.',
    expired: `Nothing found: the entry ran out (${TTL_MINUTES} minutes with no request), so it is processed and written again.`,
    changed:
      'It matches up to the first change. Everything after that is processed again, even if it is the same as before.',
    off: 'Caching is off: the whole request is processed again, as it is every time.',
  };
  const p = price;

  return (
    <main className="page-prompt-caching">
      <div className="kicker">Cost and operations · Prompt caching</div>
      <h1>Prompt caching: you still send it all, the model doesn&apos;t redo it all</h1>
      <p className="lede">
        The API keeps nothing between requests, so your app sends the whole conversation every time. Before a model can
        answer, it must work through every token it is sent. Prompt caching keeps that work for the start of your
        request. When the next request starts the same way, the server reuses it, and only the new part at the end is
        worked through. That is why cached tokens are cheaper, and the reply starts sooner.
      </p>

      <div className="pc-controls card">
        <div className="pc-row">
          <div className="pc-seg" role="radiogroup" aria-label="Model">
            {MODELS.map((m) => (
              <button
                key={m.id}
                type="button"
                role="radio"
                aria-checked={m.id === modelId}
                className={m.id === modelId ? 'on' : ''}
                onClick={() => setModelId(m.id)}
              >
                {m.name}
              </button>
            ))}
          </div>
          <label className="pc-check">
            <input
              type="checkbox"
              checked={on}
              disabled={azure}
              title={azure ? 'Azure OpenAI caches supported models automatically; it cannot be turned off' : undefined}
              onChange={(e) => setCaching(e.target.checked)}
            />{' '}
            Prompt caching{azure && ' (always on)'}
          </label>
          <span className="small muted">
            {p
              ? azure
                ? `$${p.input} input · no charge to write · $${p.cache_read} cached input · $${p.output} output, per million tokens`
                : `$${p.input} input · $${(p.input * writeMultiplier).toFixed(2)} cache write · $${p.cache_read} cache read · $${p.output} output, per million tokens`
              : 'Start the backend to see prices; the tokens are the same.'}
          </span>
        </div>
        <div className="pc-row">
          <button
            type="button"
            className="btn primary"
            onClick={() => setTurn((t) => Math.min(TURNS.length - 1, t + 1))}
            disabled={turn >= TURNS.length - 1 || auto}
          >
            Send the next turn
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => (turn >= TURNS.length - 1 ? (restart(), setAuto(true)) : setAuto((x) => !x))}
          >
            {auto ? 'Stop' : 'Play them all'}
          </button>
          <button
            type="button"
            className={`btn${events[next]?.editSystem ? ' armed' : ''}`}
            aria-pressed={!!events[next]?.editSystem}
            onClick={() => setEvent({ editSystem: !events[next]?.editSystem })}
            disabled={turn >= TURNS.length - 1}
          >
            Change the system prompt first
          </button>
          <button
            type="button"
            className={`btn${events[next]?.wait ? ' armed' : ''}`}
            aria-pressed={!!events[next]?.wait}
            onClick={() => setEvent({ wait: events[next]?.wait ? 0 : 10 })}
            disabled={turn >= TURNS.length - 1}
          >
            Come back 10 minutes later
          </button>
          <button type="button" className="btn" onClick={restart}>
            Start again
          </button>
        </div>
      </div>

      <div className="pc-stage">
        <div className="pc-lanes">
          <div className="pc-turn">
            <b>
              Request {req.turn} of {TURNS.length}
            </b>
            <span className="muted">
              {' '}
              · minute {req.at.toFixed(1)} · {TURNS[turn].user.label}
            </span>
          </div>

          <div className={`pc-lane ${shown('send') ? 'on' : ''}`} key={`send-${turn}-${on}`}>
            <div className="pc-lane-head">
              <span className="pc-n">1</span> Your app sends the whole conversation{' '}
              <em>{n0(req.total)} tokens, every time</em>
            </div>
            <Bar
              blocks={req.blocks}
              scale={scale}
              className="pc-fly"
              mark={(_, i) => (i === req.blocks.length - 1 ? 'pc-new' : '')}
            />
          </div>

          <div className={`pc-lane ${shown('compare') ? 'on' : ''}`}>
            <div className="pc-lane-head">
              <span className="pc-n">2</span> The server checks its cache from the start
              <em>
                {on
                  ? req.read
                    ? `${n0(req.read)} tokens ${azure ? 'counted as cached' : 'match'}`
                    : 'no match'
                  : 'off'}
              </em>
            </div>
            {prev && on ? (
              <div className="pc-compare">
                <Bar
                  blocks={req.blocks}
                  scale={scale}
                  className={shown('compare') ? 'pc-scan' : ''}
                  mark={(_, i) => (!shown('compare') ? 'pc-dim' : i < req.matchUntil ? 'pc-hit' : 'pc-miss')}
                />
                {shown('compare') && (
                  <div className="pc-scanline" style={{ ['--to' as string]: `${(req.read / scale) * 100}%` }} />
                )}
              </div>
            ) : (
              <div className="pc-empty small muted">
                {on ? 'The cache is empty: this is the first request.' : 'Caching is off: nothing is kept.'}
              </div>
            )}
            {shown('compare') && (
              <p className="small pc-why">
                {req.miss
                  ? missText[req.miss]
                  : azure
                    ? `The start matches what was sent last time. Azure counts it in whole ${AZURE_STEP}-token steps after the first ${n0(AZURE_MIN)}, so a few matching tokens at the end of the match are processed again.`
                    : 'Everything up to the new message matches what was sent last time, and the entry is still alive.'}
              </p>
            )}
          </div>

          <div className={`pc-lane ${shown('work') ? 'on' : ''}`}>
            <div className="pc-lane-head">
              <span className="pc-n">3</span>{' '}
              {on ? 'The model works through only what is new' : 'The model works through all of it'}
              <em>
                {n0(req.total - req.read)} of {n0(req.total)} tokens
              </em>
            </div>
            <div className="pc-bar pc-work">
              <span className="pc-loaded" style={{ width: shown('work') ? `${(req.read / scale) * 100}%` : '0%' }}>
                {req.read / scale > 0.18 && 'reused from the cache'}
              </span>
              <span
                className="pc-fresh"
                style={{
                  width: shown('work') ? `${((req.total - req.read) / scale) * 100}%` : '0%',
                  transitionDuration: `${700 + 1600 * ((req.total - req.read) / Math.max(1, req.total))}ms`,
                }}
              >
                {(req.total - req.read) / scale > 0.18 && 'worked through by the model'}
              </span>
            </div>
          </div>

          <div className={`pc-lane ${shown('reply') ? 'on' : ''}`}>
            <div className="pc-lane-head">
              <span className="pc-n">4</span> It writes the reply <em>{n0(req.output)} output tokens, never cached</em>
            </div>
            <div className="pc-bar">
              <span className="pc-out" style={{ width: shown('reply') ? `${(req.output / scale) * 100}%` : '0%' }} />
            </div>
            <p className="small muted">The reply joins the conversation, so the next request sends it too.</p>
          </div>
        </div>

        <aside className="pc-side">
          <div className="pc-timer">
            <span className="small muted">Cache entry</span>
            {on ? (
              <>
                <div className="pc-ttl">
                  <span
                    style={{ width: `${((shown('compare') ? TTL_MINUTES : (req.ttlLeft ?? 0)) / TTL_MINUTES) * 100}%` }}
                  />
                </div>
                <span className="small">
                  {req.ttlLeft === null
                    ? 'none yet'
                    : req.miss === 'expired'
                      ? 'ran out before this request'
                      : `${req.ttlLeft.toFixed(1)} min left when it arrived`}
                  {shown('compare') && (azure ? ' · kept while in use' : ' · renewed to 5 min')}
                </span>
              </>
            ) : (
              <span className="small">off</span>
            )}
          </div>
          <div>
            <span className="small muted">What the reply reports</span>
            <pre className="pc-usage">
              {azure
                ? `usage: {
  prompt_tokens:          ${n0(req.total).padStart(7)}
  prompt_tokens_details: {
    cached_tokens:        ${n0(req.read).padStart(7)}
  }
  completion_tokens:      ${n0(req.output).padStart(7)}
}`
                : `usage: {
  cache_read_input_tokens:     ${n0(req.read).padStart(7)}
  cache_creation_input_tokens: ${n0(req.written).padStart(7)}
  input_tokens:                ${n0(req.uncached).padStart(7)}
  output_tokens:               ${n0(req.output).padStart(7)}
}`}
            </pre>
          </div>
          <table className="pc-bill">
            <tbody>
              <tr>
                <td>
                  <i style={{ background: 'var(--s3)' }} /> Read from the cache
                </td>
                <td className="num">{p ? usd((req.read * p.cache_read) / 1e6) : '—'}</td>
              </tr>
              <tr>
                <td>
                  <i style={{ background: 'var(--s2)' }} /> Written to the cache
                </td>
                <td className="num">
                  {azure ? 'no charge' : p ? usd((req.written * p.input * writeMultiplier) / 1e6) : '—'}
                </td>
              </tr>
              <tr>
                <td>
                  <i style={{ background: 'var(--s2)' }} /> Processed, not cached
                </td>
                <td className="num">{p ? usd((req.uncached * p.input) / 1e6) : '—'}</td>
              </tr>
              <tr>
                <td>
                  <i style={{ background: 'var(--brand)' }} /> Output
                </td>
                <td className="num">{p ? usd((req.output * p.output) / 1e6) : '—'}</td>
              </tr>
              <tr className="pc-total">
                <td>This request</td>
                <td className="num">{p ? usd(req.cost) : '—'}</td>
              </tr>
            </tbody>
          </table>
          <div className="pc-totals">
            <span className="small muted">So far, requests 1 to {req.turn}</span>
            <div className="pc-cmp">
              <span>{azure ? 'Cached (Azure)' : 'With caching'}</span>
              <span className="pc-cbar">
                <span style={{ width: on ? `${(totals.with / top) * 100}%` : '0%', background: 'var(--s3)' }} />
              </span>
              <b>{on ? (p ? usd(totals.with) : '—') : 'off'}</b>
            </div>
            <div className="pc-cmp">
              <span>{azure ? 'If nothing cached' : 'Without'}</span>
              <span className="pc-cbar">
                <span style={{ width: `${(totals.without / top) * 100}%`, background: 'var(--s2)' }} />
              </span>
              <b>{p ? usd(totals.without) : '—'}</b>
            </div>
          </div>
        </aside>
      </div>
      <p className="small muted pc-legend">
        {(
          [
            ['tools', 'tool definitions'],
            ['system', 'system prompt'],
            ['user', 'your messages'],
            ['document', 'a pasted document'],
            ['reply', 'replies'],
          ] as [Block['kind'], string][]
        ).map(([k, label]) => (
          <span key={k}>
            <i style={{ background: KIND_COLOR[k] }} /> {label}
          </span>
        ))}
        <span>Each bar is as long as the request, on one scale. The minutes are the story&apos;s, not real time.</span>
      </p>

      <h2>So is it sent or not?</h2>
      <div className="pc-two">
        <div className="card">
          <h3>Sent: always all of it</h3>
          <p className="small">
            Your app sends the tools, the system prompt and the whole conversation with every request, cached or not.
            The model needs all of it to answer, and the API remembers nothing between requests.
          </p>
        </div>
        <div className="card">
          <h3>Worked through: only what is new</h3>
          <p className="small">
            Reading a prompt means running every token through all the model&apos;s layers to build what its attention
            uses (the keys and values; see <Link to="/context">the KV cache</Link>). The cache keeps that result for the
            start of the request, so a matching start is loaded instead of worked through again.
          </p>
        </div>
      </div>

      <h2>The rules</h2>
      <ul className="pc-rules">
        <li>
          <b>An exact match, from the very first token.</b> The request is read in order: tools, then the system prompt,
          then the messages. One changed character ends the match there, and everything after it is worked through
          again. Try &ldquo;Change the system prompt first&rdquo;: the tools still match, the rest does not.
        </li>
        <li>
          <b>Five minutes, renewed by every use.</b> Each read resets the clock at no charge. Requests less than five
          minutes apart keep it warm for as long as they keep coming. A one-hour entry costs twice the input price to
          write instead of 1.25 times. It pays off when the gaps between requests are longer than five minutes but
          shorter than an hour.
        </li>
        <li>
          <b>Writing costs a little more; reading costs much less.</b> On Sonnet and Opus 5.5 a read is a twentieth of
          the input price; on Haiku 5.5, a tenth. Two requests that share a start already come out cheaper.
        </li>
        <li>
          <b>Output is never cached.</b> Replies and thinking are written fresh every time, at five times the input
          price.
        </li>
        <li>
          <b>Short starts are not cached.</b> On the newest models the start must be at least 512 tokens; shorter ones
          are simply not cached, with no error.
        </li>
        <li>
          <b>Check the usage fields.</b> <code>cache_read_input_tokens</code> is the proof. If it stays at zero,
          something near the start changes on every request: a date in the system prompt, tools in a different order, an
          edited message.
        </li>
      </ul>

      <h2>How Azure OpenAI does it</h2>
      <p>
        Claude on Microsoft Foundry is Anthropic&apos;s model and caches by Anthropic&apos;s rules, as above. GPT models
        on Azure OpenAI cache their own way. Pick &ldquo;GPT-5.4 mini (Azure OpenAI)&rdquo; above to play the same
        conversation by Azure&apos;s rules.
      </p>
      <div className="pc-scroll">
        <table className="pc-compare-table">
          <thead>
            <tr>
              <th />
              <th>Claude (Anthropic, and on Microsoft Foundry)</th>
              <th>GPT on Azure OpenAI (before GPT-5.6)</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Turning it on</td>
              <td>
                One field, <code>cache_control</code>, for automatic caching, or up to four breakpoints you place
              </td>
              <td>Automatic for supported models, with no way to turn it off</td>
            </tr>
            <tr>
              <td>Shortest start cached</td>
              <td>512 tokens on the newest models</td>
              <td>1,024 tokens, and the first 1,024 must match</td>
            </tr>
            <tr>
              <td>How much counts</td>
              <td>Everything up to the breakpoint, exactly</td>
              <td>The first 1,024 tokens, then whole 128-token steps</td>
            </tr>
            <tr>
              <td>Writing to the cache</td>
              <td>1.25 times the input price (five minutes), or 2 times (an hour)</td>
              <td>No extra charge</td>
            </tr>
            <tr>
              <td>Reading from it</td>
              <td>A twentieth to a tenth of the input price</td>
              <td>A discounted cached-input price: a tenth for GPT-5.4 mini in the lab&apos;s price list</td>
            </tr>
            <tr>
              <td>How long it lasts</td>
              <td>Five minutes, renewed by every read, or an hour</td>
              <td>Usually 5 to 10 minutes without use, and always gone within an hour of its last use</td>
            </tr>
            <tr>
              <td>Shown in the reply</td>
              <td>
                <code>cache_read_input_tokens</code>, <code>cache_creation_input_tokens</code>
              </td>
              <td>
                <code>prompt_tokens_details.cached_tokens</code>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="small muted">
        From Microsoft&apos;s{' '}
        <a href={MS_DOCS} target="_blank" rel="noreferrer">
          prompt caching guide
        </a>
        . GPT-5.6 and later change the rules: they can charge for writing to the cache and have options for how long an
        entry lasts, so check the guide for the model you deploy. Caches are not shared between Azure subscriptions.
      </p>

      <h2>Turning it on</h2>
      <CodeBlock html={S.auto} />
      <p className="small muted">
        Put what never changes first and what changes last: see{' '}
        <Link to="/context-engineering">context engineering</Link>. Watch caching across a whole agent run on{' '}
        <Link to="/context-window">the context window</Link>, and its effect on a bill on{' '}
        <Link to="/effort-and-cost">model, effort and cost</Link>. The conversation here is illustrative; prices are the
        lab&apos;s list prices (<code>python/common.py</code>).
      </p>
    </main>
  );
}
