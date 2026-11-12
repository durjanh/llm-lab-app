import { api, type ApiClient } from './apiClient';

export type StepId = 'trigger' | 'win' | 'finder' | 'competitor' | 'classify' | 'enrich' | 'email' | 'approval';
export type StepStatus = 'idle' | 'running' | 'done' | 'failed';

export interface DealStep {
  id: StepId;
  name: string;
  who: 'model' | 'code' | 'person';
  does: string;
}

export interface DealsInfo {
  steps: DealStep[];
  rules: string[];
  daily_cap: number;
  model: string;
  company: string;
  product: string;
  thresholds: { A: number; B: number };
}

export interface Deal {
  id: string;
  name: string;
  account: string;
  value_gbp: number;
  stage: 'open' | 'closed_won' | 'closed_lost';
  closed_on: string | null;
  win_notes: string;
  displaced: string;
}

export interface Outreach {
  id: number;
  run_id: string;
  deal_id: string;
  account: string;
  contact: string | null;
  role: string | null;
  email: string | null;
  subject: string;
  body: string;
  status: 'draft' | 'sent' | 'rejected' | 'blocked';
  reason: string;
  created_at: string;
  decided_at: string | null;
}

/** What the page shows around a run: the deals, every draft and decision, and the day's count. */
export interface DealsState {
  deals: Deal[];
  outreach: Outreach[];
  cap: { limit: number; sent_today: number; left: number };
  accounts: number;
}

export interface DealContact {
  id: string;
  name: string;
  role: string;
  account: string;
  consent: number;
  unsubscribed: number;
}

/** One line of a streamed run: each step as it starts and finishes, each draft, then the state. */
export type DealEvent =
  | { type: 'run'; run_id: string }
  | { type: 'step'; step: StepId; status: StepStatus; summary: string; detail: unknown }
  | { type: 'draft'; id: number; account: string; status: string }
  | ({ type: 'done'; drafts: number; cost_usd: number } & DealsState)
  | { type: 'error'; message: string; cost_usd?: number };

/** Closed-deal agents: the invented CRM, a run of the steps, and a person's decision on each draft. */
export class DealsService {
  constructor(private readonly client: ApiClient) {}

  info(): Promise<DealsInfo> {
    return this.client.get('/api/deals/info');
  }

  state(): Promise<DealsState> {
    return this.client.get('/api/deals/state');
  }

  reset(): Promise<DealsState> {
    return this.client.post('/api/deals/reset', {});
  }

  /** Marks the deal closed-won and streams the steps. */
  close(dealId: string, model: string | undefined, onEvent: (e: DealEvent) => void, signal?: AbortSignal) {
    return this.client.stream(`/api/deals/${dealId}/close`, { model }, onEvent, signal);
  }

  decide(outreachId: number, approve: boolean): Promise<DealsState & { sent: boolean; message: string }> {
    return this.client.post(`/api/deals/outreach/${outreachId}/decision`, { approve });
  }

  contacts(): Promise<{ contacts: DealContact[] }> {
    return this.client.get('/api/deals/contacts');
  }

  setConsent(contactId: string, consent: boolean): Promise<{ contacts: DealContact[] }> {
    return this.client.post(`/api/deals/contacts/${contactId}/consent`, { consent });
  }
}

export const dealsService = new DealsService(api);
