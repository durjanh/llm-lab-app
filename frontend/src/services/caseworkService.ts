import { api, type ApiClient } from './apiClient';

export interface CaseSummary {
  case_id: string;
  tenant_id: string;
  tenant: string;
  received: string;
  channel: string;
  complaint: string;
  status: string;
}

export interface CaseworkInfo {
  ready: boolean;
  model: string | null;
  embedding: string;
  search: string | null;
  index: string;
  prompts: Record<string, string>;
  gate: Record<string, number>;
  cases: CaseSummary[];
}

export interface Compensation {
  target_date: string;
  days_late: number;
  daily_rate_gbp: number;
  delay_gbp: number;
  service_failure_gbp: number;
  vulnerability_gbp: number;
  total_gbp: number;
  working: string;
}

export interface Draft {
  decision: 'upheld' | 'partly_upheld' | 'not_upheld';
  reasons: string;
  compensation: Compensation;
  goodwill: string;
  letter: string;
  claims: { claim: string; sources: string[] }[];
}

export interface Checks {
  groundedness: { claim: string; supported: boolean; note: string }[];
  supported: number;
  claims: number;
  unknown_sources: string[];
  rules: Record<string, string | number>;
  mismatches: string[];
  problems: boolean;
}

/** One event of a streamed run: a finished step, the end, or an error. */
export type CaseEvent =
  | { type: 'step'; step: 'intake' | 'evidence' | 'policy' | 'draft' | 'checks'; round?: number; data: unknown }
  | { type: 'done'; run_id: string; status: string; cost: number }
  | { type: 'error'; message: string };

export interface AuditEntry {
  seq: number;
  at: string;
  case_id: string | null;
  run_id: string | null;
  actor: string;
  action: string;
  model?: string;
  prompt_version?: string;
  hash: string;
  prev: string;
  [key: string]: unknown;
}

export interface EvalRow {
  case_id: string;
  expected: { decision: string; compensation_gbp: number };
  first: { decision: string; total_gbp: number };
  decision: string;
  total_gbp: number;
  revised: boolean;
  first_ok: boolean;
  decision_ok: boolean;
  compensation_ok: boolean;
  supported: number;
  claims: number;
}

export type EvalEvent =
  | { type: 'case'; row: EvalRow }
  | { type: 'done'; metrics: Record<string, number>; gate: Record<string, number>; passed: boolean; cost: number }
  | { type: 'error'; message: string };

/** Case handling on Azure: agents work a complaint, a caseworker approves, everything is audited. */
export class CaseworkService {
  constructor(private readonly client: ApiClient) {}

  info(): Promise<CaseworkInfo> {
    return this.client.get('/api/casework/info');
  }

  run(caseId: string, onEvent: (e: CaseEvent) => void, signal?: AbortSignal): Promise<void> {
    return this.client.stream(`/api/casework/cases/${encodeURIComponent(caseId)}/run`, {}, onEvent, signal);
  }

  decide(runId: string, action: 'approve' | 'reject', reviewer: string, letter: string, note: string): Promise<{ status: string; edited: boolean }> {
    return this.client.post(`/api/casework/runs/${encodeURIComponent(runId)}/decision`, { action, reviewer, letter, note });
  }

  audit(caseId?: string): Promise<{ entries: AuditEntry[]; chain: { intact: boolean; broken_at: number | null } }> {
    return this.client.get('/api/casework/audit', caseId ? { params: { case_id: caseId } } : undefined);
  }

  evaluate(onEvent: (e: EvalEvent) => void, signal?: AbortSignal): Promise<void> {
    return this.client.stream('/api/casework/evaluate', {}, onEvent, signal);
  }
}

export const caseworkService = new CaseworkService(api);
