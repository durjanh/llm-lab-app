import { useEffect, useRef, useState } from 'react';
import { messagesService, type TokenBreakdown } from '@/services/messagesService';

const WAIT_MS = 900;

/** 0, 1, 2 or 3+ tokens: the colour of a word. */
const band = (n: number) => (n <= 0 ? 0 : Math.min(n, 3));

/** How the prompt's whitespace shows in a chip: a leading space as ·, a new line as ↵. */
const shown = (text: string) => text.replace(/\n/g, '↵').replace(/\t/g, '⇥').replace(/^ /, '·');

/**
 * Where the tokens go, for a model whose tokenizer is not published (Claude, the local model). The API returns only a
 * total, so the backend counts the prompt as it grows, a word at a time: the rise at each word is the tokens it added.
 */
export function Breakdown({
  model,
  name,
  system,
  prompt,
}: {
  model: string;
  name: string;
  system: string;
  prompt: string;
}) {
  const [data, setData] = useState<TokenBreakdown | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const latest = useRef(0);

  useEffect(() => {
    if (!prompt.trim()) return;
    const id = ++latest.current;
    const timer = window.setTimeout(async () => {
      setBusy(true);
      setError('');
      try {
        const r = await messagesService.tokenBreakdown({ model, system, prompt });
        if (id === latest.current) setData(r);
      } catch (err) {
        if (id === latest.current) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (id === latest.current) setBusy(false);
      }
    }, WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [model, system, prompt]);

  const parts = data
    ? [
        { key: 'framing', label: 'Message framing', n: data.framing },
        { key: 'system', label: 'System prompt', n: data.system },
        { key: 'prompt', label: 'Your prompt', n: data.prompt },
      ].filter((p) => p.n > 0)
    : [];
  const counts = [1, 2, 3].map((b) => data?.words.filter((w) => band(w.tokens) === b).length ?? 0);
  const costly = data
    ? [...data.words]
        .sort((a, b) => b.tokens - a.tokens)
        .filter((w) => w.tokens > 1)
        .slice(0, 5)
    : [];

  return (
    <div className="tc-breakdown">
      <p className="small muted">
        {name}&apos;s tokenizer is not published and its API returns only a total, so its exact pieces cannot be shown.
        Instead the prompt is counted as it grows, one word at a time, and each word is coloured by how many tokens it
        added. The steps add up to the total exactly.
      </p>
      {error && <p className="tc-error">{error}</p>}
      {busy && !data && <p className="small muted">Counting word by word…</p>}
      {data && (
        <>
          <p>
            <b>{data.total}</b> tokens as a request = {parts.map((p) => `${p.n} ${p.label.toLowerCase()}`).join(' + ')}
            {busy ? <span className="small muted"> · updating…</span> : null}
          </p>
          <div className="tc-bar" role="img" aria-label={parts.map((p) => `${p.label} ${p.n}`).join(', ')}>
            {parts.map((p) => (
              <div key={p.key} className={`tc-seg ${p.key}`} style={{ flexGrow: p.n }} title={`${p.label}: ${p.n}`}>
                {p.label} {p.n}
              </div>
            ))}
          </div>
          <div className="tc-legend small">
            <span className="tc-word b1">1 token</span>
            <span className="tc-word b2">2 tokens</span>
            <span className="tc-word b3">3 or more</span>
            <span className="tc-word b0">0 (merged into the next)</span>
          </div>
          <div className="tc-words">
            {data.words.map((w, i) => (
              <span key={i}>
                {w.text.includes('\n') && <br />}
                <span
                  className={`tc-word b${band(w.tokens)}`}
                  title={`${JSON.stringify(w.text)} added ${w.tokens} token${w.tokens === 1 ? '' : 's'}`}
                >
                  {shown(w.text.replace(/^\s*\n/, ''))}
                  <sup>{w.tokens}</sup>
                </span>
              </span>
            ))}
          </div>
          <p className="small">
            {counts[0]} words cost 1 token, {counts[1]} cost 2 and {counts[2]} cost 3 or more.
            {costly.length > 0 && (
              <> Most expensive: {costly.map((w) => `“${w.text.trim()}” (${w.tokens})`).join(', ')}.</>
            )}
            {data.grouped && ' The prompt is long, so a few words are measured together.'}
          </p>
        </>
      )}
    </div>
  );
}
