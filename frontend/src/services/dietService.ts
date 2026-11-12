import { api, type ApiClient } from './apiClient';

export interface DietIngredient {
  item: string;
  quantity: number;
  unit: string;
  aisle: string;
}

export interface DietMeal {
  slot: 'breakfast' | 'lunch' | 'dinner' | 'snack';
  name: string;
  ingredients: DietIngredient[];
  method: string;
  kcal: number;
  protein_g: number;
  prep_minutes: number;
}

export interface DietPlan {
  days: { day: string; meals: DietMeal[] }[];
  notes: string;
}

export interface DietTargets {
  kcal_per_day: number;
  protein_g_per_day: number;
  bmr: number;
  maintenance_kcal: number;
  bmi: number;
  floor_applied: boolean;
  notes?: string[];
}

export interface DietStep {
  tool: string;
  args: Record<string, unknown>;
  result: Record<string, unknown>;
}

export interface MemoryFile {
  path: string;
  text: string;
}

/** What the page shows beside the chat. */
export interface DietState {
  profile: Record<string, unknown> | null;
  targets: DietTargets | null;
  plan: DietPlan | null;
  totals: Record<string, { kcal: number; protein_g: number }> | null;
  shopping: Record<string, { item: string; quantity: number; unit: string }[]> | null;
  aisles: Record<string, string>;
  memory: MemoryFile[];
}

export interface DietReply extends DietState {
  reply: string;
  steps: DietStep[];
  cost_usd: number;
}

export interface DietInfo {
  tools: { name: string; description: string }[];
  samples: { label: string; text: string }[];
  model: string;
  files: Record<'plan' | 'shopping' | 'xlsx', string>;
}

export type DietFile = 'plan' | 'shopping' | 'xlsx';

/** One line of a streamed turn: progress while the planner works, then the reply and the plan. */
export type DietEvent =
  | { type: 'run'; run_id: string }
  | { type: 'thinking' }
  | { type: 'text'; text: string }
  | { type: 'tool_start'; tool: string }
  | { type: 'writing'; tool: string; chars: number }
  | { type: 'step'; step: DietStep }
  | ({ type: 'done' } & DietReply)
  | { type: 'error'; message: string };

/** The diet planner: conversations, the checked plan's files and the person's memory folder. */
export class DietService {
  constructor(private readonly client: ApiClient) {}

  info(): Promise<DietInfo> {
    return this.client.get('/api/diet/info');
  }

  newChat(model: string | undefined, user: string, consent: boolean) {
    return this.client.post<{ chat_id: string; model: string; user: string; consent: boolean; memory: MemoryFile[] }>(
      '/api/diet/chats',
      { model, user, consent },
    );
  }

  send(chatId: string, message: string): Promise<DietReply> {
    return this.client.post(`/api/diet/chats/${chatId}/messages`, { message });
  }

  /** The same turn as send(), streamed: onEvent hears the planner working, and last the reply and the plan. */
  stream(chatId: string, message: string, onEvent: (e: DietEvent) => void, signal?: AbortSignal): Promise<void> {
    return this.client.stream(`/api/diet/chats/${chatId}/stream`, { message }, onEvent, signal);
  }

  download(chatId: string, kind: DietFile, name: string): Promise<void> {
    return this.client.saveFile(`/api/diet/chats/${chatId}/files/${kind}`, name);
  }

  memory(user: string): Promise<{ memory: MemoryFile[] }> {
    return this.client.get(`/api/diet/memory/${encodeURIComponent(user)}`);
  }

  forget(user: string): Promise<{ memory: MemoryFile[] }> {
    return this.client.delete(`/api/diet/memory/${encodeURIComponent(user)}`);
  }
}

export const dietService = new DietService(api);
