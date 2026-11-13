import { api, type ApiClient } from './apiClient';

export interface RedTeamStrategy {
  key: string;
  name: string;
  about: string;
}

export interface RedTeamDefence {
  key: string;
  name: string;
  about: string;
}

export interface RedTeamAttack {
  id: string;
  strategy: string;
  title: string;
  source?: 'seed' | 'generated';
  turns: string[];
  order_note?: string | null;
}

export interface RedTeamInfo {
  shop: string;
  customer: { id: string; name: string };
  orders: Record<
    string,
    { customer: string; name: string; item: string; paid_gbp: number; status: string; note?: string }
  >;
  refund_limit: number;
  strategies: RedTeamStrategy[];
  defences: RedTeamDefence[];
  rubric: string[];
  seeds: RedTeamAttack[];
  system_prompt: string;
  strict_addition: string;
  limits: { attacks: number; turns: number; budget_usd: number };
}

export interface RedTeamTurn {
  user: string;
  reply: string;
  raw_reply?: string;
  tools: { name: string; input: Record<string, unknown>; result: string; blocked: boolean }[];
  flagged?: boolean;
  flag_why?: string;
  filtered?: boolean;
}

export interface RedTeamResult {
  id: string;
  strategy: string;
  title: string;
  source: 'seed' | 'generated';
  order_note: string | null;
  turns: RedTeamTurn[];
  breaches: { kind: string; why: string }[];
  judge: { verdict: 'pass' | 'fail' | 'error'; rule: number; why: string } | null;
  verdict: 'breach' | 'held' | 'error';
  error?: string;
  cost_usd: number;
  seconds: number;
}

export interface RedTeamSummary {
  attacks: number;
  scored: number;
  breaches: number;
  rate: number | null;
  by_strategy: Record<string, { attacks: number; breaches: number; errors: number; rate: number | null }>;
  kinds: Record<string, number>;
  flagged: number;
}

export interface RedTeamDiff {
  fixed: string[];
  regressed: string[];
  same: string[];
}

export type Defences = Record<string, boolean>;

export interface RedTeamRunBody {
  strategies: string[];
  per_strategy: number;
  seeds: boolean;
  defences: Defences;
  target_model: string;
  attacker_model: string;
  judge_model: string;
  judge: boolean;
  budget_usd: number;
  suite_id?: string | null;
}

export interface RedTeamEstimate {
  attacks: number;
  turns: number;
  by_role: Record<string, number>;
  usd: number;
  over_cap: boolean;
}

export type RedTeamEvent =
  | { type: 'run'; run_id: string }
  | { type: 'start'; canary: string; defences: Defences; planned: number; suite: { id: string; name: string } | null }
  | { type: 'progress'; step: string }
  | { type: 'attacker'; strategy: string; made: number; refused: string | null; cost_usd: number }
  | { type: 'attack'; index: number; of: number; result: RedTeamResult; spent_usd: number }
  | {
      type: 'done';
      run_id: string;
      summary: RedTeamSummary;
      diff: RedTeamDiff | null;
      refusals: Record<string, string>;
      stopped: string | null;
      cost_usd: number;
    }
  | { type: 'error'; message: string };

export interface RedTeamSuite {
  id: string;
  name: string;
  created: string;
  attacks: number;
  baseline: { defences: Defences; summary: RedTeamSummary };
  history: { at: string; defences: Defences; summary: RedTeamSummary; diff: RedTeamDiff | null }[];
}

/** Adversarial testing: an automated red team against the lab's own invented support agent. */
export class RedTeamService {
  constructor(private readonly client: ApiClient = api) {}

  info(): Promise<RedTeamInfo> {
    return this.client.get('/api/red-team/info');
  }

  estimate(body: RedTeamRunBody): Promise<RedTeamEstimate> {
    return this.client.post('/api/red-team/estimate', body);
  }

  run(body: RedTeamRunBody, onEvent: (e: RedTeamEvent) => void, signal?: AbortSignal): Promise<void> {
    return this.client.stream('/api/red-team/run', body, onEvent, signal);
  }

  suites(): Promise<RedTeamSuite[]> {
    return this.client.get('/api/red-team/suites');
  }

  saveSuite(runId: string, name: string): Promise<RedTeamSuite> {
    return this.client.post('/api/red-team/suites', { run_id: runId, name });
  }

  deleteSuite(id: string): Promise<{ deleted: string }> {
    return this.client.delete(`/api/red-team/suites/${encodeURIComponent(id)}`);
  }
}

export const redTeamService = new RedTeamService();
