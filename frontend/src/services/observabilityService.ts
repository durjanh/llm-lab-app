import { api, type ApiClient } from './apiClient';

/** The sums for a set of model calls. Latency covers only calls that were timed and answered. */
export interface CallTotals {
  calls: number;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  errors: number;
  fallbacks: number;
  timed: number;
  p50_ms: number | null;
  p95_ms: number | null;
}

/** One model call: counts and timings only, never the prompt or the reply. */
export interface CallRecord {
  id: string;
  at: number;
  area: string;
  route: string;
  trace: string;
  kind: 'create' | 'stream' | 'untimed' | 'service';
  status: 'ok' | 'error';
  error: string | null;
  model: string;
  asked: string;
  fallback: boolean;
  started: number | null;
  latency_ms: number | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cost_usd: number;
}

export interface TraceSpan {
  id: string;
  model: string;
  kind: CallRecord['kind'];
  status: 'ok' | 'error';
  error: string | null;
  fallback: boolean;
  offset_ms: number;
  latency_ms: number | null;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

/** The model calls one request made, in order. */
export interface Trace extends CallTotals {
  trace: string;
  area: string;
  route: string;
  started: number;
  duration_ms: number;
  spans: TraceSpan[];
}

export type Scope = 'session' | 'all';

export interface Overview {
  scope: Scope;
  session: { started_at: number; spent_usd: number; budget_usd: number; charges: number };
  kept: { calls: number; limit: number; oldest_at: number | null; from_earlier_starts: number };
  totals: CallTotals;
  by_area: (CallTotals & { area: string })[];
  by_model: (CallTotals & { model: string })[];
  traces: Trace[];
  calls: CallRecord[];
}

/** Monitoring: the model calls the backend has made, summed up and as traces. Reading it calls no model. */
export class ObservabilityService {
  constructor(private readonly client: ApiClient) {}

  overview(scope: Scope): Promise<Overview> {
    return this.client.get('/api/observability', { params: { scope } });
  }

  clear(): Promise<Overview> {
    return this.client.delete('/api/observability');
  }
}

export const observabilityService = new ObservabilityService(api);
