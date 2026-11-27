import { useEffect, useState } from 'react';
import type { EmbeddingQueue, Product, ShopService } from '@/services/shopService';
import {
  CATEGORIES,
  changedFields,
  embedLabel,
  EMPTY_FORM,
  formFrom,
  queueDelay,
  queueSummary,
  readForm,
  reembeds,
  type ProductForm,
} from './catalogue';
import { message } from './errors';
import { money } from './state';

/* The Lab's catalogue tools: edit, add or delete a product, and watch the embedding queue as the background worker
   embeds what changed. A change to the text re-embeds the product; a price or stock change does not. */

export function EditProducts({
  service,
  onAsk,
  onChanged,
}: {
  service: ShopService;
  onAsk?: (text: string) => void;
  onChanged: () => void;
}) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Product[] | null>(null);
  const [product, setProduct] = useState<Product | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<ProductForm>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [sure, setSure] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [done, setDone] = useState('');

  // While the open product waits to be embedded, check it again every two seconds.
  const pendingId = product?.embed_state === 'pending' ? product.id : null;
  useEffect(() => {
    if (!pendingId) return;
    let live = true;
    const id = window.setTimeout(() => {
      service
        .product(pendingId)
        .then((p) => live && setProduct((cur) => (cur?.id === p.id ? p : cur)))
        .catch(() => undefined);
    }, 2000);
    return () => {
      live = false;
      window.clearTimeout(id);
    };
  }, [service, pendingId, product]);

  const find = async () => {
    const term = q.trim();
    if (!term) return;
    setProblems([]);
    try {
      const r = await service.search({ query: term, limit: 8 });
      setResults(r.items);
    } catch (e) {
      setProblems([message(e)]);
    }
  };

  const open = async (id: string) => {
    setProblems([]);
    setDone('');
    setSure(false);
    try {
      const p = await service.product(id);
      setProduct(p);
      setCreating(false);
      setForm(formFrom(p));
    } catch (e) {
      setProblems([message(e)]);
    }
  };

  const save = async () => {
    if (busy) return;
    setDone('');
    if (creating) {
      const { input, problems: bad } = readForm(form);
      if (bad.length) return setProblems(bad);
      setBusy(true);
      try {
        const p = await service.createProduct(input);
        setProduct(p);
        setCreating(false);
        setForm(formFrom(p));
        setDone(`Added ${p.title} (${p.id}). The worker will embed it; then the chat can find it.`);
        onChanged();
      } catch (e) {
        setProblems([message(e)]);
      } finally {
        setBusy(false);
      }
      return;
    }
    if (!product) return;
    const { patch, problems: bad } = changedFields(product, form);
    if (bad.length) return setProblems(bad);
    if (!Object.keys(patch).length) return setProblems(['Nothing has changed.']);
    setBusy(true);
    setProblems([]);
    try {
      const p = await service.updateProduct(product.id, patch);
      setProduct(p);
      setForm(formFrom(p));
      setDone(
        reembeds(patch)
          ? 'Saved. The text changed, so the product will be embedded again: watch the queue below.'
          : 'Saved. Only the price or stock changed, so it is not embedded again.',
      );
      onChanged();
    } catch (e) {
      setProblems([message(e)]);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!product || busy) return;
    if (!sure) return setSure(true);
    setBusy(true);
    try {
      await service.deleteProduct(product.id);
      setDone(`Deleted ${product.title}.`);
      setResults((r) => r?.filter((x) => x.id !== product.id) ?? null);
      setProduct(null);
      setForm(EMPTY_FORM);
      setSure(false);
      onChanged();
    } catch (e) {
      setProblems([message(e)]);
    } finally {
      setBusy(false);
    }
  };

  const field = (k: keyof ProductForm) => ({
    value: form[k],
    onChange: (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value })),
  });
  const editing = creating || !!product;
  return (
    <div className="sh-editor">
      <form
        className="sh-row"
        onSubmit={(e) => {
          e.preventDefault();
          void find();
        }}
      >
        <label>
          <span className="sh-hidden">Find a product to edit</span>
          <input
            value={q}
            maxLength={200}
            placeholder="Find a product by name or id"
            onChange={(e) => setQ(e.target.value)}
          />
        </label>
        <button type="submit" className="sh-btn ghost">
          Find
        </button>
        <button
          type="button"
          className="sh-btn ghost"
          onClick={() => {
            setCreating(true);
            setProduct(null);
            setForm(EMPTY_FORM);
            setProblems([]);
            setDone('');
          }}
        >
          Add a product
        </button>
      </form>
      {results && (
        <ul className="sh-picklist">
          {results.length === 0 && <li className="sh-fine">Nothing matched.</li>}
          {results.map((p) => (
            <li key={p.id}>
              <button type="button" className={product?.id === p.id ? 'on' : ''} onClick={() => open(p.id)}>
                <strong>{p.title}</strong>{' '}
                <span className="sh-fine">
                  · {p.id} · {money(p.price_pence)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {editing && (
        <div className="sh-form sh-edit-form">
          <h3>{creating ? 'New product' : `Editing ${product?.id}`}</h3>
          {product && (
            <p className={`sh-embed-state ${product.embed_state ?? ''}`} aria-live="polite">
              {embedLabel(product.embed_state)}
              {product.embedded_with ? ` · ${product.embedded_with}` : ''}
              {product.embed_error ? ` · ${product.embed_error}` : ''}
            </p>
          )}
          <label>
            Title
            <input maxLength={200} {...field('title')} />
          </label>
          <div className="sh-form-pair">
            <label>
              Brand
              <input maxLength={80} {...field('brand')} />
            </label>
            <label>
              Department
              <select {...field('category')}>
                {CATEGORIES.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
          </div>
          <label>
            Kind of thing
            <input maxLength={80} placeholder="e.g. Jackets" {...field('subcategory')} />
          </label>
          <label>
            Description
            <textarea rows={4} maxLength={4000} {...field('description')} />
          </label>
          <div className="sh-form-pair">
            <label>
              Price (£)
              <input inputMode="decimal" {...field('price')} />
            </label>
            <label>
              Stock
              <input inputMode="numeric" {...field('stock')} />
            </label>
          </div>
          <div className="sh-row">
            <button type="button" className="sh-btn" disabled={busy} onClick={save}>
              {creating ? 'Add product' : 'Save changes'}
            </button>
            {product && (
              <button type="button" className="sh-btn ghost" disabled={busy} onClick={remove}>
                {sure ? 'Delete for good?' : 'Delete'}
              </button>
            )}
            {product && onAsk && (
              <button
                type="button"
                className="sh-link"
                onClick={() => onAsk(`Have you got anything like ${product.title}?`)}
              >
                Find it with the chat
              </button>
            )}
          </div>
        </div>
      )}
      {done && (
        <p className="sh-fine" role="status">
          {done}
        </p>
      )}
      {problems.map((p) => (
        <p key={p} className="sh-error">
          {p}
        </p>
      ))}
    </div>
  );
}

export function EmbeddingQueuePanel({ service, nudge }: { service: ShopService; nudge: number }) {
  const [queue, setQueue] = useState<EmbeddingQueue | null>(null);
  const [problem, setProblem] = useState('');
  const [retrying, setRetrying] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  // One request at a time: the next is scheduled only after the last one answered.
  useEffect(() => {
    let live = true;
    let timer = 0;
    service
      .embedding()
      .then((q) => {
        if (!live) return;
        setQueue(q);
        setProblem('');
        timer = window.setTimeout(() => setTick((t) => t + 1), queueDelay(q));
      })
      .catch((e) => {
        if (!live) return;
        setProblem(message(e));
        timer = window.setTimeout(() => setTick((t) => t + 1), queueDelay(null, true));
      });
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [service, tick, nudge]);

  const retry = async (ids?: string[]) => {
    if (retrying) return;
    setRetrying(ids?.[0] ?? 'all');
    try {
      setQueue(await service.retryEmbedding(ids));
    } catch (e) {
      setProblem(message(e));
    } finally {
      setRetrying(null);
    }
  };

  const failed = queue?.failed ?? [];
  return (
    <div className="sh-queue">
      {queue ? (
        <>
          <p className="sh-hidden" aria-live="polite">
            {queueSummary(queue)}
          </p>
          <div className="sh-stats">
            <div>
              <strong>{queue.pending.toLocaleString('en-GB')}</strong>
              <span>Waiting</span>
            </div>
            <div>
              <strong>{queue.done.toLocaleString('en-GB')}</strong>
              <span>Embedded</span>
            </div>
            <div>
              <strong>{failed.length.toLocaleString('en-GB')}</strong>
              <span>Failed</span>
            </div>
            <div>
              <strong>{Math.round(queue.rate_per_min ?? 0).toLocaleString('en-GB')}</strong>
              <span>Per minute</span>
            </div>
          </div>
          <p className="sh-fine">
            Model: {queue.model || 'not set'}
            {queue.last_batch_at
              ? ` · last batch ${new Date(queue.last_batch_at).toLocaleTimeString('en-GB')}`
              : ' · no batch yet'}
            {queue.pending > 0 ? ' · refreshing every few seconds' : ''}
          </p>
          {failed.length > 0 && (
            <>
              <div className="sh-row spread">
                <h3>Failed after their retries</h3>
                <button type="button" className="sh-btn ghost small" disabled={!!retrying} onClick={() => retry()}>
                  Retry all
                </button>
              </div>
              <ul className="sh-attempts">
                {failed.map((f) => (
                  <li key={f.id} className="bad">
                    <div className="sh-row spread">
                      <span>
                        <strong>{f.title}</strong>{' '}
                        <span className="sh-fine">
                          · {f.id} · {f.attempts} attempts
                        </span>
                      </span>
                      <button type="button" className="sh-link" disabled={!!retrying} onClick={() => retry([f.id])}>
                        {retrying === f.id ? 'Retrying…' : 'Retry'}
                      </button>
                    </div>
                    <div className="sh-fine">{f.error}</div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      ) : (
        !problem && <p className="sh-fine">Loading the queue…</p>
      )}
      {problem && <p className="sh-error">{problem}</p>}
    </div>
  );
}
