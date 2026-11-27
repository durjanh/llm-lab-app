import { describe, expect, it } from 'vitest';
import type { Product } from '@/services/shopService';
import {
  changedFields,
  embedLabel,
  EMPTY_FORM,
  formFrom,
  parsePrice,
  queueDelay,
  queueSummary,
  readForm,
  reembeds,
} from './catalogue';

const jacket: Product = {
  id: 'p1',
  title: 'Ridgeway waterproof jacket',
  brand: 'Fernhill',
  category: 'Outdoor',
  subcategory: 'Jackets',
  description: 'A light shell.',
  price_pence: 8900,
  stock: 12,
};

describe('parsePrice', () => {
  it('reads prices as people type them', () => {
    expect(parsePrice('12.50')).toBe(1250);
    expect(parsePrice('£12.5')).toBe(1250);
    expect(parsePrice('12')).toBe(1200);
    expect(parsePrice('1,299.99')).toBe(129999);
    expect(parsePrice(' 0.99 ')).toBe(99);
  });

  it('refuses what is not a price', () => {
    for (const bad of ['', 'abc', '-5', '1.234', '12.5.0', '1e3', '99999999']) expect(parsePrice(bad)).toBeNull();
  });
});

describe('readForm', () => {
  it('turns a good form into the server fields', () => {
    const { input, problems } = readForm({
      ...EMPTY_FORM,
      title: '  Lamp ',
      category: 'Home',
      price: '24.99',
      stock: '3',
    });
    expect(problems).toEqual([]);
    expect(input).toMatchObject({ title: 'Lamp', category: 'Home', price_pence: 2499, stock: 3 });
  });

  it('lists every problem', () => {
    const { problems } = readForm({ ...EMPTY_FORM, title: '', category: 'Toys', price: 'free', stock: '-1' });
    expect(problems).toHaveLength(4);
  });
});

describe('changedFields', () => {
  it('sends only what changed', () => {
    const f = { ...formFrom(jacket), price: '79.00' };
    expect(changedFields(jacket, f)).toEqual({ patch: { price_pence: 7900 }, problems: [] });
    expect(changedFields(jacket, formFrom(jacket)).patch).toEqual({});
  });

  it('a price or stock change does not re-embed; a change to the words does', () => {
    expect(reembeds(changedFields(jacket, { ...formFrom(jacket), price: '79', stock: '2' }).patch)).toBe(false);
    expect(reembeds(changedFields(jacket, { ...formFrom(jacket), description: 'Now with a hood.' }).patch)).toBe(true);
    expect(reembeds(changedFields(jacket, { ...formFrom(jacket), title: 'Ridgeway jacket' }).patch)).toBe(true);
  });
});

describe('the embedding queue', () => {
  const q = {
    pending: 3,
    done: 19997,
    failed: [{ id: 'p9', title: 'X', error: 'timeout', attempts: 5 }],
    last_batch_at: null,
    rate_per_min: 120,
    model: 'm',
  };

  it('refreshes quickly while there is work and slowly when idle or failing', () => {
    expect(queueDelay(q)).toBeLessThan(queueDelay({ ...q, pending: 0 }));
    expect(queueDelay(null, true)).toBeGreaterThan(queueDelay({ ...q, pending: 0 }));
  });

  it('says what is in it', () => {
    expect(queueSummary(q)).toBe('3 waiting, 19,997 embedded, 1 failed');
    expect(embedLabel('pending')).toMatch(/Waiting/);
    expect(embedLabel(undefined)).toBe('Not known');
  });
});
