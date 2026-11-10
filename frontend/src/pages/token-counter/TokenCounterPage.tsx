import { useEffect, useMemo, useRef, useState } from 'react';
import { tokenCounterService, type CounterModel, type CountResult, type Segment } from '@/services/tokenCounterService';
import { Breakdown } from './Breakdown';
import './token-counter.css';

const WAIT_MS = 600; // count once typing pauses, not on every key
const COMPARE_WAIT_MS = 1500;
const DEFAULT_MODEL = 'claude-haiku-5-5';

const SAMPLES: { label: string; system: string; prompt: string }[] = [
  {
    label: 'English prose',
    system: 'You are a helpful assistant for an HR team. Answer from the staff handbook only.',
    prompt:
      'How many days of annual leave do I get in my first year, and can I carry unused days over into next year? I joined in March.',
  },
  {
    label: 'Product names',
    system: '',
    prompt:
      'We run PostgreSQL, Apache Kafka, OpenSearch and ClickHouse on Kubernetes across AWS, Google Cloud and Azure, with Grafana dashboards and PagerDuty alerts — so the team ships features instead of running infrastructure.',
  },
  {
    label: 'Code',
    system: '',
    prompt:
      'def total(items):\n    """Sum the price of every item, ignoring None."""\n    return sum(i["price"] for i in items if i.get("price") is not None)\n\nWhy does this fail on [{"price": "3.50"}]?',
  },
  {
    label: 'JSON data',
    system: '',
    prompt:
      '[{"id": 1042, "status": "shipped", "customer_id": "C-77", "tracking": "ZX93"}, {"id": 1043, "status": "pending", "customer_id": "C-12", "tracking": null}]\nWhich orders have not shipped?',
  },
  {
    label: 'Welsh and Polish',
    system: '',
    prompt:
      'Bore da! Hoffwn i archebu ystafell ddwbl am ddwy noson. Dzień dobry, chciałbym zarezerwować pokój dwuosobowy na dwie noce. 😀',
  },
];

const words = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0);
const usd = (n: number) => (n === 0 ? 'free' : n < 0.01 ? `$${n.toFixed(6)}` : `$${n.toFixed(4)}`);
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The text coloured token by token, as the model's tokenizer cut it. */
function Pieces({ segments }: { segments: Segment[] }) {
  let colour = 0;
  return (
    <>
      {segments.map((s, i) => {
        const c = s.tokens > 0 ? colour++ % 6 : -1;
        return (
          <span
            key={i}
            className={`tc-tok c${c}`}
            title={`${JSON.stringify(s.text)}: ${s.tokens} token${s.tokens === 1 ? '' : 's'}`}
          >
            {s.text}
            {s.tokens > 1 && <sup>×{s.tokens}</sup>}
          </span>
        );
      })}
    </>
  );
}

/** Lab 51: count a prompt's tokens on Claude, GPT, Gemini, Llama, Mistral, Qwen, DeepSeek and the local model, see
 * where the tokenizer cuts it, and compare them all. Counting is free and sends nothing to a model. */
export default function TokenCounterPage() {
  const [models, setModels] = useState<CounterModel[]>([]);
  const [loadError, setLoadError] = useState('');
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [system, setSystem] = useState('');
  const [prompt, setPrompt] = useState('');
  const [result, setResult] = useState<CountResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [comparing, setComparing] = useState(false);
  const [compare, setCompare] = useState<CountResult[] | null>(null);
  const [compareBusy, setCompareBusy] = useState(false);
  const latest = useRef(0);
  const latestCompare = useRef(0);
  const compared = useRef(false); // after the first comparison, wait for typing to pause before the next

  useEffect(() => {
    tokenCounterService
      .models()
      .then((m) => {
        setModels(m);
        if (!m.some((x) => x.id === DEFAULT_MODEL) && m[0]) setModel(m[0].id);
      })
      .catch((err) => setLoadError(errorText(err)));
  }, []);

  const groups = useMemo(() => {
    const out: [string, CounterModel[]][] = [];
    for (const m of models) {
      const g = out.find(([p]) => p === m.provider);
      if (g) g[1].push(m);
      else out.push([m.provider, [m]]);
    }
    return out;
  }, [models]);
  const chosen = models.find((m) => m.id === model);

  useEffect(() => {
    if (!prompt.trim() || !models.length) {
      setResult(null);
      return;
    }
    const id = ++latest.current;
    const timer = window.setTimeout(async () => {
      setBusy(true);
      setError('');
      try {
        const r = await tokenCounterService.count({ model, system, prompt });
        if (id === latest.current) setResult(r);
      } catch (err) {
        if (id === latest.current) setError(errorText(err));
      } finally {
        if (id === latest.current) setBusy(false);
      }
    }, WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [model, system, prompt, models.length]);

  useEffect(() => {
    if (!comparing || !prompt.trim()) return;
    const id = ++latestCompare.current;
    const timer = window.setTimeout(
      async () => {
        setCompareBusy(true);
        try {
          const rows = await tokenCounterService.compare({ system, prompt });
          if (id === latestCompare.current) {
            setCompare(rows);
            compared.current = true;
          }
        } catch (err) {
          if (id === latestCompare.current) setError(errorText(err));
        } finally {
          if (id === latestCompare.current) setCompareBusy(false);
        }
      },
      compared.current ? COMPARE_WAIT_MS : 0,
    );
    return () => window.clearTimeout(timer);
  }, [comparing, system, prompt]);

  const text = system + prompt;
  const current = result && result.id === model ? result : null;
  const maxTokens = Math.max(1, ...(compare ?? []).map((r) => r.tokens ?? 0));
  const notReady = models.filter((m) => !m.ready).length;
  const used = current?.request_tokens ?? current?.tokens ?? 0;

  return (
    <main className="page-token-counter">
      <div className="kicker">Lab 51 · Token counter</div>
      <h1>How many tokens is my prompt?</h1>
      <p className="lede">
        Paste a prompt and pick a model. You see the count, the cost of sending it, and where that model&apos;s
        tokenizer cuts the text. Below, compare every family at once: Claude, GPT, Gemini, Llama, Mistral, Qwen,
        DeepSeek and the local model. Counting is free and sends nothing to a model.
      </p>
      {loadError && <p className="tc-error">{loadError}</p>}

      <div className="tc-samples">
        <span className="small muted">Try:</span>
        {SAMPLES.map((s) => (
          <button
            key={s.label}
            className="chip-btn"
            onClick={() => {
              setSystem(s.system);
              setPrompt(s.prompt);
            }}
          >
            {s.label}
          </button>
        ))}
      </div>

      <div className="tc-layout">
        <div className="tc-inputs">
          <label className="tc-field">
            <span>System prompt (optional)</span>
            <textarea rows={3} value={system} onChange={(e) => setSystem(e.target.value)} placeholder="You are…" />
          </label>
          <label className="tc-field">
            <span>Prompt</span>
            <textarea
              rows={10}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Type or paste your prompt here"
            />
          </label>
        </div>

        <div className="tc-result">
          <div className="tc-picker">
            <select value={model} onChange={(e) => setModel(e.target.value)} aria-label="Model">
              {groups.map(([provider, list]) => (
                <optgroup key={provider} label={provider}>
                  {list.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            {chosen && (
              <span className={`tc-badge ${chosen.exact ? 'exact' : 'estimate'}`}>
                {chosen.exact ? 'Exact' : '≈ Estimate'}
              </span>
            )}
          </div>
          {chosen && <p className="small muted tc-source">{chosen.note}</p>}

          <div className="tc-cards">
            <div className="tc-card big">
              <span>Tokens</span>
              <b>{current?.tokens ?? (busy ? '…' : '—')}</b>
              <small>
                {current && current.system_tokens
                  ? `${current.system_tokens} system + ${current.prompt_tokens} prompt`
                  : 'the text itself'}
              </small>
            </div>
            <div className="tc-card big">
              <span>Cost per call</span>
              <b>{current?.cost_usd != null ? usd(current.cost_usd) : '—'}</b>
              <small>
                {current?.cost_usd != null
                  ? `${usd(current.cost_usd * 1000)} per 1,000 · input only`
                  : 'depends on where it runs'}
              </small>
            </div>
            <div className="tc-card">
              <span>As a request</span>
              <b>{current?.request_tokens ?? '—'}</b>
              <small>{current?.request_tokens != null ? 'with message framing' : 'framing not counted here'}</small>
            </div>
            <div className="tc-card">
              <span>Characters · words</span>
              <b>
                {text.length.toLocaleString()} · {words(text).toLocaleString()}
              </b>
              <small>
                {current?.tokens ? `${(text.length / current.tokens).toFixed(1)} characters per token` : ' '}
              </small>
            </div>
          </div>

          {current?.context ? (
            <div className="tc-context">
              <div className="small">
                {used.toLocaleString()} / {current.context.toLocaleString()} context
                <span>{((used / current.context) * 100).toFixed(3)}%</span>
              </div>
              <div className="tc-meter">
                <div style={{ width: `${Math.max(0.5, (used / current.context) * 100)}%` }} />
              </div>
            </div>
          ) : null}

          {error && <p className="tc-error">{error}</p>}
          {current?.segments ? (
            <div className="tc-pieces" aria-label="The text cut into tokens">
              {current.segments.system.length > 0 && (
                <>
                  <div className="tc-label small muted">System prompt</div>
                  <Pieces segments={current.segments.system} />
                  <div className="tc-label small muted">Prompt</div>
                </>
              )}
              <Pieces segments={current.segments.prompt} />
            </div>
          ) : current && chosen ? (
            <Breakdown model={model} name={chosen.name} system={system} prompt={prompt} />
          ) : !prompt.trim() ? (
            <p className="small muted tc-pieces">Type a prompt to see it cut into tokens.</p>
          ) : null}
        </div>
      </div>

      <section className="tc-compare">
        <h2>Every model, side by side</h2>
        {!comparing ? (
          <>
            <p className="small muted">
              Counts the same text on every model at once. Click a row to see that model&apos;s tokens above.
              {notReady > 0 &&
                ` The first time, the backend downloads ${notReady} published tokenizers from Hugging Face (about 90 MB, once).`}
            </p>
            <button className="btn" onClick={() => setComparing(true)} disabled={!prompt.trim()}>
              Compare every model
            </button>
          </>
        ) : !compare ? (
          <p className="small muted">Counting on every model…</p>
        ) : (
          <div className="table-wrap">
            <table className="t">
              <thead>
                <tr>
                  <th>Model</th>
                  <th className="num">Tokens</th>
                  <th className="tc-barcell" aria-hidden="true"></th>
                  <th className="num">As a request</th>
                  <th className="num">Cost per call</th>
                  <th className="num">Per 1,000</th>
                </tr>
              </thead>
              <tbody className={compareBusy ? 'tc-stale' : ''}>
                {compare.map((r) => (
                  <tr key={r.id} className={r.id === model ? 'tc-current' : ''} onClick={() => setModel(r.id)}>
                    <td>
                      <span className="small muted">{r.provider}</span>
                      <br />
                      {r.name}{' '}
                      <span className={`tc-badge ${r.exact ? 'exact' : 'estimate'}`}>{r.exact ? 'Exact' : '≈'}</span>
                    </td>
                    {r.tokens == null ? (
                      <td colSpan={5} className="tc-error">
                        {r.error}
                      </td>
                    ) : (
                      <>
                        <td className="num tc-big">{r.tokens}</td>
                        <td className="tc-barcell">
                          <div className="tc-rowbar" style={{ width: `${(r.tokens / maxTokens) * 100}%` }} />
                        </td>
                        <td className="num">{r.request_tokens ?? '—'}</td>
                        <td className="num">{r.cost_usd != null ? usd(r.cost_usd) : '—'}</td>
                        <td className="num">{r.cost_usd != null ? usd(r.cost_usd * 1000) : '—'}</td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="tc-notes">
        <h2>Reading the numbers</h2>
        <ul>
          <li>
            <b>Every family cuts text differently,</b> because each learnt its own vocabulary. Compare models by tokens
            times price, not by price per token.
          </li>
          <li>
            <b>Claude&apos;s newer tokenizer counts more.</b> Claude Opus 4.8 and the 5.5 models share one tokenizer;
            Sonnet 4.6 and Haiku 4.5 use an older one. On the product-names sample the newer one counts noticeably more
            tokens for the same text, so re-measure costs when you change model generation.
          </li>
          <li>
            <b>Exact or estimate.</b> Claude&apos;s counts come from Anthropic&apos;s <code>count_tokens</code>; GPT,
            Llama, Mistral, Qwen and DeepSeek from their published tokenizers, run on the backend; the local model from
            its own server. Gemini is an estimate: Google publishes no tokenizer, so Gemma 2&apos;s stands in.
          </li>
          <li>
            <b>Tokens counts the text; as a request adds the framing</b> (turn markers) every message carries. For GPT
            the framing was measured against what Azure billed: 6 tokens for a message, 4 more with a system prompt.
          </li>
          <li>
            <b>This is input only.</b> The reply is billed as output tokens, usually several times the input price, and
            a conversation sends its whole history again on every turn unless it is cached.
          </li>
          <li>
            The <a href="/tokens">Tokens lab</a> explains how a tokenizer learns its pieces.{' '}
            <code>python/01_count_tokens.py</code> counts with Claude from the command line.
          </li>
        </ul>
      </section>
    </main>
  );
}
