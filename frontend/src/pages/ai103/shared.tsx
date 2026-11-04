import { useState, type ReactNode } from 'react';
import './ai103.css';

/** Dollars: four places under 10 cents, so a fraction of a cent still shows. */
export const usd = (v: number) => `$${v < 0.1 ? v.toFixed(4) : v.toFixed(2)}`;

/** One call at a time for a panel: its result, whether it is running, and the error to show. */
export function useCall<T>() {
  const [result, setResult] = useState<T | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function run(call: () => Promise<T>) {
    setBusy(true);
    setError('');
    try {
      setResult(await call());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return { result, busy, error, run, setResult };
}

export function Chips<T>({
  items,
  label,
  onPick,
  active,
}: {
  items: T[];
  label: (t: T) => string;
  onPick: (t: T) => void;
  active?: string;
}) {
  return (
    <div className="az-chips">
      {items.map((t) => (
        <button
          key={label(t)}
          type="button"
          className={`az-chip${active === label(t) ? ' on' : ''}`}
          onClick={() => onPick(t)}
        >
          {label(t)}
        </button>
      ))}
    </div>
  );
}

export function Problem({ error }: { error: string }) {
  return error ? <p className="az-bad small">{error}</p> : null;
}

export function Panel({ title, children, id }: { title: string; children: ReactNode; id?: string }) {
  return (
    <section className="az-panel" id={id}>
      <h3>{title}</h3>
      {children}
    </section>
  );
}

/** Text with each of `spans` marked where it appears. */
export function Marked({ text, spans }: { text: string; spans: string[] }) {
  const found = spans.filter((s) => s && text.includes(s));
  if (!found.length) return <>{text}</>;
  const parts: ReactNode[] = [];
  let rest = text;
  let key = 0;
  while (rest) {
    const next = found
      .map((s) => ({ s, at: rest.indexOf(s) }))
      .filter((x) => x.at >= 0)
      .sort((a, b) => a.at - b.at)[0];
    if (!next) {
      parts.push(rest);
      break;
    }
    parts.push(rest.slice(0, next.at), <mark key={key++}>{next.s}</mark>);
    rest = rest.slice(next.at + next.s.length);
  }
  return <>{parts}</>;
}

/** A file from the page as base64, for JSON bodies. */
export function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Could not read the file.'));
    reader.readAsDataURL(file);
  });
}
