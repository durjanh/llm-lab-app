import { api, type ApiClient } from './apiClient';

export type Block = { type: string; [key: string]: unknown };

export interface FailoverStep {
  turn: number;
  step: number;
  kind: 'user' | 'model' | 'tool' | 'summary';
  role: string;
  content: Block[];
  model: string;
  provider: string;
  fallback_from: string;
  reason: string;
  stop_reason: string;
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
  created_at: string;
  tool: string;
  covers_from: string;
  covers_until: string;
  blob_path: string;
}

export interface Pool {
  name: string;
  model: string;
  provider: string;
  note: string;
  context_tokens: number;
  state: 'closed' | 'open' | 'half-open';
  retry_in_s: number;
  cooldown_s: number;
  failures: number;
  successes: number;
  last_error: string;
  faults: string[];
}

export interface LabFailover {
  enabled: boolean;
  models: string[];
  routed_calls: number;
  switches: { at: number; area: string; asked: string; from: string; to: string; reason: string }[];
}

export interface RouterStatus {
  pools: Pool[];
  cooldown_s: number;
  short_retry_s: number;
  faults: string[];
}

export interface CompactSettings {
  compact_at: number;
  compact_max_tokens: number;
  keep_recent: number;
  compact_model: string;
}

export interface Memory {
  model: string;
  tokens: number;
  window: number;
  threshold: number;
  settings: CompactSettings;
  defaults: CompactSettings;
  compactions: number;
  last: null | {
    key: string;
    covers_from: string;
    covers_until: string;
    model: string;
    created_at: string;
    text: string;
  };
}

export interface Storage {
  kind: string;
  where: string;
  container?: string;
  tables?: string[];
  blobs?: string[];
  conversation_row?: Record<string, unknown>;
  step_rows?: Record<string, unknown>[];
}

export interface ConversationSummary {
  id: string;
  title: string;
  status: string;
  last_step: string;
  created_at: string;
  updated_at: string;
}

export interface ConversationView {
  conversation: ConversationSummary & { etag: string; overrides: Partial<Omit<CompactSettings, 'compact_model'>> };
  steps: FailoverStep[];
  incomplete: boolean;
  active: boolean;
  memory: Memory;
  storage: Storage;
}

export interface FailoverInfo {
  router: RouterStatus;
  storage: Storage;
  examples: string[];
  compaction: CompactSettings;
  limits: { message: number; iterations: number };
  estimate: string;
  handbook: string[];
}

export type FailoverEvent =
  | { type: 'run'; run_id: string }
  | { type: 'step'; step: FailoverStep }
  | { type: 'retry'; pool: string; reason: string; retry_after: number | null; injected: boolean }
  | {
      type: 'switch';
      from: string;
      to: string;
      reason: string;
      status: number | null;
      retry_after: number | null;
      injected: boolean;
    }
  | { type: 'compaction'; step: FailoverStep }
  | { type: 'compaction_failed'; reason: string }
  | {
      type: 'done';
      reply: string;
      stop_reason: string;
      model?: string;
      cost_usd: number;
      switches: number;
      steps: number;
    }
  | { type: 'error'; message: string; can_resume?: boolean; cost_usd?: number };

export interface CatalogEntry {
  name: string;
  model: string;
  provider: string;
  context_window: number;
  note: string;
  enabled: boolean;
  input_per_m?: number;
  output_per_m?: number;
  cache_read_per_m?: number;
}

export interface ResolvedEntry extends CatalogEntry {
  available: boolean;
  reason: string;
}

export interface CatalogView {
  entries: CatalogEntry[];
  resolved: ResolvedEntry[];
  compact_model: string;
  version: string;
  updated_at: string;
  source: { kind: string; where: string; table?: string; check_every_s?: number; ttl_s?: number };
  error: string;
  known_models: string[];
  providers: string[];
  placeholder: string;
  min_window: number;
}

export type FaultKind = '429' | '429_short' | '529' | '500' | 'timeout';
export type Overrides = Partial<Omit<CompactSettings, 'compact_model'>>;

const base = '/api/model-failover';

export class ModelFailoverService {
  constructor(private readonly client: ApiClient = api) {}

  catalog(): Promise<CatalogView> {
    return this.client.get(`${base}/catalog`);
  }
  saveCatalog(models: CatalogEntry[], compactModel: string, version: string): Promise<CatalogView> {
    return this.client.put(`${base}/catalog`, { models, compact_model: compactModel, version });
  }
  reloadCatalog(): Promise<CatalogView> {
    return this.client.post(`${base}/catalog/reload`, {});
  }
  info(): Promise<FailoverInfo> {
    return this.client.get(`${base}/info`);
  }
  router(): Promise<RouterStatus> {
    return this.client.get(`${base}/router`);
  }
  /** Failover on every other page: on or off, the models it covers, the latest switches anywhere in the lab. */
  lab(): Promise<LabFailover> {
    return this.client.get(`${base}/lab`);
  }
  resetRouter(): Promise<RouterStatus> {
    return this.client.post(`${base}/router/reset`, {});
  }
  inject(pool: string, kind: FaultKind, count = 1): Promise<RouterStatus> {
    return this.client.post(`${base}/faults`, { pool, kind, count });
  }
  clearFaults(): Promise<RouterStatus> {
    return this.client.delete(`${base}/faults`);
  }
  list(): Promise<{ conversations: ConversationSummary[] }> {
    return this.client.get(`${base}/conversations`);
  }
  create(): Promise<ConversationSummary> {
    return this.client.post(`${base}/conversations`, {});
  }
  get(id: string, primary?: string): Promise<ConversationView> {
    return this.client.get(`${base}/conversations/${id}${primary ? `?primary=${encodeURIComponent(primary)}` : ''}`);
  }
  remove(id: string): Promise<{ deleted: string }> {
    return this.client.delete(`${base}/conversations/${id}`);
  }
  settings(id: string, values: Overrides): Promise<ConversationView> {
    return this.client.put(`${base}/conversations/${id}/settings`, values);
  }
  compact(id: string, primary?: string): Promise<{ step: FailoverStep; memory: Memory; cost_usd: number }> {
    return this.client.post(`${base}/conversations/${id}/compact`, { primary });
  }
  send(id: string, message: string, primary: string, onEvent: (e: FailoverEvent) => void, signal?: AbortSignal) {
    return this.client.stream<FailoverEvent>(
      `${base}/conversations/${id}/messages`,
      { message, primary },
      onEvent,
      signal,
    );
  }
  resume(id: string, primary: string, onEvent: (e: FailoverEvent) => void, signal?: AbortSignal) {
    return this.client.stream<FailoverEvent>(`${base}/conversations/${id}/resume`, { primary }, onEvent, signal);
  }
}

export const modelFailoverService = new ModelFailoverService();
