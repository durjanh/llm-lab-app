import { api, type ApiClient } from './apiClient';

/* The software factory: a backlog, changes run by agents with risk-tiered human steps, and the track record. */

export type Tier = 'low' | 'medium' | 'high';
export type ChangeStatus =
  | 'queued'
  | 'planning'
  | 'awaiting_plan'
  | 'building'
  | 'checking'
  | 'awaiting_diff'
  | 'merged'
  | 'reverted'
  | 'rejected'
  | 'blocked'
  | 'taken_over'
  | 'stopped'
  | 'expired'
  | 'failed';

export interface FactoryRules {
  tiers: Record<Tier, string>;
  kind_tier: Record<string, Tier>;
  area_tier: Record<string, Tier>;
  sensitive_paths: string[];
  sensitive_words: string[];
  medium_diff_lines: number;
  max_diff_lines: number;
  promote_after: number;
  levels: Record<string, string>;
  start_level: number;
  autonomy: string[];
  raise_only: string;
}

export interface FactoryInfo {
  models: string[];
  default_model: string;
  kinds: string[];
  areas: string[];
  rules: FactoryRules;
  statuses: ChangeStatus[];
  change_budget_usd: number;
  time_limit_s: number;
  decision_timeout_s: number;
  sandbox: { available: boolean; kind: string | null };
}

export interface Ticket {
  id: string;
  title: string;
  description: string;
  kind: string;
  area: string;
  own?: boolean;
  tier: Tier;
  tier_reasons: string[];
  effective_tier: Tier;
  effective_reason: string;
}

export interface ChangeSummary {
  id: string;
  ticket_id: string;
  title: string;
  area: string;
  kind: string;
  status: ChangeStatus;
  tier: Tier | null;
  policy_tier: Tier | null;
  effective_tier: Tier | null;
  created_at: string;
  updated_at: string;
  merged_at: string | null;
  commit: string | null;
  cost_usd: number;
  model: string;
  dark: boolean;
  human_steps: number;
  stopped_reason: string | null;
}

export interface Gate {
  name: string;
  passed: boolean;
  detail: string;
}

export interface AuditEntry {
  at: string;
  actor: string;
  what: string;
  why: string;
}

export interface Change extends ChangeSummary {
  description: string;
  effort: string;
  plan: string;
  plan_files: string[];
  diff: string;
  files: string[];
  diff_lines: number;
  tests: {
    passed: boolean;
    output: string;
    counts: Record<string, number>;
    new_failures?: string[];
    fixed?: string[];
    still_failing?: string[];
  } | null;
  review: {
    verdict: 'pass' | 'changes' | null;
    findings: { severity: string; file: string; issue: string }[];
    raw?: string;
  } | null;
  gates: Gate[];
  audit: AuditEntry[];
  corrections: number;
  tier_reasons: string[];
  baseline?: { failing: string[] };
}

export interface AreaRecord {
  level: number;
  clean_streak: number;
  merged: number;
  dark: number;
  reverts: number;
  escapes: number;
  overrides: number;
  history: { at: string; change: string; event: string; [key: string]: unknown }[];
}

export interface FactoryMetrics {
  merged: number;
  dark: number;
  dark_share: number;
  interventions: number;
  escapes: number;
  lead_time_s: number | null;
  cost_per_change_usd: number | null;
  blocked: number;
}

export interface FactoryState {
  tickets: Ticket[];
  changes: ChangeSummary[];
  ledger: Record<string, AreaRecord>;
  metrics: FactoryMetrics;
  running: string | null;
}

export type Decision = 'approve' | 'reject' | 'changes' | 'take_over';

export type FactoryEvent =
  | { type: 'run'; run_id: string }
  | { type: 'change'; change: Change; change_id: string; ts: string }
  | { type: 'audit'; entry: AuditEntry; change_id: string; ts: string }
  | { type: 'agent'; role: string; event: Record<string, unknown>; change_id: string; ts: string }
  | {
      type: 'decision_needed';
      decision_id: string;
      kind: 'plan' | 'diff';
      timeout_s: number;
      plan?: string;
      diff?: string;
      change_id: string;
      ts: string;
    }
  | { type: 'decision_done'; decision_id: string; decision: Decision; change_id: string; ts: string }
  | { type: 'done'; change: Change; change_id: string; ts: string }
  | { type: 'error'; message: string };

const BASE = '/api/software-factory';

export class SoftwareFactoryService {
  constructor(private readonly client: ApiClient) {}

  info(): Promise<FactoryInfo> {
    return this.client.get(`${BASE}/info`);
  }

  state(): Promise<FactoryState> {
    return this.client.get(`${BASE}/state`);
  }

  change(id: string): Promise<Change> {
    return this.client.get(`${BASE}/changes/${encodeURIComponent(id)}`);
  }

  addTicket(t: { title: string; description: string; kind: string; area: string }): Promise<Ticket> {
    return this.client.post(`${BASE}/tickets`, t);
  }

  /** Runs one ticket through the factory, calling `onEvent` for every step, until it ends. */
  start(
    req: { ticket_id: string; model: string; effort: string },
    onEvent: (e: FactoryEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.client.stream(`${BASE}/changes`, req, onEvent, signal);
  }

  decide(req: {
    run_id: string;
    decision_id: string;
    decision: Decision;
    note?: string;
    plan?: string;
  }): Promise<void> {
    return this.client.post(`${BASE}/decide`, req);
  }

  stop(runId: string): Promise<void> {
    return this.client.post(`${BASE}/runs/${encodeURIComponent(runId)}/stop`, {});
  }

  revert(id: string, note: string): Promise<Change> {
    return this.client.post(`${BASE}/changes/${encodeURIComponent(id)}/revert`, { note });
  }

  reset(): Promise<void> {
    return this.client.post(`${BASE}/reset`, {});
  }
}

export const softwareFactoryService = new SoftwareFactoryService(api);
