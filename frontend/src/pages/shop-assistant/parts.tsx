import type { ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Comparison, Confirmation, Order, Product } from '@/services/shopService';
import { DRAWN_KINDS, ProductDrawing } from './illustrations';
import { money } from './state';

/* The shop's small pieces: product pictures (a drawing per kind of product in its own colour, or the department's
   icon for a kind with no drawing; no photos), star
   ratings, product cards, the comparison table, confirmation and order cards, and a Markdown renderer that cannot
   add markup or load outside images. Product text is untrusted, so it is only ever shown as text. */

const DEPARTMENTS: Record<string, { hue: string; icon: string }> = {
  clothing: { hue: '#c96f53', icon: 'shirt' },
  home: { hue: '#5f8b74', icon: 'lamp' },
  electronics: { hue: '#4f6fa8', icon: 'plug' },
  outdoor: { hue: '#8a7a3d', icon: 'tent' },
};

export const dept = (category: string | undefined) =>
  DEPARTMENTS[(category ?? '').toLowerCase()] ?? { hue: '#7a6f8f', icon: 'tag' };

function Icon({ name }: { name: string }) {
  const paths: Record<string, ReactNode> = {
    shirt: <path d="M8 4l4 2 4-2 4 3-2 3h-2v10H8V10H6L4 7z" />,
    lamp: (
      <>
        <path d="M8 3h8l3 8H5z" />
        <path d="M12 11v7M8 21h8" />
      </>
    ),
    plug: (
      <>
        <path d="M9 3v5M15 3v5M7 8h10v3a5 5 0 0 1-10 0z" />
        <path d="M12 16v5" />
      </>
    ),
    tent: (
      <>
        <path d="M3 20L12 4l9 16z" />
        <path d="M12 4v16M9 20l3-6 3 6" />
      </>
    ),
    tag: (
      <>
        <path d="M3 12V4h8l10 10-8 8z" />
        <circle cx="7.5" cy="8" r="1.5" />
      </>
    ),
  };
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="sh-pic-icon">
      {paths[name] ?? paths.tag}
    </svg>
  );
}

/** A product's picture: a drawing of its kind in its own colour, on a tile tinted by its department. A kind with no
 * drawing (a person's imported subcategory) shows the department's icon, with a soft pattern so cards differ. */
export function ProductPic({
  product,
  size = 'card',
}: {
  product: Pick<Product, 'id' | 'category'> & Partial<Pick<Product, 'subcategory' | 'attributes'>>;
  size?: 'card' | 'big' | 'mini';
}) {
  const d = dept(product.category);
  // A stable angle from the id, so the same product always looks the same.
  let h = 0;
  for (const ch of product.id) h = (h * 31 + ch.charCodeAt(0)) % 360;
  const drawn = DRAWN_KINDS.includes((product.subcategory ?? '').toLowerCase());
  return (
    <div
      className={`sh-pic sh-pic-${size}${drawn ? ' drawn' : ''}`}
      style={{ ['--pic' as string]: d.hue, ['--pic-angle' as string]: `${h}deg` }}
      aria-hidden="true"
    >
      {drawn ? (
        <ProductDrawing subcategory={product.subcategory} colour={product.attributes?.colour} fallback={d.hue} />
      ) : (
        <Icon name={d.icon} />
      )}
    </div>
  );
}

export function Stars({ rating, count }: { rating?: number; count?: number }) {
  if (rating === undefined || rating === null) return null;
  const r = Math.max(0, Math.min(5, rating));
  return (
    <span className="sh-stars" aria-label={`Rated ${r.toFixed(1)} out of 5${count ? ` from ${count} reviews` : ''}`}>
      <span className="sh-stars-bar" style={{ ['--r' as string]: `${(r / 5) * 100}%` }} aria-hidden="true">
        ★★★★★
      </span>
      {count !== undefined && <span className="sh-stars-count">({count.toLocaleString('en-GB')})</span>}
    </span>
  );
}

export function StockNote({ stock }: { stock: number }) {
  if (stock <= 0) return <span className="sh-stock out">Out of stock</span>;
  if (stock < 5) return <span className="sh-stock low">Only {stock} left</span>;
  return <span className="sh-stock">In stock</span>;
}

export function ProductCard({
  product,
  onView,
  onAdd,
  compact = false,
  busy = false,
}: {
  product: Product;
  onView: (p: Product) => void;
  onAdd?: (p: Product) => void;
  compact?: boolean;
  busy?: boolean;
}) {
  return (
    <article className={`sh-card${compact ? ' compact' : ''}`}>
      <button
        type="button"
        className="sh-card-view"
        onClick={() => onView(product)}
        aria-label={`View ${product.title}`}
      >
        <ProductPic product={product} size={compact ? 'mini' : 'card'} />
      </button>
      <div className="sh-card-body">
        <span className="sh-card-brand">{product.brand}</span>
        <button type="button" className="sh-card-title" onClick={() => onView(product)}>
          {product.title}
        </button>
        <Stars rating={product.rating} count={compact ? undefined : product.review_count} />
        <div className="sh-card-foot">
          <strong className="sh-price">{money(product.price_pence)}</strong>
          {!compact && <StockNote stock={product.stock} />}
        </div>
        {onAdd && (
          <button
            type="button"
            className="sh-btn small"
            disabled={busy || product.stock <= 0}
            onClick={() => onAdd(product)}
          >
            {product.stock <= 0 ? 'Out of stock' : 'Add to basket'}
          </button>
        )}
      </div>
    </article>
  );
}

export function ComparisonTable({ comparison }: { comparison: Comparison }) {
  const heads =
    comparison.products?.map((p) => p.title) ?? comparison.rows[0]?.values.map((_, i) => `Option ${i + 1}`) ?? [];
  return (
    <div className="sh-compare">
      <table>
        <thead>
          <tr>
            <th scope="col">
              <span className="sh-hidden">Feature</span>
            </th>
            {heads.map((h, i) => (
              <th scope="col" key={i}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {comparison.rows.map((r) => (
            <tr key={r.attribute}>
              <th scope="row">{r.attribute}</th>
              {r.values.map((v, i) => (
                <td key={i}>{v}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ConfirmationCard({
  confirmation,
  state,
  onAnswer,
  busy,
}: {
  confirmation: Confirmation;
  state: 'pending' | 'accepted' | 'cancelled' | 'failed';
  onAnswer: (accept: boolean) => void;
  busy: boolean;
}) {
  const s = confirmation.summary ?? {};
  const isReturn = confirmation.kind === 'return';
  return (
    <div
      className={`sh-confirm ${state}`}
      role="group"
      aria-label={isReturn ? 'Confirm the return' : 'Confirm the order'}
    >
      <strong>{isReturn ? 'Start this return?' : 'Place this order?'}</strong>
      {s.text && <p>{s.text}</p>}
      {Array.isArray(s.lines) && s.lines.length > 0 && (
        <ul>
          {s.lines.map((l, i) => (
            <li key={i}>
              <span>
                {l.quantity ? `${l.quantity} × ` : ''}
                {l.title}
              </span>
              {l.price_pence !== undefined && <span>{money(l.price_pence)}</span>}
            </li>
          ))}
        </ul>
      )}
      {s.total_pence !== undefined && (
        <p className="sh-confirm-total">
          Total <strong>{money(s.total_pence)}</strong>
          {s.delivery ? ` · ${s.delivery}` : ''}
        </p>
      )}
      {state === 'pending' ? (
        <div className="sh-row">
          <button type="button" className="sh-btn" disabled={busy} onClick={() => onAnswer(true)}>
            {isReturn ? 'Confirm return' : 'Confirm order'}
          </button>
          <button type="button" className="sh-btn ghost" disabled={busy} onClick={() => onAnswer(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <p className="sh-confirm-state">
          {state === 'accepted'
            ? 'Confirmed.'
            : state === 'cancelled'
              ? 'Cancelled: nothing was changed.'
              : 'That did not go through. Try again.'}
        </p>
      )}
      <p className="sh-fine">Nothing is charged: this is an invented shop.</p>
    </div>
  );
}

export function OrderCard({ order }: { order: Order }) {
  return (
    <div className="sh-order">
      <div className="sh-row spread">
        <strong>Order {order.id}</strong>
        <span className={`sh-badge ${order.status.toLowerCase()}`}>{order.status}</span>
      </div>
      <p className="sh-fine">
        {new Date(order.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })} ·{' '}
        {money(order.total_pence)}
      </p>
      <ul>
        {order.items.map((i) => (
          <li key={i.id}>
            {i.quantity} × {i.title}
            {i.size ? ` (size ${i.size})` : ''}
          </li>
        ))}
      </ul>
    </div>
  );
}

const SAFE_URL = /^(https?:|mailto:)/i;
const markdown: Components = {
  a: ({ href, children }) =>
    href && SAFE_URL.test(href) ? (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  img: ({ alt }) => <span className="sh-fine">[picture{alt ? `: ${alt}` : ''}]</span>,
  table: ({ children }) => (
    <div className="sh-compare">
      <table>{children}</table>
    </div>
  ),
};

/** The assistant's words as Markdown. react-markdown builds elements and drops raw HTML, and no outside image loads. */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="sh-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={(u) => (SAFE_URL.test(u) ? u : '')}
        components={markdown}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

/** The shop's mark: an original lark in flight over a field line, in the shop's colours. */
export function LogoMark({ size = 34 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true" className="sh-logo-mark">
      <circle cx="20" cy="20" r="19" className="sh-logo-ring" />
      <path d="M8 26c6-2 18-2 24 0" className="sh-logo-field" />
      <path d="M11 18c4-5 8-6 11-4l5-3-2 5c1 3-1 6-6 7l-3 3 1-4c-3 0-5-2-6-4z" className="sh-logo-bird" />
    </svg>
  );
}
