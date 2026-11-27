/* The Lab's product editor and embedding queue, kept free of React so they can be tested: reading a price as
   typed, checking a form, working out which fields changed, whether a change re-embeds the product, and how often
   to refresh the queue. */
import type { EmbeddingQueue, Product, ProductInput } from '@/services/shopService';

export const CATEGORIES = ['Clothing', 'Home', 'Electronics', 'Outdoor'] as const;

/** The fields whose text is embedded; price and stock are not, so changing only those does not re-embed. */
export const EMBEDDED_FIELDS = ['title', 'brand', 'category', 'subcategory', 'description', 'attributes'] as const;

/** The editor's form: everything as the person typed it. */
export interface ProductForm {
  title: string;
  brand: string;
  category: string;
  subcategory: string;
  description: string;
  price: string;
  stock: string;
}

export const EMPTY_FORM: ProductForm = {
  title: '',
  brand: '',
  category: 'Clothing',
  subcategory: '',
  description: '',
  price: '',
  stock: '10',
};

export function formFrom(p: Product): ProductForm {
  return {
    title: p.title,
    brand: p.brand,
    category: p.category,
    subcategory: p.subcategory ?? '',
    description: p.description ?? '',
    price: (p.price_pence / 100).toFixed(2),
    stock: String(p.stock),
  };
}

/** A price as typed ("12.50", "£12.50", "12", "1,299.99") in pence, or null if it is not a price. */
export function parsePrice(text: string): number | null {
  const t = text.trim().replace(/^£/, '').replace(/,/g, '');
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
}

/** Checks the form and turns it into the fields the server takes; the list of problems is empty when it is fine. */
export function readForm(f: ProductForm): { input: ProductInput; problems: string[] } {
  const problems: string[] = [];
  const title = f.title.trim();
  if (!title) problems.push('Give the product a title.');
  else if (title.length > 200) problems.push('The title can be up to 200 characters.');
  if (f.brand.trim().length > 80) problems.push('The brand can be up to 80 characters.');
  if (!(CATEGORIES as readonly string[]).includes(f.category)) problems.push('Choose a department.');
  if (f.description.length > 4000) problems.push('The description can be up to 4,000 characters.');
  const price = parsePrice(f.price);
  if (price === null) problems.push('The price should be in pounds, such as 24.99.');
  const stock = /^\d{1,6}$/.test(f.stock.trim()) ? Number(f.stock.trim()) : null;
  if (stock === null) problems.push('Stock should be a whole number, 0 or more.');
  return {
    input: {
      title,
      brand: f.brand.trim(),
      category: f.category,
      subcategory: f.subcategory.trim(),
      description: f.description.trim(),
      price_pence: price ?? 0,
      stock: stock ?? 0,
    },
    problems,
  };
}

/** Only the fields that differ from the product as loaded, so an edit sends what the person changed and no more. */
export function changedFields(original: Product, f: ProductForm): { patch: ProductInput; problems: string[] } {
  const { input, problems } = readForm(f);
  const before: ProductInput = {
    title: original.title,
    brand: original.brand,
    category: original.category,
    subcategory: original.subcategory ?? '',
    description: original.description ?? '',
    price_pence: original.price_pence,
    stock: original.stock,
  };
  const patch: ProductInput = {};
  for (const k of Object.keys(input) as (keyof ProductInput)[]) {
    if (input[k] !== before[k]) (patch as Record<string, unknown>)[k] = input[k];
  }
  return { patch, problems };
}

/** True when saving this change makes the worker embed the product again. */
export const reembeds = (patch: ProductInput) =>
  EMBEDDED_FIELDS.some((k) => Object.prototype.hasOwnProperty.call(patch, k));

/** How long to wait before asking for the queue again: quickly while there is work, slowly when it is idle. */
export function queueDelay(q: EmbeddingQueue | null, failedFetch = false): number {
  if (failedFetch) return 10000;
  if (!q) return 2000;
  return q.pending > 0 ? 1500 : 6000;
}

/** A plain sentence about the queue, for screen readers and the panel's heading. */
export function queueSummary(q: EmbeddingQueue): string {
  const failed = q.failed?.length ?? 0;
  const parts = [
    `${q.pending.toLocaleString('en-GB')} waiting`,
    `${q.done.toLocaleString('en-GB')} embedded`,
    `${failed.toLocaleString('en-GB')} failed`,
  ];
  return parts.join(', ');
}

/** The state of one product's vector as a short label for the editor. */
export function embedLabel(state: string | undefined): string {
  switch (state) {
    case 'pending':
      return 'Waiting to be embedded';
    case 'failed':
      return 'Embedding failed';
    case 'done':
      return 'Embedded';
    default:
      return 'Not known';
  }
}
