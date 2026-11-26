import { api, type ApiClient } from './apiClient';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** One consumer's rules. Anything left out does not apply. */
export interface Policy {
  allowed_models?: string[];
  max_effort?: Effort;
  daily_usd?: number;
  monthly_usd?: number;
  rpm?: number;
  route_to?: string;
  downgrade_at?: number;
  downgrade_to?: string;
  refuse_secrets: boolean;
  mask_pii: boolean;
  note?: string;
}

/** A part of the lab, or a virtual key, with what it has spent and its policy if it has one. */
export interface ConsumerRow {
  id: string;
  label: string;
  kind: 'area' | 'key';
  today_usd: number;
  month_usd: number;
  projected_month_usd: number;
  calls_today: number;
  saved_month_usd: number;
  policy: Policy | null;
}

export interface DayRow {
  day: string;
  total_usd: number;
  by_consumer: Record<string, number>;
}

export interface ModelRow {
  model: string;
  calls: number;
  cost_usd: number;
  errors: number;
}

export interface BlockedCall {
  at: number;
  consumer: string;
  status: number;
  reason: string;
  model: string;
}

/** A virtual key as the page sees it: never the key itself, nor its hash. */
export interface VirtualKey {
  id: string;
  name: string;
  prefix: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

export interface AuditEntry {
  at: number;
  who: string;
  action: string;
  subject: string;
  before: unknown;
  after: unknown;
}

export interface Overview {
  consumers: ConsumerRow[];
  by_day: DayRow[];
  by_model: ModelRow[];
  totals: {
    today_usd: number;
    month_usd: number;
    saved_month_usd: number;
    blocked: number;
    policies: number;
    active_keys: number;
    session_spent_usd: number;
    session_budget_usd: number;
  };
  blocked: BlockedCall[];
  keys: VirtualKey[];
  audit: AuditEntry[];
  models: { id: string; efforts: Effort[] }[];
  efforts: Effort[];
  call_log_size: number;
}

/** Usage, cost and access: policies per consumer, virtual keys for outside agents, and the figures. */
export class ControlLayerService {
  constructor(private readonly client: ApiClient) {}

  overview(): Promise<Overview> {
    return this.client.get('/api/control-layer');
  }

  setPolicy(consumer: string, policy: Policy): Promise<Policy> {
    return this.client.put(`/api/control-layer/policies/${encodeURIComponent(consumer)}`, policy);
  }

  removePolicy(consumer: string): Promise<void> {
    return this.client.delete(`/api/control-layer/policies/${encodeURIComponent(consumer)}`);
  }

  /** The key itself is in this reply only; the lab keeps its hash. */
  createKey(name: string): Promise<VirtualKey & { key: string }> {
    return this.client.post('/api/control-layer/keys', { name });
  }

  revokeKey(id: string): Promise<void> {
    return this.client.delete(`/api/control-layer/keys/${encodeURIComponent(id)}`);
  }
}

export const controlLayerService = new ControlLayerService(api);
