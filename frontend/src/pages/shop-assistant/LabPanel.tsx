import { useEffect, useRef, useState } from 'react';
import type { ImportState, IsolationAttempt, ShopInfo, ShopService } from '@/services/shopService';
import { EditProducts, EmbeddingQueuePanel } from './CatalogueEditor';
import { ApiError } from '@/services/apiClient';
import { message } from './errors';

/* The lab's side of the shop: make or import the data (with progress, counts and the data version) and "Try to
   break it", which runs the live attempts to read another shopper's data and shows how each one was refused. */

const running = (s?: ImportState | null) => s?.state === 'running';

export function LabPanel({
  service,
  info,
  onRefresh,
  onAsk,
}: {
  service: ShopService;
  info: ShopInfo | null;
  onRefresh: () => void;
  /** Opens the chat with a question typed in, to find an edited product. */
  onAsk?: (text: string) => void;
}) {
  const [nudge, setNudge] = useState(0);
  const [job, setJob] = useState<ImportState | null>(info?.data.import ?? null);
  const [problem, setProblem] = useState('');
  const [kind, setKind] = useState<'products' | 'customers' | 'orders'>('products');
  const [busy, setBusy] = useState(false);
  const [attempts, setAttempts] = useState<IsolationAttempt[] | null>(null);
  const [checking, setChecking] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  useEffect(() => setJob(info?.data.import ?? null), [info]);

  // Poll while a job runs; one timer at a time, stopped when the tab closes.
  useEffect(() => {
    if (!running(job)) return;
    let live = true;
    const id = window.setTimeout(() => {
      service
        .importState()
        .then((s) => {
          if (!live) return;
          setJob(s);
          if (!running(s)) onRefresh();
        })
        .catch((e) => live && setProblem(message(e)));
    }, 1500);
    return () => {
      live = false;
      window.clearTimeout(id);
    };
  }, [job, service, onRefresh]);

  const act = async (fn: () => Promise<ImportState>) => {
    if (busy) return;
    setBusy(true);
    setProblem('');
    try {
      setJob(await fn());
    } catch (e) {
      setProblem(message(e));
    } finally {
      setBusy(false);
    }
  };

  /** A new shop replaces every shopper and basket: when some are in use, the server says so and we ask first. */
  const generate = async (n: number): Promise<ImportState> => {
    try {
      return await service.generate(n);
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 409 && e.type === 'in_use')) throw e;
      if (!window.confirm(`${e.message}\n\nGenerate a new shop anyway?`)) return job ?? (await service.importState());
      return service.generate(n, true);
    }
  };

  const check = async () => {
    if (checking) return;
    setChecking(true);
    setProblem('');
    try {
      const r = await service.isolationCheck();
      setAttempts(Array.isArray(r?.attempts) ? r.attempts : []);
    } catch (e) {
      setProblem(message(e));
    } finally {
      setChecking(false);
    }
  };

  const d = info?.data;
  const pct = job && job.total ? Math.min(100, Math.round((job.done / job.total) * 100)) : 0;
  return (
    <section className="sh-lab">
      <h1>Lab: the data behind the shop</h1>
      <p>
        Everything here is invented. The generator makes products, demo shoppers and their orders from a fixed seed, so
        the same size always gives the same shop. Product text is embedded with the local embedding model for search.
      </p>

      <div className="sh-stats">
        {(
          [
            ['Products', d?.products],
            ['Shoppers', d?.customers],
            ['Orders', d?.orders],
            ['Embedded', d?.embedded],
          ] as const
        ).map(([label, n]) => (
          <div key={label}>
            <strong>{(n ?? 0).toLocaleString('en-GB')}</strong>
            <span>{label}</span>
          </div>
        ))}
        <div>
          <strong>{String(d?.data_version ?? '–')}</strong>
          <span>Data version</span>
        </div>
      </div>
      {d?.embed_model && <p className="sh-fine">Embedding model: {d.embed_model}</p>}

      <h2>Make the data</h2>
      <div className="sh-row">
        {(info?.sizes ?? [20000, 100000, 1000000]).map((n) => (
          <button
            key={n}
            type="button"
            className="sh-btn ghost"
            disabled={busy || running(job)}
            onClick={() => act(() => generate(n))}
          >
            {n.toLocaleString('en-GB')} products
          </button>
        ))}
      </div>

      <h2>Import your own file</h2>
      <p className="sh-fine">
        JSON Lines or CSV. Products: id, title, brand, category, subcategory, description, attributes (as JSON),
        price_pence, stock, rating, review_count. Customers and orders follow the same pattern. Every row is checked; a
        file with a bad row is not applied at all, and the reasons are listed.
      </p>
      <div className="sh-row">
        <label>
          <span className="sh-hidden">What the file holds</span>
          <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            <option value="products">Products</option>
            <option value="customers">Customers</option>
            <option value="orders">Orders</option>
          </select>
        </label>
        <input ref={file} type="file" accept=".jsonl,.json,.csv" aria-label="File to import" />
        <button
          type="button"
          className="sh-btn ghost"
          disabled={busy || running(job)}
          onClick={() => {
            const f = file.current?.files?.[0];
            if (!f) return setProblem('Choose a file first.');
            void act(() => service.importFile(f, kind));
          }}
        >
          Import
        </button>
      </div>

      {job && job.state !== 'idle' && (
        <div className="sh-job" role="status" aria-live="polite">
          <div className="sh-row spread">
            <span>
              {job.state === 'running' ? 'Working' : job.state === 'done' ? 'Finished' : job.state}: {job.message}
            </span>
            {running(job) && (
              <button type="button" className="sh-link" onClick={() => act(() => service.stopImport())}>
                Stop
              </button>
            )}
          </div>
          {job.total > 0 && (
            <div className="sh-progress" aria-label={`${pct}% done`}>
              <i style={{ width: `${pct}%` }} />
            </div>
          )}
          <span className="sh-fine">
            {job.done.toLocaleString('en-GB')} of {job.total.toLocaleString('en-GB')}
          </span>
        </div>
      )}

      <h2>Edit products</h2>
      <p>
        Change a product's words and the background worker embeds it again by itself; change only its price or stock and
        it does not. Then ask the chat for it to see the new text found by meaning.
      </p>
      <EditProducts
        service={service}
        onAsk={onAsk}
        onChanged={() => {
          setNudge((n) => n + 1);
          onRefresh();
        }}
      />

      <h2>Embedding queue</h2>
      <EmbeddingQueuePanel service={service} nudge={nudge} />

      <h2>Try to break it</h2>
      <p>
        Runs live attempts to see another shopper's orders, basket or details: asking the assistant outright, product
        descriptions with hidden instructions, and guessed order ids. Each should be refused by the database itself.
      </p>
      <button type="button" className="sh-btn" disabled={checking} onClick={check}>
        {checking ? 'Running the attempts…' : 'Run the attempts'}
      </button>
      {attempts && (
        <ul className="sh-attempts">
          {attempts.length === 0 && <li>No attempts came back.</li>}
          {attempts.map((a, i) => (
            <li key={i} className={a.ok ? 'ok' : 'bad'}>
              <strong>{a.ok ? 'Held' : 'Leaked'}</strong> {a.name}
              {a.attempt && <span className="sh-fine"> · {a.attempt}</span>}
              <div>{a.outcome}</div>
              {a.detail && <div className="sh-fine">{a.detail}</div>}
            </li>
          ))}
        </ul>
      )}
      {problem && <p className="sh-error">{problem}</p>}
    </section>
  );
}
