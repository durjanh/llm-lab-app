import { useEffect, useState, type ReactNode } from 'react';
import { message } from './errors';
import type {
  Basket,
  Order,
  Product,
  Recommendation,
  ReturnRecord,
  SearchFilters,
  ShopInfo,
  ShopService,
} from '@/services/shopService';
import { dept, OrderCard, ProductCard, ProductPic, Stars, StockNote } from './parts';
import { asList, money, type AccountTab } from './state';

/* The shop's own screens: the home page (offers, departments, product rows), search results with filters, a
   product page, the basket drawer and the account area. All of it reads the same catalogue and the shopper's own
   basket, orders and wish list that the assistant uses. */

export const DEPARTMENTS = ['Clothing', 'Home', 'Electronics', 'Outdoor'] as const;
/** What each department's tile shows: one of its kinds, in a colour that reads on its tint. */
const DEPARTMENT_PICTURES: Record<(typeof DEPARTMENTS)[number], [string, string]> = {
  Clothing: ['Shirts', 'sky blue'],
  Home: ['Mugs', 'mustard'],
  Electronics: ['Headphones', 'charcoal'],
  Outdoor: ['Tents', 'forest green'],
};

const PROMOS = [
  {
    title: 'Ready for the hills',
    text: 'Waterproofs, boots and packs for wet-weather walking.',
    ask: 'I need waterproof walking gear for a weekend in the hills',
    tone: 'outdoor',
    kind: 'Walking boots',
    colour: 'rust',
  },
  {
    title: 'A calmer home',
    text: 'Lamps, throws and storage that make a room feel finished.',
    ask: 'Help me make my living room feel cosier on a budget',
    tone: 'home',
    kind: 'Lighting',
    colour: 'cream',
  },
  {
    title: 'Gifts sorted',
    text: 'Not sure what to choose? Tell our assistant who it is for.',
    ask: 'I need a present for my dad',
    tone: 'clothing',
    kind: 'Jumpers',
    colour: 'navy',
  },
] as const;

export function Home({
  service,
  onView,
  onAdd,
  adding,
  onDepartment,
  onAsk,
  offers,
  recommended,
}: {
  service: ShopService;
  onView: (p: Product) => void;
  onAdd: (p: Product) => void;
  adding: string | null;
  onDepartment: (d: string) => void;
  onAsk: (text: string) => void;
  offers: ShopInfo['offers'];
  /** Suggestions from the shopper's own browsing, each with the reason it was chosen. */
  recommended: Recommendation[];
}) {
  const [slide, setSlide] = useState(0);
  const [rows, setRows] = useState<Record<string, Product[]>>({});
  const [problem, setProblem] = useState('');

  useEffect(() => {
    let live = true;
    Promise.all(
      DEPARTMENTS.map((d) =>
        service
          .search({ category: d, limit: 8, in_stock_only: true })
          .then((r) => [d, r.items] as const)
          .catch(() => [d, null] as const),
      ),
    )
      .then((pairs) => {
        if (!live) return;
        // One department failing leaves its row out; all of them failing means the shop cannot be reached.
        if (pairs.every(([, items]) => items === null)) {
          setProblem('The shop’s products could not be loaded. Check the backend is running, then reload.');
        }
        setRows(Object.fromEntries(pairs.map(([d, items]) => [d, items ?? []])));
      })
      .catch((e) => live && setProblem(message(e)));
    return () => {
      live = false;
    };
  }, [service]);

  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const id = window.setInterval(() => setSlide((s) => (s + 1) % PROMOS.length), 7000);
    return () => window.clearInterval(id);
  }, []);

  const promo = PROMOS[slide];
  return (
    <>
      <section className="sh-hero" aria-roledescription="carousel" aria-label="This week">
        <div className={`sh-hero-slide tone-${promo.tone}`} key={slide}>
          <div>
            <p className="sh-hero-kicker">This week at Larkfield</p>
            <h2>{promo.title}</h2>
            <p>{promo.text}</p>
            <button type="button" className="sh-btn light" onClick={() => onAsk(promo.ask)}>
              Ask the assistant
            </button>
          </div>
          <ProductPic
            product={{
              id: promo.title,
              category: promo.tone,
              subcategory: promo.kind,
              attributes: { colour: promo.colour },
            }}
            size="big"
          />
        </div>
        <div className="sh-dots" role="tablist" aria-label="Choose an offer">
          {PROMOS.map((p, i) => (
            <button
              key={p.title}
              type="button"
              role="tab"
              aria-selected={i === slide}
              aria-label={p.title}
              className={i === slide ? 'on' : ''}
              onClick={() => setSlide(i)}
            />
          ))}
        </div>
      </section>

      {offers && offers.length > 0 && (
        <section className="sh-offers" aria-label="Offer codes">
          {offers.slice(0, 4).map((o) => (
            <div key={o.code} className="sh-offer">
              <strong>{o.code}</strong>
              <span>{o.description}</span>
            </div>
          ))}
        </section>
      )}

      {recommended.length > 0 && (
        <section className="sh-row-section" aria-label="Recommended for you">
          <div className="sh-row spread">
            <h2>Recommended for you</h2>
          </div>
          <div className="sh-scroller">
            {recommended.map((r) => (
              <div key={r.product.id} className="sh-rec">
                <ProductCard product={r.product} onView={onView} onAdd={onAdd} busy={adding === r.product.id} />
                <p className="sh-rec-reason">{r.reason}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      <section aria-label="Departments" className="sh-tiles">
        {DEPARTMENTS.map((d) => (
          <button
            key={d}
            type="button"
            className="sh-tile"
            onClick={() => onDepartment(d)}
            style={{ ['--pic' as string]: dept(d).hue }}
          >
            <ProductPic
              product={{
                id: d,
                category: d,
                subcategory: DEPARTMENT_PICTURES[d][0],
                attributes: { colour: DEPARTMENT_PICTURES[d][1] },
              }}
              size="mini"
            />
            <span>{d}</span>
          </button>
        ))}
      </section>

      {problem && <p className="sh-error">{problem}</p>}
      {DEPARTMENTS.map((d) =>
        rows[d]?.length ? (
          <section key={d} className="sh-row-section" aria-label={`Popular in ${d}`}>
            <div className="sh-row spread">
              <h2>Popular in {d}</h2>
              <button type="button" className="sh-link" onClick={() => onDepartment(d)}>
                See all
              </button>
            </div>
            <div className="sh-scroller">
              {rows[d].map((p) => (
                <ProductCard key={p.id} product={p} onView={onView} onAdd={onAdd} busy={adding === p.id} />
              ))}
            </div>
          </section>
        ) : null,
      )}
    </>
  );
}

/** A text filter applied when the shopper presses Enter or leaves the box, so typing "navy" is one search and one
 * recorded filter, not four. */
function DraftInput({
  value,
  onCommit,
  ...rest
}: {
  value: string;
  onCommit: (v: string) => void;
  placeholder: string;
  maxLength: number;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    const v = draft.trim();
    if (v !== value) onCommit(v);
  };
  return (
    <input
      {...rest}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
      }}
    />
  );
}

export function SearchView({
  service,
  query,
  category,
  onView,
  onAdd,
  adding,
  onFilter,
}: {
  service: ShopService;
  query: string;
  category?: string;
  onView: (p: Product) => void;
  onAdd: (p: Product) => void;
  adding: string | null;
  /** Called for each filter the shopper sets, so the tracker can record it. */
  onFilter?: (name: string, value: string) => void;
}) {
  const [filters, setFilters] = useState<SearchFilters>({});
  const [items, setItems] = useState<Product[] | null>(null);
  const [problem, setProblem] = useState('');

  useEffect(() => {
    let live = true;
    setItems(null);
    setProblem('');
    service
      .search({ query, category, limit: 24, ...filters })
      .then((r) => live && setItems(r.items))
      .catch((e) => live && setProblem(message(e)));
    return () => {
      live = false;
    };
  }, [service, query, category, filters]);

  const set = (f: Partial<SearchFilters>) => {
    for (const [k, v] of Object.entries(f)) if (v !== undefined) onFilter?.(k, String(v));
    setFilters((old) => ({ ...old, ...f }));
  };
  return (
    <div className="sh-search">
      <aside className="sh-filters" aria-label="Filters">
        <h2>Filter</h2>
        <label>
          Price up to
          <select
            value={filters.max_price_pence ?? ''}
            onChange={(e) => set({ max_price_pence: e.target.value ? Number(e.target.value) : undefined })}
          >
            <option value="">Any</option>
            {[2000, 5000, 10000, 20000, 50000].map((p) => (
              <option key={p} value={p}>
                {money(p)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Rating
          <select
            value={filters.min_rating ?? ''}
            onChange={(e) => set({ min_rating: e.target.value ? Number(e.target.value) : undefined })}
          >
            <option value="">Any</option>
            <option value="4">4 stars and up</option>
            <option value="3">3 stars and up</option>
          </select>
        </label>
        <label>
          Size
          <DraftInput
            value={filters.size ?? ''}
            placeholder="e.g. 10 or M"
            maxLength={12}
            onCommit={(v) => set({ size: v || undefined })}
          />
        </label>
        <label>
          Colour
          <DraftInput
            value={filters.colour ?? ''}
            placeholder="e.g. navy"
            maxLength={24}
            onCommit={(v) => set({ colour: v || undefined })}
          />
        </label>
        <label className="sh-check">
          <input
            type="checkbox"
            checked={!!filters.in_stock_only}
            onChange={(e) => set({ in_stock_only: e.target.checked || undefined })}
          />
          In stock only
        </label>
      </aside>
      <section aria-live="polite" aria-busy={items === null && !problem}>
        <h2 className="sh-results-title">
          {query ? `Results for “${query}”` : category ? category : 'Everything'}
          {category && query ? ` in ${category}` : ''}
        </h2>
        {problem && <p className="sh-error">{problem}</p>}
        {items === null && !problem && <p className="sh-fine">Searching…</p>}
        {items?.length === 0 && <p>Nothing matched. Try fewer filters, or ask the assistant to help you look.</p>}
        <div className="sh-grid">
          {items?.map((p) => (
            <ProductCard key={p.id} product={p} onView={onView} onAdd={onAdd} busy={adding === p.id} />
          ))}
        </div>
      </section>
    </div>
  );
}

const ATTR_LABEL = (k: string) => k.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

export function ProductView({
  service,
  id,
  onAdd,
  adding,
  onWish,
  onAsk,
  onBack,
}: {
  service: ShopService;
  id: string;
  onAdd: (p: Product, size?: string) => void;
  adding: string | null;
  onWish: (p: Product) => void;
  onAsk: (text: string) => void;
  onBack: () => void;
}) {
  const [p, setP] = useState<Product | null>(null);
  const [problem, setProblem] = useState('');
  const [size, setSize] = useState('');
  useEffect(() => {
    let live = true;
    setP(null);
    setProblem('');
    setSize(''); // a size chosen on the last product may not exist on this one
    service
      .product(id)
      .then((r) => live && setP(r))
      .catch((e) => live && setProblem(message(e)));
    return () => {
      live = false;
    };
  }, [service, id]);

  if (problem) return <p className="sh-error">{problem}</p>;
  if (!p) return <p className="sh-fine">Loading the product…</p>;
  const attrs = Object.entries(p.attributes ?? {});
  const sizes = Array.isArray(p.attributes?.sizes) ? (p.attributes?.sizes as unknown[]).map(String) : [];
  return (
    <article className="sh-product">
      <button type="button" className="sh-link" onClick={onBack}>
        ← Back
      </button>
      <div className="sh-product-grid">
        <ProductPic product={p} size="big" />
        <div>
          <p className="sh-card-brand">
            {p.brand} · {p.category}
            {p.subcategory ? ` · ${p.subcategory}` : ''}
          </p>
          <h1>{p.title}</h1>
          <Stars rating={p.rating} count={p.review_count} />
          <p className="sh-price big">{money(p.price_pence)}</p>
          <StockNote stock={p.stock} />
          {sizes.length > 0 && (
            <label className="sh-size">
              Size
              <select value={size} onChange={(e) => setSize(e.target.value)}>
                <option value="">Choose a size</option>
                {sizes.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </label>
          )}
          <div className="sh-row">
            <button
              type="button"
              className="sh-btn"
              disabled={adding === p.id || p.stock <= 0 || (sizes.length > 0 && !size)}
              onClick={() => onAdd(p, size || undefined)}
            >
              {sizes.length > 0 && !size ? 'Choose a size' : 'Add to basket'}
            </button>
            <button type="button" className="sh-btn ghost" onClick={() => onWish(p)}>
              Save for later
            </button>
          </div>
          <button
            type="button"
            className="sh-ask"
            onClick={() => onAsk(`Tell me about ${p.title}: is it right for me?`)}
          >
            Ask the assistant about this
          </button>
          {/* Product text is untrusted catalogue data: shown as plain text, never as markup. */}
          {p.description && <p className="sh-desc">{p.description}</p>}
          {attrs.length > 0 && (
            <dl className="sh-attrs">
              {attrs.map(([k, v]) => (
                <div key={k}>
                  <dt>{ATTR_LABEL(k)}</dt>
                  <dd>{Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : String(v)}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      </div>
    </article>
  );
}

export function BasketDrawer({
  open,
  basket,
  onClose,
  onQuantity,
  onRemove,
  onCheckout,
  busy,
  problem,
  confirmation,
}: {
  open: boolean;
  basket: Basket | null;
  onClose: () => void;
  onQuantity: (itemId: string, q: number) => void;
  onRemove: (itemId: string) => void;
  onCheckout: (delivery: 'standard' | 'next_day') => void;
  busy: boolean;
  problem: string;
  /** The checkout's confirmation card, once the shopper has pressed Check out. */
  confirmation?: ReactNode;
}) {
  const [delivery, setDelivery] = useState<'standard' | 'next_day'>('standard');
  const items = basket?.items ?? [];
  return (
    <>
      <div className={`sh-scrim${open ? ' open' : ''}`} onClick={onClose} aria-hidden="true" />
      <aside className={`sh-drawer${open ? ' open' : ''}`} aria-label="Your basket" aria-hidden={!open} inert={!open}>
        <div className="sh-row spread">
          <h2>Your basket</h2>
          <button type="button" className="sh-iconbtn" onClick={onClose} aria-label="Close the basket">
            ×
          </button>
        </div>
        {items.length === 0 ? (
          <p className="sh-fine">Your basket is empty. Find something, or ask the assistant for ideas.</p>
        ) : (
          <ul className="sh-basket">
            {items.map((i) => (
              <li key={i.id}>
                <ProductPic
                  product={{
                    id: i.product_id,
                    category: i.category ?? '',
                    subcategory: i.subcategory,
                    attributes: { colour: i.colour },
                  }}
                  size="mini"
                />
                <div>
                  <strong>{i.title}</strong>
                  {i.size && <span className="sh-fine"> · size {i.size}</span>}
                  <div className="sh-row">
                    <label className="sh-qty">
                      <span className="sh-hidden">Quantity of {i.title}</span>
                      <select
                        value={i.quantity}
                        disabled={busy}
                        onChange={(e) => onQuantity(i.id, Number(e.target.value))}
                      >
                        {Array.from({ length: Math.max(20, i.quantity) }, (_, n) => n + 1).map((n) => (
                          <option key={n} value={n}>
                            {n}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button type="button" className="sh-link" disabled={busy} onClick={() => onRemove(i.id)}>
                      Remove
                    </button>
                  </div>
                </div>
                <span>{money(i.line_total_pence ?? i.unit_price_pence * i.quantity)}</span>
              </li>
            ))}
          </ul>
        )}
        {basket && items.length > 0 && (
          <div className="sh-totals">
            <div>
              <span>Subtotal</span>
              <span>{money(basket.subtotal_pence)}</span>
            </div>
            {!!basket.discount_pence && (
              <div>
                <span>Offer{basket.offer_code ? ` (${basket.offer_code})` : ''}</span>
                <span>−{money(basket.discount_pence)}</span>
              </div>
            )}
            {basket.delivery_pence !== undefined && (
              <div>
                <span>Delivery</span>
                <span>{basket.delivery_pence ? money(basket.delivery_pence) : 'Free'}</span>
              </div>
            )}
            <div className="sh-total">
              <span>Total</span>
              <strong>{money(basket.total_pence)}</strong>
            </div>
            <fieldset className="sh-delivery">
              <legend>Delivery</legend>
              <label>
                <input type="radio" checked={delivery === 'standard'} onChange={() => setDelivery('standard')} />{' '}
                Standard
              </label>
              <label>
                <input type="radio" checked={delivery === 'next_day'} onChange={() => setDelivery('next_day')} /> Next
                day
              </label>
            </fieldset>
            <button type="button" className="sh-btn wide" disabled={busy} onClick={() => onCheckout(delivery)}>
              Check out
            </button>
          </div>
        )}
        {confirmation}
        {problem && <p className="sh-error">{problem}</p>}
      </aside>
    </>
  );
}

export function Account({
  service,
  tab,
  onTab,
  onView,
  onAdd,
  adding,
  changes,
  onReturn,
  profile,
}: {
  service: ShopService;
  tab: AccountTab;
  onTab: (t: AccountTab) => void;
  onView: (p: Product) => void;
  onAdd: (p: Product) => void;
  adding: string | null;
  changes: number;
  onReturn: (orderItemId: string, title: string) => void;
  /** The "Why am I seeing this?" panel. */
  profile: ReactNode;
}) {
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [returns, setReturns] = useState<ReturnRecord[]>([]);
  const [wish, setWish] = useState<Product[] | null>(null);
  const [problem, setProblem] = useState('');

  useEffect(() => {
    let live = true;
    setProblem('');
    service
      .orders()
      .then((r) => {
        if (!live) return;
        setOrders(asList<Order>(r as never, 'orders'));
        setReturns(asList<ReturnRecord>(r as never, 'returns'));
      })
      .catch((e) => live && setProblem(message(e)));
    service
      .wishlist()
      .then((r) => live && setWish(asList<Product>(r as never, 'items')))
      .catch(() => live && setWish([]));
    return () => {
      live = false;
    };
  }, [service, changes]);

  return (
    <section className="sh-account">
      <h1>Your account</h1>
      <div className="sh-tabs" role="tablist" aria-label="Account">
        {(['orders', 'returns', 'wishlist', 'profile'] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            className={tab === t ? 'on' : ''}
            onClick={() => onTab(t)}
          >
            {t === 'orders'
              ? 'Orders'
              : t === 'returns'
                ? 'Returns'
                : t === 'wishlist'
                  ? 'Saved for later'
                  : 'Why am I seeing this?'}
          </button>
        ))}
      </div>
      {problem && <p className="sh-error">{problem}</p>}
      {tab === 'profile' && profile}
      {tab === 'orders' &&
        (orders === null ? (
          <p className="sh-fine">Loading your orders…</p>
        ) : orders.length === 0 ? (
          <p>No orders yet.</p>
        ) : (
          <div className="sh-orders">
            {orders.map((o) => (
              <div key={o.id}>
                <OrderCard order={o} />
                <div className="sh-row">
                  {o.items
                    .filter((i) => i.returnable !== false)
                    .map((i) => (
                      <button key={i.id} type="button" className="sh-link" onClick={() => onReturn(i.id, i.title)}>
                        Return {i.title}
                      </button>
                    ))}
                </div>
              </div>
            ))}
          </div>
        ))}
      {tab === 'returns' &&
        (returns.length === 0 ? (
          <p>No returns.</p>
        ) : (
          <ul className="sh-returns">
            {returns.map((r) => (
              <li key={r.id}>
                <strong>{r.title ?? r.order_item_id}</strong> · {r.status} · {r.reason}
              </li>
            ))}
          </ul>
        ))}
      {tab === 'wishlist' &&
        (wish === null ? (
          <p className="sh-fine">Loading…</p>
        ) : wish.length === 0 ? (
          <p>Nothing saved yet.</p>
        ) : (
          <div className="sh-grid">
            {wish.map((p) => (
              <ProductCard key={p.id} product={p} onView={onView} onAdd={onAdd} busy={adding === p.id} />
            ))}
          </div>
        ))}
    </section>
  );
}
