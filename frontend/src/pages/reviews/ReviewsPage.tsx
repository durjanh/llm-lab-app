import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  reviewsService,
  type Analysis,
  type AnalyzeResult,
  type ClaudeReading,
  type ProductReview,
  type ReviewsInfo,
  type Sentiment,
} from '@/services';
import { modelNameStart } from '@/lib/models';
import './reviews.css';

const FEATURES: { kind: string; name: string }[] = [
  { kind: 'LanguageDetection', name: 'Language detection' },
  { kind: 'SentimentAnalysis', name: 'Sentiment analysis + opinion mining' },
  { kind: 'KeyPhraseExtraction', name: 'Key phrase extraction' },
  { kind: 'EntityRecognition', name: 'Named entity recognition' },
];
const SENTIMENTS: Sentiment[] = ['positive', 'mixed', 'neutral', 'negative'];
// The entity categories the dashboard is about. Azure Language calls a brand an Organization.
const WANTED: Record<string, string> = { Product: 'Products', Organization: 'Brands', Location: 'Locations' };
const SAMPLE_OWN =
  'Der Lieferant war schnell, aber das Netzteil von Vela ist nach einer Woche kaputtgegangen. Ich wohne in Wien und warte seit zehn Tagen auf Ersatz.';

const pct = (x: number) => `${Math.round(x * 100)}%`;
const money = (x: number) => (x < 0.01 ? `$${x.toFixed(5)}` : `$${x.toFixed(2)}`);
const stars = (n: number) => '★★★★★'.slice(0, n) + '☆☆☆☆☆'.slice(0, 5 - n);
const day = (iso: string) =>
  new Date(`${iso}T12:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

/** A review whose stars and text disagree: four or five stars on a negative text, or one or two on a positive one. */
function disagrees(review: { rating?: number }, a?: Analysis): boolean {
  const label = a?.sentiment?.label;
  if (!review.rating || !label) return false;
  return (review.rating >= 4 && label === 'negative') || (review.rating <= 2 && label === 'positive');
}

function count<T>(items: T[], key: (t: T) => string): [string, number][] {
  const m = new Map<string, number>();
  for (const t of items) m.set(key(t), (m.get(key(t)) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

function Tag({ tone, children }: { tone?: string; children: ReactNode }) {
  return <span className={`rv-tag ${tone ?? ''}`}>{children}</span>;
}

function Bars({ rows, total, tone }: { rows: [string, number][]; total: number; tone?: (k: string) => string }) {
  return (
    <div className="rv-bars">
      {rows.map(([k, n]) => (
        <div key={k} className="rv-bar">
          <span className="rv-bar-k">{k}</span>
          <span className="rv-bar-track">
            <i className={tone?.(k) ?? ''} style={{ width: total ? `${(n / total) * 100}%` : 0 }} />
          </span>
          <span className="rv-bar-n">
            {n} ({total ? pct(n / total) : '0%'})
          </span>
        </div>
      ))}
    </div>
  );
}

function ScoreBars({ scores }: { scores: { positive: number; neutral?: number; negative: number } }) {
  return (
    <div className="rv-scores">
      {(['positive', 'neutral', 'negative'] as const).map((k) => (
        <div key={k} className="rv-bar">
          <span className="rv-bar-k">{k}</span>
          <span className="rv-bar-track">
            <i className={k} style={{ width: pct(scores[k] ?? 0) }} />
          </span>
          <span className="rv-bar-n">{(scores[k] ?? 0).toFixed(2)}</span>
        </div>
      ))}
    </div>
  );
}

/** Everything Azure Language returned for one review, and Claude's reading beside it once asked for. */
function Details(props: {
  text: string;
  rating?: number;
  analysis?: Analysis;
  reading?: ClaudeReading;
  busy: boolean;
  onAnalyse: () => void;
  onCompare: () => void;
}) {
  const { text, rating, analysis: a, reading: c, busy } = props;
  const s = a?.sentiment;
  const others = a?.entities.filter((e) => !WANTED[e.category]) ?? [];
  return (
    <div className="rv-details">
      <p className="rv-text">{text}</p>
      {!a && (
        <button className="btn primary" disabled={busy} onClick={props.onAnalyse}>
          {busy ? 'Analysing…' : 'Analyse with Azure Language'}
        </button>
      )}
      {a && (
        <div className="rv-analysis">
          <h4>Azure Language</h4>
          <div className="rv-field">
            <span className="rv-label">Detected language</span>
            <span>
              <b>{a.language?.name ?? 'unknown'}</b> <code>{a.language?.iso}</code>, confidence{' '}
              {a.language?.confidence.toFixed(2)}
              {a.language && a.sent_as !== a.language.iso && (
                <span className="muted small">
                  {' '}
                  · sent to the other features as <code>{a.sent_as}</code>
                </span>
              )}
            </span>
          </div>
          {s && (
            <div className="rv-field">
              <span className="rv-label">Sentiment</span>
              <div>
                <span className="chips">
                  <Tag tone={s.label}>{s.label}</Tag>
                  {disagrees({ rating }, a) && <Tag tone="warn">disagrees with {rating} stars</Tag>}
                </span>
                <ScoreBars scores={s.scores} />
              </div>
            </div>
          )}
          {s && (
            <div className="rv-field">
              <span className="rv-label">By sentence</span>
              <ol className="rv-sentences">
                {s.sentences.map((x, i) => (
                  <li key={i}>
                    <Tag tone={x.label}>{x.label}</Tag> {x.text}
                    {x.opinions.length > 0 && (
                      <div className="rv-opinions small">
                        {x.opinions.map((o, j) => (
                          <span key={j}>
                            <b className={o.sentiment}>{o.target}</b>
                            {o.assessments.length > 0 &&
                              ` ← ${o.assessments.map((v) => `${v.negated ? 'not ' : ''}${v.text}`).join(', ')}`}
                          </span>
                        ))}
                      </div>
                    )}
                  </li>
                ))}
              </ol>
            </div>
          )}
          <div className="rv-field">
            <span className="rv-label">Key phrases</span>
            <div className="chips">
              {a.key_phrases.map((k) => (
                <Tag key={k}>{k}</Tag>
              ))}
            </div>
          </div>
          <div className="rv-field">
            <span className="rv-label">Entities</span>
            <div className="chips">
              {a.entities
                .filter((e) => WANTED[e.category])
                .map((e, i) => (
                  <Tag key={i} tone={`ent-${e.category}`}>
                    {e.text} <small>{e.category === 'Organization' ? 'brand' : e.category.toLowerCase()}</small>
                  </Tag>
                ))}
              {others.length > 0 && (
                <span className="muted small">
                  and {others.length} more: {others.map((e) => `${e.text} (${e.subcategory || e.category})`).join(', ')}
                </span>
              )}
            </div>
          </div>
          {a.problems.length > 0 && <p className="small rv-warn">{a.problems.join(' · ')}</p>}
        </div>
      )}
      {a && !c && (
        <button className="btn" disabled={busy} onClick={props.onCompare}>
          {busy ? 'Asking the language model…' : 'Ask a language model the same'}
        </button>
      )}
      {c && (
        <div className="rv-analysis claude">
          <h4>
            {modelNameStart(c.model)} <span className="muted small">{c.model}, one structured-output call</span>
          </h4>
          <div className="rv-field">
            <span className="rv-label">Language</span>
            <span>
              <b>{c.reading.language.name}</b> <code>{c.reading.language.iso}</code>
            </span>
          </div>
          <div className="rv-field">
            <span className="rv-label">Sentiment</span>
            <span className="chips">
              <Tag tone={c.reading.sentiment}>{c.reading.sentiment}</Tag>
              <span className="muted small">a label only: a language model has no calibrated scores to give</span>
            </span>
          </div>
          <div className="rv-field">
            <span className="rv-label">Opinions</span>
            <div className="rv-opinions small">
              {c.reading.opinions.map((o, j) => (
                <span key={j}>
                  <b className={o.sentiment}>{o.target}</b> ← {o.assessment}
                </span>
              ))}
            </div>
          </div>
          <div className="rv-field">
            <span className="rv-label">Key phrases</span>
            <div className="chips">
              {c.reading.key_phrases_english.map((k) => (
                <Tag key={k}>{k}</Tag>
              ))}
            </div>
          </div>
          <div className="rv-field">
            <span className="rv-label">Entities</span>
            <div className="chips">
              {c.reading.entities.map((e, i) => (
                <Tag key={i} tone={`ent-${e.category === 'Brand' ? 'Organization' : e.category}`}>
                  {e.text} <small>{e.category.toLowerCase()}</small>
                </Tag>
              ))}
              {c.reading.entities.length === 0 && <span className="muted small">none named</span>}
            </div>
          </div>
          <div className="rv-field">
            <span className="rv-label">In English</span>
            <span className="small">{c.reading.english}</span>
          </div>
          <p className="muted small">
            {c.input_tokens.toLocaleString()} input and {c.output_tokens.toLocaleString()} output tokens ·{' '}
            {money(c.cost_usd)}
            {c.reused && ' (already paid for this session)'}
          </p>
        </div>
      )}
    </div>
  );
}

export default function ReviewsPage() {
  const [info, setInfo] = useState<ReviewsInfo | null>(null);
  const [analyses, setAnalyses] = useState<Record<string, Analysis>>({});
  const [readings, setReadings] = useState<Record<string, ClaudeReading>>({});
  const [run, setRun] = useState<AnalyzeResult | null>(null);
  const [spent, setSpent] = useState(0);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [open, setOpen] = useState<ProductReview | null>(null);
  const [filter, setFilter] = useState({ q: '', category: '', language: '', rating: '', sentiment: '' });
  const [own, setOwn] = useState(SAMPLE_OWN);
  const [ownId, setOwnId] = useState('');

  const problem = (e: Error) =>
    setError(e.message.includes('404') ? 'Restart the lab backend: this page is newer than it.' : e.message);

  useEffect(() => {
    reviewsService
      .info()
      .then((i) => {
        setInfo(i);
        setAnalyses(i.analysed);
        setSpent(i.spent_usd);
      })
      .catch(problem);
  }, []);

  useEffect(() => {
    if (!open) return;
    const close = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(null);
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [open]);

  const analyse = async (body: { ids?: string[]; text?: string }, what: string) => {
    setBusy(what);
    setError('');
    try {
      const out = await reviewsService.analyze(body);
      setAnalyses((a) => ({ ...a, ...out.analyses }));
      setSpent(out.spent_usd);
      if (out.analysed) setRun(out);
      return out;
    } catch (e) {
      problem(e as Error);
    } finally {
      setBusy('');
    }
  };

  const compare = async (key: string, body: { id?: string; text?: string }) => {
    setBusy(key);
    setError('');
    try {
      const out = await reviewsService.compare(body);
      setReadings((r) => ({ ...r, [key]: out }));
      setSpent(out.spent_usd);
    } catch (e) {
      problem(e as Error);
    } finally {
      setBusy('');
    }
  };

  const reviews = info?.reviews ?? [];
  const done = reviews.filter((r) => analyses[r.id]);
  const languageOf = (r: ProductReview) => analyses[r.id]?.language?.name ?? '';
  const shown = reviews.filter((r) => {
    const a = analyses[r.id];
    const q = filter.q.toLowerCase();
    return (
      (!q || `${r.product} ${r.text} ${r.customer}`.toLowerCase().includes(q)) &&
      (!filter.category || r.category === filter.category) &&
      (!filter.language || languageOf(r) === filter.language) &&
      (!filter.rating || r.rating === Number(filter.rating)) &&
      (!filter.sentiment || a?.sentiment?.label === filter.sentiment)
    );
  });

  const summary = useMemo(() => {
    const all = done.map((r) => analyses[r.id]);
    const entities = (cat: string) =>
      count(
        all.flatMap((a) => [...new Set(a.entities.filter((e) => e.category === cat).map((e) => e.text))]),
        (t) => t,
      ).slice(0, 8);
    return {
      languages: count(done, languageOf),
      sentiment: SENTIMENTS.map((s) => [s, all.filter((a) => a.sentiment?.label === s).length] as [string, number]),
      phrases: count(
        all.flatMap((a) => a.key_phrases.map((k) => k.toLowerCase())),
        (t) => t,
      ).slice(0, 14),
      entities: Object.keys(WANTED).map((cat) => [cat, entities(cat)] as const),
      disagree: done.filter((r) => disagrees(r, analyses[r.id])),
      noise: all.reduce((n, a) => n + a.entities.filter((e) => !WANTED[e.category]).length, 0),
      entityTotal: all.reduce((n, a) => n + a.entities.length, 0),
    };
  }, [analyses, info]);

  const rated = [5, 4, 3, 2, 1].map(
    (n) => [`${n} ★`, reviews.filter((r) => r.rating === n).length] as [string, number],
  );
  const average = reviews.length ? reviews.reduce((t, r) => t + r.rating, 0) / reviews.length : 0;
  const claudeCosts = Object.values(readings).filter((r) => !r.reused);
  const claudePerReview = claudeCosts.length
    ? claudeCosts.reduce((t, r) => t + r.cost_usd, 0) / claudeCosts.length
    : null;
  const price = info?.price_per_1k_records ?? 1;
  const allCost = reviews.reduce((t, r) => t + Math.max(1, Math.ceil(r.text.length / 1000)) * 4, 0) * (price / 1000);

  return (
    <main className="page-reviews">
      <div className="kicker">Lab 36 · Azure Language in Foundry Tools</div>
      <h1>Reading reviews in every language</h1>
      <p className="lede">
        A global retailer gets thousands of product reviews a day, in dozens of languages. Reading and sorting them by
        hand does not scale. Azure Language detects each review's language, scores its sentiment, pulls out the phrases
        customers mention, and recognises the products, brands and places they name. This dashboard runs it on 30
        reviews in eight languages, and lets you ask Claude to do the same job beside it.
      </p>

      <div className="rv-stack small">
        <span>
          <b>Service</b> Azure Language, REST API {info?.api_version ?? ''}, signed in with your Azure login
        </span>
        <span>
          <b>Price</b> ${price.toFixed(2)} per 1,000 text records: one per feature for every started 1,000 characters
        </span>
        <span>
          <b>This session</b> {money(spent)}
        </span>
      </div>
      {info && !info.configured && (
        <p className="rv-bad small">
          Needs Azure Language: set AZURE_LANGUAGE_ENDPOINT in .env to an AI Services or Language resource, run az
          login, and restart the backend. The reviews below load without it.
        </p>
      )}
      {error && <p className="rv-bad small">{error}</p>}

      <section className="rv-dash" aria-label="Customer review dashboard">
        <header className="rv-head">
          <div>
            <h2>Customer Review Dashboard</h2>
            <p className="muted small">Monitor and analyse customer feedback across every product category</p>
          </div>
          <span className="rv-retailer">{info?.retailer ?? ''}</span>
        </header>

        <div className="rv-tiles">
          <div className="rv-tile">
            <span className="k">Total reviews</span>
            <span className="v">{reviews.length}</span>
            <span className="k">{reviews.filter((r) => r.verified).length} verified</span>
          </div>
          <div className="rv-tile">
            <span className="k">Average rating</span>
            <span className="v">{average.toFixed(1)}</span>
            <span className="k">out of 5.0</span>
          </div>
          <div className="rv-tile">
            <span className="k">Product categories</span>
            <span className="v">{info?.categories.length ?? 0}</span>
            <span className="k">active lines</span>
          </div>
          <div className="rv-tile">
            <span className="k">Languages</span>
            <span className="v">{done.length ? summary.languages.length : '–'}</span>
            <span className="k">{done.length ? 'detected by Azure Language' : 'not detected yet'}</span>
          </div>
        </div>

        <div className="rv-run">
          <button
            className="btn primary"
            disabled={!info?.configured || !!busy || done.length === reviews.length}
            onClick={() => void analyse({}, 'all')}
          >
            {busy === 'all'
              ? 'Analysing 30 reviews…'
              : done.length === reviews.length
                ? 'All reviews analysed'
                : `Analyse all ${reviews.length} reviews (about ${money(allCost)})`}
          </button>
          {run && (
            <span className="small muted">
              {run.analysed} reviews · {Object.values(run.requests).reduce((t, n) => t + n, 0)} requests · {run.records}{' '}
              text records · {money(run.cost_usd)}
            </span>
          )}
          {!run && done.length > 0 && done.length < reviews.length && (
            <span className="small muted">{done.length} analysed so far</span>
          )}
        </div>

        <div className="rv-panels">
          <div className="rv-panel">
            <h3>Rating distribution</h3>
            <Bars rows={rated} total={reviews.length} />
          </div>
          <div className="rv-panel">
            <h3>Sentiment, from the text</h3>
            {done.length ? (
              <>
                <Bars rows={summary.sentiment} total={done.length} tone={(k) => k} />
                {summary.disagree.length > 0 && (
                  <p className="small rv-warn">
                    {summary.disagree.length} review{summary.disagree.length === 1 ? '' : 's'} where the stars and the
                    text disagree:{' '}
                    {summary.disagree.map((r, i) => (
                      <span key={r.id}>
                        {i > 0 && ', '}
                        <button className="rv-link" onClick={() => setOpen(r)}>
                          {r.product}
                        </button>
                      </span>
                    ))}
                  </p>
                )}
              </>
            ) : (
              <p className="muted small">Analyse the reviews to read sentiment from what customers wrote.</p>
            )}
          </div>
        </div>

        {done.length > 0 && (
          <div className="rv-panels three">
            <div className="rv-panel">
              <h3>What customers mention most</h3>
              <div className="chips">
                {summary.phrases.map(([k, n]) => (
                  <Tag key={k}>
                    {k}
                    {n > 1 && <small> ×{n}</small>}
                  </Tag>
                ))}
              </div>
              <p className="muted small">
                Key phrases stay in each review's language, so “Akku”, “batterie” and “battery” count separately.
              </p>
            </div>
            {summary.entities.map(([cat, rows]) => (
              <div key={cat} className="rv-panel">
                <h3>{WANTED[cat]} named</h3>
                <div className="chips">
                  {rows.map(([k, n]) => (
                    <Tag key={k} tone={`ent-${cat}`}>
                      {k}
                      {n > 1 && <small> ×{n}</small>}
                    </Tag>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="rv-filters">
          <input
            type="text"
            placeholder="Search reviews…"
            value={filter.q}
            onChange={(e) => setFilter({ ...filter, q: e.target.value })}
            aria-label="Search reviews"
          />
          <select
            value={filter.category}
            onChange={(e) => setFilter({ ...filter, category: e.target.value })}
            aria-label="Category"
          >
            <option value="">All categories</option>
            {info?.categories.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
          <select
            value={filter.language}
            onChange={(e) => setFilter({ ...filter, language: e.target.value })}
            aria-label="Language"
            disabled={!done.length}
          >
            <option value="">All languages</option>
            {summary.languages.map(([l]) => (
              <option key={l}>{l}</option>
            ))}
          </select>
          <select
            value={filter.rating}
            onChange={(e) => setFilter({ ...filter, rating: e.target.value })}
            aria-label="Rating"
          >
            <option value="">All ratings</option>
            {[5, 4, 3, 2, 1].map((n) => (
              <option key={n} value={n}>
                {n} stars
              </option>
            ))}
          </select>
          <select
            value={filter.sentiment}
            onChange={(e) => setFilter({ ...filter, sentiment: e.target.value })}
            aria-label="Sentiment"
            disabled={!done.length}
          >
            <option value="">All sentiment</option>
            {SENTIMENTS.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
          <span className="small muted">
            Showing {shown.length} of {reviews.length} reviews
          </span>
        </div>

        <div className="rv-cards">
          {shown.map((r) => {
            const a = analyses[r.id];
            return (
              <button key={r.id} className="rv-card" onClick={() => setOpen(r)}>
                <span className="rv-card-top">
                  <b>{r.product}</b>
                  <span className="rv-stars" aria-label={`${r.rating} out of 5`}>
                    {stars(r.rating)}
                  </span>
                </span>
                <span className="rv-card-tags">
                  <Tag tone="cat">{r.category}</Tag>
                  {a?.language && <Tag>{a.language.iso.toUpperCase()}</Tag>}
                  {a?.sentiment && <Tag tone={a.sentiment.label}>{a.sentiment.label}</Tag>}
                  {disagrees(r, a) && <Tag tone="warn">stars disagree</Tag>}
                  {r.verified && <span className="rv-verified">✓ Verified</span>}
                </span>
                <span className="rv-card-text">{r.text}</span>
                <span className="rv-card-foot">
                  <span>{r.customer}</span>
                  <span>{day(r.date)}</span>
                </span>
              </button>
            );
          })}
        </div>
      </section>

      {open && (
        <div className="rv-overlay" onClick={() => setOpen(null)}>
          <div
            className="rv-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Review details"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="rv-modal-head">
              <div>
                <span className="muted small">Review details</span>
                <h3>{open.product}</h3>
                <span className="rv-card-tags">
                  <Tag tone="cat">{open.category}</Tag>
                  {open.verified && <Tag tone="positive">Verified purchase</Tag>}
                  <span className="rv-stars">{stars(open.rating)}</span> {open.rating}.0 out of 5
                </span>
                <span className="muted small">
                  {open.customer} · {day(open.date)}
                </span>
              </div>
              <button className="btn small" onClick={() => setOpen(null)} aria-label="Close">
                ✕
              </button>
            </header>
            <Details
              text={open.text}
              rating={open.rating}
              analysis={analyses[open.id]}
              reading={readings[open.id]}
              busy={busy === open.id || busy === 'all'}
              onAnalyse={() => void analyse({ ids: [open.id] }, open.id)}
              onCompare={() => void compare(open.id, { id: open.id })}
            />
          </div>
        </div>
      )}

      <h2>How it works</h2>
      <p>
        You send text; each feature sends back structured results. The page sends every review to language detection
        first, then to the other three features with the detected language set, because they assume English when no
        language is given.
      </p>
      <div className="grid3 rv-how">
        <div className="card">
          <h3>Detected language</h3>
          <p className="small">
            The primary language of the text, as a name and an ISO 639-1 code, with a confidence score between 0 and 1:
            the closer to 1, the surer the model is. Chinese comes back as <code>zh_chs</code>, which the other features
            do not accept; they want <code>zh-hans</code>, so the backend translates it.
          </p>
        </div>
        <div className="card">
          <h3>Sentiment and opinions</h3>
          <p className="small">
            A label for every sentence and for the whole review, with positive, neutral and negative scores that add up
            to 1. A review with a positive and a negative sentence is <i>mixed</i>. Opinion mining links targets
            (“cable”) to what was said about them (“stopped charging”), in the languages that support it.
          </p>
        </div>
        <div className="card">
          <h3>Key phrases and entities</h3>
          <p className="small">
            Key phrases are the main talking points, in the review's own language. Entities are names with a category:{' '}
            <b>Product</b>, <b>Organization</b> (which is how a brand comes back) and <b>Location</b>, among others such
            as DateTime and Quantity, each with a confidence score.
          </p>
        </div>
      </div>
      <div className="table-wrap">
        <table className="t">
          <thead>
            <tr>
              <th>Feature</th>
              <th className="num">Documents per request</th>
              <th className="num">Requests for 30 reviews</th>
              <th>Model version</th>
            </tr>
          </thead>
          <tbody>
            {FEATURES.map((f) => (
              <tr key={f.kind}>
                <td>{f.name}</td>
                <td className="num">{info?.limits[f.kind]?.toLocaleString() ?? ''}</td>
                <td className="num">{run?.requests[f.kind] ?? (info ? Math.ceil(30 / info.limits[f.kind]) : '')}</td>
                <td>
                  <code>{run?.model_versions[f.kind] ?? 'after a run'}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small muted">
        The limits are Microsoft's: more documents in one request is an error, so the backend splits the list and sends
        the parts at once. Each feature has its own model, updated on its own schedule.
      </p>

      <h2>What to check before you trust it</h2>
      <div className="grid2">
        <div className="card">
          <h3>Stars against text</h3>
          <p className="small">
            {summary.disagree.length
              ? `${summary.disagree.length} of ${done.length} analysed reviews have stars and text that disagree.`
              : 'After a run, reviews whose stars and text disagree are flagged here and on their cards.'}{' '}
            Sometimes the text is right: “Five stars for the fast delivery, but the cable stopped charging” is a
            complaint. Sometimes the model is: a four-star review that ends on one small criticism can come back
            negative, because the last sentence weighs heavily. Read a sample before you report a trend.
          </p>
        </div>
        <div className="card">
          <h3>Entities are noisy</h3>
          <p className="small">
            {summary.entityTotal
              ? `${summary.noise} of the ${summary.entityTotal} entities found are outside Product, Organization and Location, and are left out of the panels above.`
              : 'Many entities fall outside the three categories the dashboard needs.'}{' '}
            Within the three, check the labels: an invented brand can come back as a Location, and the same brand can be
            an Organization in one language and a Product in another. A list of your own brands and products, matched in
            code, is more reliable for counting them.
          </p>
        </div>
        <div className="card">
          <h3>One language per review</h3>
          <p className="small">
            Detection returns the main language. A review that switches language halfway (try the mesh Wi-Fi review) is
            analysed as if all of it were in the first.
          </p>
        </div>
        <div className="card">
          <h3>Phrases do not merge across languages</h3>
          <p className="small">
            Azure Language does not translate, so the same complaint in eight languages is eight different phrases.
            Translate first (Azure Translator is a separate service), or use a model that can report phrases in English.
          </p>
        </div>
      </div>

      <h2>Try your own review</h2>
      <div className="card">
        <textarea rows={3} value={own} maxLength={5000} onChange={(e) => (setOwn(e.target.value), setOwnId(''))} />
        <div className="row" style={{ marginTop: 10 }}>
          <button
            className="btn primary"
            disabled={!info?.configured || !!busy || !own.trim()}
            onClick={async () => {
              const out = await analyse({ text: own.trim() }, 'own');
              if (out) setOwnId(Object.keys(out.analyses)[0]);
            }}
          >
            {busy === 'own' ? 'Analysing…' : 'Analyse with Azure Language'}
          </button>
          <span className="small muted">
            {Math.max(1, Math.ceil(own.length / 1000)) * 4} text records, about{' '}
            {money(Math.max(1, Math.ceil(own.length / 1000)) * 4 * (price / 1000))}
          </span>
        </div>
        {ownId && analyses[ownId] && (
          <Details
            text={own}
            analysis={analyses[ownId]}
            reading={readings[ownId]}
            busy={busy === ownId}
            onAnalyse={() => undefined}
            onCompare={() => void compare(ownId, { text: own.trim() })}
          />
        )}
      </div>

      <h2>Azure Language or a language model?</h2>
      <p>
        Microsoft is retiring sentiment analysis, opinion mining and key phrase extraction from Azure Language on 31
        March 2029, and directs new projects to models in Microsoft Foundry. Open a few reviews and press “Ask a
        language model the same” to compare them on the same text.
      </p>
      <div className="table-wrap">
        <table className="t">
          <thead>
            <tr>
              <th></th>
              <th>Azure Language</th>
              <th>A language model (Claude here)</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Cost per 1,000 short reviews</td>
              <td>${(price * 4).toFixed(2)}: four features, one text record each</td>
              <td>
                {claudePerReview !== null
                  ? `about ${money(claudePerReview * 1000)}, from the ${claudeCosts.length} review${claudeCosts.length === 1 ? '' : 's'} you compared`
                  : 'compare a review to measure it'}
              </td>
            </tr>
            <tr>
              <td>What comes back</td>
              <td>Fixed fields and categories, with confidence scores</td>
              <td>Whatever schema you ask for: your own categories, a translation, a reason</td>
            </tr>
            <tr>
              <td>Consistency</td>
              <td>A versioned model per feature, which a request can pin with modelVersion</td>
              <td>Can vary between runs; pin the model and test with an evaluation set</td>
            </tr>
            <tr>
              <td>Languages</td>
              <td>Each feature has its own supported list</td>
              <td>Any language the model reads; phrases can come back in English for counting</td>
            </tr>
            <tr>
              <td>Future</td>
              <td>Sentiment, opinions and key phrases retire on 31 March 2029</td>
              <td>The path Microsoft recommends for new projects</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="takeaways">
        <h3>Engineering takeaways</h3>
        <ul>
          <li>Detect the language first and pass it on: the other features assume English without it.</li>
          <li>Respect each feature's documents-per-request limit, and send the batches at once.</li>
          <li>Keep results and never pay twice for the same text: the backend reuses every analysis this session.</li>
          <li>Check stars against text, and count your own brands with a list rather than trusting entity labels.</li>
          <li>
            For new work, compare a language model on your own reviews: it can use your categories and report in one
            language.
          </li>
        </ul>
      </div>

      <h2>Run it yourself</h2>
      <pre className="code">{`# .env: any AI Services or Language resource; keys can stay switched off
AZURE_LANGUAGE_ENDPOINT=https://<your-resource>.cognitiveservices.azure.com
az login                      # your account needs a role such as Cognitive Services Language Reader
python -m backend --budget 1  # then open /reviews`}</pre>
      <p className="small muted">
        Larkspur Direct, its customers and the brands Lumio, Vela, Porta, Nexwave and Ardent are invented. Prices are
        Azure's list prices for the Standard tier in UK South; check the pricing page before relying on them.
      </p>
    </main>
  );
}
