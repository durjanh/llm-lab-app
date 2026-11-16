import { api, type ApiClient } from './apiClient';

export type MemoryKind = 'fact' | 'preference' | 'procedure' | 'episode';

export interface MemorySource {
  session: number;
  day: number;
  quote: string;
  by: 'person' | 'agent';
}

export interface Memory {
  id: string;
  kind: MemoryKind;
  level: string; // semantic, procedural or episodic
  subject: string;
  text: string;
  importance: number;
  status: 'active' | 'superseded' | 'forgotten';
  uses: number;
  created_day: number;
  last_used_day: number;
  strength: number;
  sources: MemorySource[];
  replaces: string | null;
  replaced_by: string | null;
  reason: string;
  links: string[];
  compression?: { from_tokens: number; to_tokens: number };
}

export interface MemoryLogEntry {
  day: number;
  session: number | null;
  event: string;
  detail: string;
}

export interface MemoryState {
  user: string;
  day: number;
  memories: Memory[];
  sessions: {
    id: string;
    number: number;
    started_day: number;
    ended: boolean;
    episode: string | null;
    messages: number;
  }[];
  log: MemoryLogEntry[];
}

export interface Retrieved {
  id: string;
  relevance: number;
  strength: number;
  score: number;
  why: string;
}

export interface Decision {
  tool: 'remember' | 'forget';
  input: Record<string, unknown>;
  action: string;
  id?: string;
  ids?: string[];
  replaces?: string;
  reason?: string;
}

export interface TurnResult extends MemoryState {
  reply: string;
  retrieved: Retrieved[];
  decisions: Decision[];
  cited: string[];
  faded: string[];
  working_memory: { sent: number; window: number };
  system: string;
  cost_usd: number;
}

export interface MemoryInfo {
  kinds: Record<MemoryKind, string>;
  half_life_days: Record<MemoryKind, number>;
  forget_below: number;
  retrieve: number;
  profile_max: number;
  session_window: number;
  models: string[];
  model: string;
  people: string[];
}

const person = (user: string) => `/api/agent-memory/people/${encodeURIComponent(user)}`;

/** The agent memory lab: people, sessions, messages, the clock and the store. Messages and session ends call Claude. */
export class AgentMemoryService {
  constructor(private readonly client: ApiClient = api) {}

  info(): Promise<MemoryInfo> {
    return this.client.get('/api/agent-memory/info');
  }

  state(user: string): Promise<MemoryState> {
    return this.client.get(person(user));
  }

  reset(user: string): Promise<MemoryState> {
    return this.client.delete(person(user));
  }

  advance(user: string, days: number): Promise<MemoryState> {
    return this.client.post(`${person(user)}/clock`, { days });
  }

  start(user: string): Promise<MemoryState & { session: string }> {
    return this.client.post(`${person(user)}/sessions`, {});
  }

  /** careless tells the model to keep everything word for word, to show the privacy guard refusing it. */
  say(user: string, session: string, text: string, model: string, careless = false): Promise<TurnResult> {
    return this.client.post(`${person(user)}/sessions/${session}/messages`, { text, model, careless });
  }

  end(
    user: string,
    session: string,
    model: string,
  ): Promise<MemoryState & { episode: string | null; cost_usd: number }> {
    return this.client.post(`${person(user)}/sessions/${session}/end`, { model });
  }
}

export const agentMemoryService = new AgentMemoryService(api);
