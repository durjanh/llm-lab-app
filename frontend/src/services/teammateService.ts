import { api, type ApiClient } from './apiClient';

export interface AgentProfile {
  name: string;
  kind: string;
  email: string;
  handle: string;
  id: string;
  company: string;
  owner: string;
  reports_to: string;
  reports_to_role: string;
  does: string;
}

export interface Supplier {
  supplier_id: string;
  name: string;
  batches_offered: number;
  price_per_batch_gbp: number;
  lead_time_weeks: number;
  sites: number;
}

export interface TeammateInfo {
  agent: AgentProfile;
  people: { name: string; role: string; you: boolean }[];
  you: string;
  company: string;
  mention: string;
  rules: string[];
  scopes: Record<string, string>;
  samples: string[];
  docs: Record<string, string>;
  model: string;
  proactive_daily_limit: number;
  demand: {
    product: string;
    quarter: string;
    batches_needed: number;
    internal_batches: number;
    need_by_weeks: number;
    gap: number;
  };
  suppliers: Supplier[];
  tools: { name: string; scope: string | null; does: string }[];
}

export interface Step {
  label: string;
  status: 'running' | 'done' | 'failed';
  detail: string;
}

export interface CoverageRow {
  supplier_id: string;
  name: string;
  batches: number;
  cost_gbp: number;
  passes_rules: boolean;
  fails: string[];
  single_site: boolean;
}

export interface Coverage {
  batches_needed: number;
  internal_batches: number;
  from_suppliers: number;
  covered: number;
  gap_left: number;
  over_by: number;
  cost_gbp: number;
  rows: CoverageRow[];
  problems: string[];
}

export interface ChecklistItem {
  supplier: string;
  what: string;
  owner: string;
  due: string;
}

/** What code attaches to the agent's reply: the table, the sums, the checklist and the citations. */
export interface ReplyData {
  shortlist?: (CoverageRow & {
    why: string;
    price_per_batch_gbp: number;
    lead_time_weeks: number;
    contract_checked: boolean;
  })[];
  coverage?: Coverage;
  checklist?: ChecklistItem[];
  citations?: { id: string; title: string }[];
  steps?: Step[];
  not_checked?: string[];
  nudge?: ChecklistItem[];
  worded_by?: string;
}

export interface Message {
  id: number;
  thread_id: number;
  at: string;
  author: string;
  role: 'person' | 'agent' | 'system';
  text: string;
  data: ReplyData | null;
}

export interface Thread {
  id: number;
  created_at: string;
  author: string;
  kind: 'mention' | 'proactive';
  busy: boolean;
  messages: Message[];
}

export interface AuditEntry {
  id: number;
  at: string;
  actor: string;
  thread_id: number | null;
  kind: 'tool' | 'message' | 'admin' | 'check' | 'proactive';
  name: string;
  detail: string;
  outcome: string;
}

export interface TeammateState {
  threads: Thread[];
  settings: { enabled: boolean; scopes: string[]; proactive: boolean; seeded_on: string };
  audit: AuditEntry[];
  proactive: { today: number; limit: number };
}

/** One line of a streamed answer: the thread it is in, each step, then the new state. */
export type TeammateEvent =
  | { type: 'run'; run_id: string }
  | { type: 'thread'; thread_id: number }
  | ({ type: 'step'; thread_id: number; index: number } & Step)
  | ({ type: 'done'; cost_usd: number; note?: string } & TeammateState)
  | ({ type: 'error'; message: string; cost_usd?: number } & Partial<TeammateState>);

/** Digital teammate: the channel, the agent's answers, the widget's sums and the admin's controls. */
export class TeammateService {
  constructor(private readonly client: ApiClient) {}

  info(): Promise<TeammateInfo> {
    return this.client.get('/api/teammate/info');
  }

  state(): Promise<TeammateState> {
    return this.client.get('/api/teammate/state');
  }

  reset(): Promise<TeammateState> {
    return this.client.post('/api/teammate/reset', {});
  }

  /** A new post in the channel; the agent answers in its thread when @mentioned. */
  post(text: string, model: string | undefined, onEvent: (e: TeammateEvent) => void, signal?: AbortSignal) {
    return this.client.stream('/api/teammate/posts', { text, model }, onEvent, signal);
  }

  reply(
    threadId: number,
    text: string,
    model: string | undefined,
    onEvent: (e: TeammateEvent) => void,
    signal?: AbortSignal,
  ) {
    return this.client.stream(`/api/teammate/threads/${threadId}/replies`, { text, model }, onEvent, signal);
  }

  coverage(allocations: { supplier_id: string; batches: number }[], internal: number): Promise<Coverage> {
    return this.client.post('/api/teammate/coverage', { allocations, internal });
  }

  admin(change: { enabled?: boolean; scopes?: string[]; proactive?: boolean }): Promise<TeammateState> {
    return this.client.post('/api/teammate/admin', change);
  }

  morningCheck(
    model: string | undefined,
  ): Promise<TeammateState & { posted: boolean; message: string; cost_usd: number }> {
    return this.client.post('/api/teammate/morning-check', { model });
  }
}

export const teammateService = new TeammateService(api);
