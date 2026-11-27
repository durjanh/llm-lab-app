import { ApiClient } from './apiClient';

/* The shopping assistant's backend: an invented retailer's catalogue, each demo shopper's own basket, orders,
   returns and wish list (kept apart by the database's row-level security), and the chat agent that helps them.
   Every shop call after sign-in carries the X-Shop-Session token; the server works out the shopper from it alone. */

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ShopModel {
  id: string;
  name: string;
  provider: 'anthropic' | 'azure-openai' | 'local' | string;
  context_window?: number;
  efforts: Effort[];
  /** Whether the model can read pictures; absent means unknown. */
  images?: boolean;
}

export interface ImportState {
  state: 'idle' | 'running' | 'done' | 'failed' | 'stopped' | string;
  done: number;
  total: number;
  message: string;
}

export interface ShopInfo {
  models: ShopModel[];
  default_model: string;
  data: {
    products: number;
    customers: number;
    orders: number;
    embedded: number;
    data_version: number | string;
    embed_model: string;
    import: ImportState;
  };
  db: { available: boolean; message: string };
  sizes: number[];
  /** Invented offer codes the agent can apply, if the backend lists them. */
  offers?: { code: string; description: string }[];
}

export interface Customer {
  id: string;
  display_name: string;
}

export interface Session {
  token: string;
  customer: Customer;
  expires_at?: string;
}

export interface Product {
  id: string;
  title: string;
  brand: string;
  category: string;
  subcategory?: string;
  description?: string;
  attributes?: Record<string, unknown>;
  price_pence: number;
  stock: number;
  rating?: number;
  review_count?: number;
  /** Whether the product's search vector is up to date with its text (the Lab's edit panel shows it). */
  embed_state?: 'pending' | 'done' | 'failed' | string;
  embedded_at?: string | null;
  embedded_with?: string | null;
  embed_error?: string | null;
}

/** A product as the Lab's editor sends it: every field for a new one, only the changed ones for an edit. */
export interface ProductInput {
  title?: string;
  brand?: string;
  category?: string;
  subcategory?: string;
  description?: string;
  attributes?: Record<string, unknown>;
  price_pence?: number;
  stock?: number;
}

/** The background embedding worker's queue: what waits, what is done, and what failed after its retries. */
export interface EmbeddingQueue {
  pending: number;
  done: number;
  failed: { id: string; title: string; error: string; attempts: number }[];
  last_batch_at: string | null;
  rate_per_min: number;
  model: string;
}

export interface BasketItem {
  id: string;
  product_id: string;
  title: string;
  quantity: number;
  size?: string | null;
  unit_price_pence: number;
  line_total_pence?: number;
  category?: string;
  /** For the line's picture: the product's kind and colour. */
  subcategory?: string;
  colour?: string;
}

export interface Basket {
  items: BasketItem[];
  subtotal_pence: number;
  discount_pence?: number;
  delivery_pence?: number;
  total_pence: number;
  offer_code?: string | null;
}

export const EMPTY_BASKET: Basket = { items: [], subtotal_pence: 0, total_pence: 0 };

export interface OrderItem {
  id: string;
  product_id: string;
  title: string;
  quantity: number;
  size?: string | null;
  unit_price_pence: number;
  returnable?: boolean;
}

export interface Order {
  id: string;
  created_at: string;
  status: string;
  total_pence: number;
  delivery?: string;
  items: OrderItem[];
}

export interface ReturnRecord {
  id: string;
  order_id?: string;
  order_item_id: string;
  title?: string;
  status: string;
  reason: string;
  created_at: string;
}

export interface ComparisonRow {
  attribute: string;
  values: string[];
}

export interface Comparison {
  products?: { id: string; title: string }[];
  rows: ComparisonRow[];
}

/** What a pending checkout or return is about to do; the backend fills what it has. */
export interface ConfirmationSummary {
  text?: string;
  lines?: { title: string; quantity?: number; price_pence?: number }[];
  total_pence?: number;
  delivery?: string;
  [key: string]: unknown;
}

export interface Confirmation {
  confirmation_id: string;
  kind: 'checkout' | 'return' | string;
  summary: ConfirmationSummary;
}

export interface SearchFilters {
  query?: string;
  category?: string;
  max_price_pence?: number;
  min_rating?: number;
  size?: string;
  colour?: string;
  in_stock_only?: boolean;
  limit?: number;
}

/** Where the shopper is in the shop, sent with each message so the agent can use it. */
export interface ChatContext {
  page: 'home' | 'search' | 'product' | 'basket' | 'account';
  viewing_product_id?: string;
  /** A guest's browsing, summarised in the browser (never the raw log); only with their consent. */
  activity_summary?: unknown;
}

/** One browsing event as the page sends it (see `pages/shop-assistant/activity.ts`). */
export interface ShopActivityEvent {
  event_id: string;
  type: string;
  ts: number;
  page: string;
  props: Record<string, unknown>;
}

/** What the shop has worked out from the shopper's own browsing, orders and wish list. */
export interface ShopProfile {
  top_categories?: { category: string; weight?: number; count?: number }[];
  subcategories?: { subcategory: string; weight?: number; count?: number }[];
  price_band?: { median_pence?: number; low_pence?: number; high_pence?: number };
  brands?: string[];
  sizes?: string[];
  colours?: string[];
  recently_viewed?: { product_id: string; title?: string; seconds?: number }[];
  recent_searches?: string[];
  events?: number;
  has_taste?: boolean;
  updated_at?: string;
}

export interface Recommendation {
  product: Product;
  reason: string;
}

export interface ChatRequest {
  session_id?: string;
  text: string;
  model: string;
  effort: Effort | '';
  auto: boolean;
  context: ChatContext;
  attachments: string[];
}

export interface ShopUpload {
  id: string;
  name: string;
  size: number;
  media_type: string;
}

export interface IsolationAttempt {
  name: string;
  attempt?: string;
  outcome: string;
  /** True when the attempt was refused or returned nothing it should not have. */
  ok: boolean;
  detail?: string;
}

export type ShopEvent =
  | { type: 'run'; run_id: string }
  | { type: 'session'; session_id: string }
  | { type: 'turn'; turn_id: string; session_id?: string }
  | { type: 'model_call'; agent?: string; model: string; effort?: string | null; n?: number }
  | { type: 'text'; agent?: string; delta: string }
  | { type: 'tool_call'; agent?: string; id: string; name: string; input: unknown }
  | { type: 'tool_result'; agent?: string; id: string; ok: boolean; output?: string }
  | {
      type: 'usage';
      agent?: string;
      model: string;
      input_tokens?: number;
      output_tokens?: number;
      cost_usd?: number;
      run_cost_usd?: number;
    }
  | { type: 'route'; model: string; effort?: string; tier?: string; reason?: string; by?: string }
  | { type: 'products'; items: Product[] }
  | ({ type: 'comparison' } & Comparison)
  | { type: 'basket'; basket: Basket }
  | ({ type: 'confirmation' } & Confirmation)
  | { type: 'order'; order: Order }
  | { type: 'question'; question_id: string; question: string; options: string[] }
  | { type: 'cached' }
  | { type: 'done'; stopped?: string; cost_usd?: number; text?: string }
  | { type: 'error'; message: string };

const SESSION_HEADER = 'X-Shop-Session';
/** The Lab's data routes take their own header and refuse a shopper's session, so the session is left off (null
    removes the default header for that one request). */
const LAB = { headers: { 'X-Shop-Lab': '1', [SESSION_HEADER]: null } };
const STORE_KEY = 'shop-assistant-session';

/** An id for this browser tab, so the server can share waiting uploads fairly between tabs. Not a secret. */
function uploadCaller(): string {
  try {
    let id = window.sessionStorage.getItem('shop-upload-caller') ?? '';
    if (!/^[a-z0-9]{16,40}$/.test(id)) {
      id = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
      window.sessionStorage.setItem('shop-upload-caller', id);
    }
    return id;
  } catch {
    return 'anonymous';
  }
}

export class ShopService {
  /** The shopper this tab is signed in as, if any. */
  session: Session | null = null;

  constructor(private readonly client: ApiClient = new ApiClient()) {
    try {
      const saved = window.sessionStorage.getItem(STORE_KEY);
      if (saved) this.use(JSON.parse(saved) as Session);
    } catch {
      /* no storage: sign in again */
    }
  }

  private use(session: Session | null) {
    this.session = session;
    this.client.setHeader(SESSION_HEADER, session?.token ?? '');
    try {
      if (session) window.sessionStorage.setItem(STORE_KEY, JSON.stringify(session));
      else window.sessionStorage.removeItem(STORE_KEY);
    } catch {
      /* the session still works for this page view */
    }
  }

  /** Forgets the session, for example after the server said it had expired. */
  signOut() {
    this.use(null);
  }

  info() {
    return this.client.get<ShopInfo>('/api/shop/info');
  }

  customers(limit = 50) {
    return this.client.get<Customer[]>(`/api/shop/customers?limit=${limit}`);
  }

  /** Signs in as a demo shopper, handing over the guest's browsing so the account keeps it (at most 500 events). */
  async signIn(customerId: string, guestEvents: ShopActivityEvent[] = []): Promise<Session> {
    const session = await this.client.post<Session>('/api/shop/session', {
      customer_id: customerId,
      ...(guestEvents.length ? { guest_events: guestEvents.slice(-500) } : {}),
    });
    this.use(session);
    return session;
  }

  /** Makes a new demo shopper (a name and an invented email, no password) and signs in as them. */
  async createAccount(displayName: string, email: string, guestEvents: ShopActivityEvent[] = []): Promise<Session> {
    const session = await this.client.post<Session>('/api/shop/accounts', {
      display_name: displayName,
      email,
      ...(guestEvents.length ? { guest_events: guestEvents.slice(-500) } : {}),
    });
    this.use(session);
    return session;
  }

  // ----- browsing behaviour -----
  /** A signed-in shopper's events, at most 100 per call. */
  sendEvents(events: ShopActivityEvent[]) {
    return this.client.post<{ accepted?: number }>('/api/shop/events', { events: events.slice(0, 100) });
  }

  profile() {
    return this.client.get<ShopProfile>('/api/shop/profile');
  }

  /** "Forget my browsing": wipes the shopper's events and the taste worked out from them. */
  forgetActivity() {
    return this.client.delete<{ deleted?: number }>('/api/shop/activity');
  }

  /** Suggestions with a reason each: from the profile when signed in, from the browser's summary for a guest. */
  recommendations(activitySummary?: unknown, limit = 8) {
    return this.client.post<{ items: Recommendation[] }>('/api/shop/recommendations', {
      limit,
      ...(activitySummary ? { activity_summary: activitySummary } : {}),
    });
  }

  // ----- the catalogue -----
  search(filters: SearchFilters) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) {
      if (v !== undefined && v !== '' && v !== false) q.set(k, String(v));
    }
    return this.client.get<{ items: Product[]; total?: number }>(`/api/shop/products?${q}`);
  }

  product(id: string) {
    return this.client.get<Product>(`/api/shop/products/${encodeURIComponent(id)}`);
  }

  // ----- the shopper's own things -----
  basket() {
    return this.client.get<Basket>('/api/shop/basket');
  }

  addToBasket(productId: string, quantity = 1, size?: string) {
    return this.client.post<Basket>('/api/shop/basket/items', { product_id: productId, quantity, size });
  }

  updateBasketItem(itemId: string, quantity: number) {
    return this.client.patch<Basket>(`/api/shop/basket/items/${encodeURIComponent(itemId)}`, { quantity });
  }

  removeBasketItem(itemId: string) {
    return this.client.delete<Basket>(`/api/shop/basket/items/${encodeURIComponent(itemId)}`);
  }

  /** Prepares a checkout; nothing is ordered until confirm() is called with the returned id. */
  checkout(delivery: 'standard' | 'next_day') {
    return this.client.post<Confirmation>('/api/shop/checkout', { delivery });
  }

  orders() {
    return this.client.get<{ orders: Order[]; returns?: ReturnRecord[] } | Order[]>('/api/shop/orders');
  }

  startReturn(orderItemId: string, reason: string) {
    return this.client.post<Confirmation>('/api/shop/returns', { order_item_id: orderItemId, reason });
  }

  wishlist() {
    return this.client.get<{ items: Product[] } | Product[]>('/api/shop/wishlist');
  }

  addToWishlist(productId: string) {
    return this.client.post<{ items: Product[] } | Product[]>('/api/shop/wishlist', { product_id: productId });
  }

  /** The person's answer to a pending checkout or return: accept places it, otherwise it is cancelled. */
  confirm(confirmationId: string, accept: boolean) {
    return this.client.post<{ order?: Order; return?: ReturnRecord; cancelled?: boolean; basket?: Basket }>(
      '/api/shop/confirm',
      { confirmation_id: confirmationId, accept },
    );
  }

  // ----- the chat -----
  chat(body: ChatRequest, onEvent: (e: ShopEvent) => void, signal?: AbortSignal) {
    return this.client.stream<ShopEvent>('/api/shop/chat', body, onEvent, signal);
  }

  upload(files: File[], onProgress?: (fraction: number) => void) {
    const form = new FormData();
    for (const f of files) form.append('files', f, f.name);
    form.append('caller', uploadCaller());
    return this.client.post<ShopUpload[]>('/api/shop/uploads', form, {
      onUploadProgress: (e) => onProgress?.(e.total ? e.loaded / e.total : 0),
    });
  }

  // ----- editing the catalogue (Lab) -----
  createProduct(input: ProductInput) {
    return this.client.post<Product>('/api/shop/products', input, LAB);
  }

  updateProduct(id: string, patch: ProductInput) {
    return this.client.patch<Product>(`/api/shop/products/${encodeURIComponent(id)}`, patch, LAB);
  }

  deleteProduct(id: string) {
    return this.client.delete<{ deleted?: boolean }>(`/api/shop/products/${encodeURIComponent(id)}`, LAB);
  }

  embedding() {
    return this.client.get<EmbeddingQueue>('/api/shop/embedding');
  }

  /** Puts failed products back in the queue: the ones named, or every failed one. */
  retryEmbedding(ids?: string[]) {
    return this.client.post<EmbeddingQueue>('/api/shop/embedding/retry', ids?.length ? { ids } : {}, LAB);
  }

  // ----- the data behind the shop -----
  /** Starts (or resumes) the generator. Without `force` the server refuses (409, `in_use`) while shoppers are signed in
      or a checkout waits for Confirm, since a new shop replaces them; ask the person, then send `force`. */
  generate(size: number, force = false) {
    return this.client.post<ImportState>('/api/shop/generate', force ? { size, force } : { size }, LAB);
  }

  importFile(file: File, kind: 'products' | 'customers' | 'orders') {
    const form = new FormData();
    form.append('file', file, file.name);
    form.append('kind', kind);
    return this.client.post<ImportState>('/api/shop/import', form, LAB);
  }

  importState() {
    return this.client.get<ImportState>('/api/shop/import');
  }

  stopImport() {
    return this.client.post<ImportState>('/api/shop/import/stop', {}, LAB);
  }

  isolationCheck() {
    return this.client.post<{ attempts: IsolationAttempt[] }>('/api/shop/isolation-check', {});
  }
}

export const shopService = new ShopService();
