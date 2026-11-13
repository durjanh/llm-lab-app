import { api, type ApiClient } from './apiClient';

export interface Switches {
  enforce_gate: boolean;
  hooks: boolean;
  trim: boolean;
  case_facts: boolean;
  vague_tools: boolean;
  dangerous_tool: boolean;
}

export interface McpResult {
  isError: boolean;
  content: { type: string; text: string }[];
  structuredContent: Record<string, unknown>;
}

export interface Change {
  field: string;
  raw: unknown;
  normalised: unknown;
}

export type TraceItem =
  | { kind: 'user'; text: string }
  | {
      kind: 'model';
      iteration: number;
      stop_reason: string;
      decision: string;
      text: string;
      tool_uses: { id: string; name: string; input: Record<string, unknown> }[];
      input_tokens: number;
      output_tokens: number;
      cost_usd: number;
    }
  | {
      kind: 'tool';
      name: string;
      input: Record<string, unknown>;
      blocked_by: 'gate' | 'pre_hook' | null;
      result: McpResult;
      raw_tokens: number;
      context_tokens: number;
      changes: Change[];
      dangerous: boolean;
      audit?: string | null;
    }
  | { kind: 'safety_stop'; message: string };

export type Outcome = 'resolved' | 'escalated' | 'asked_identifier' | 'unresolved';

export interface ChatReply {
  case_id: string;
  reply: string;
  trace: TraceItem[];
  iterations: number;
  stop_reason: string | null;
  stopped: string | null;
  cost_usd: number;
  facts_block: string;
  outcome: Outcome;
  model: string;
  verified: string | null;
  tokens: { raw: number; context: number };
}

export interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface SupportInfo {
  shop: string;
  refund_limit_usd: number;
  refund_window_days: number;
  today: string;
  max_iterations: number;
  system_prompt: string;
  tools: { clear: ToolDef[]; vague: ToolDef[]; dangerous: ToolDef };
  customers: { id: string; name: string; email: string; postcode: string; orders: string[] }[];
  selection_requests: { message: string; expect: string }[];
  choice_message: string;
  eval_cases: { id: string; title: string; message: string; expect: Outcome }[];
  examples: { label: string; message: string }[];
  context: {
    raw: Record<string, unknown>;
    trimmed: Record<string, unknown>;
    fields_raw: number;
    fields_trimmed: number;
    tokens_raw: number;
    tokens_trimmed: number;
    changes: Change[];
  };
}

export interface SelectionRow {
  message: string;
  expect: string;
  called: string | null;
  correct: boolean;
  overlap: boolean;
  dangerous: boolean;
}

export interface SelectionResult {
  set: 'vague' | 'clear';
  tools: string[];
  rows: SelectionRow[];
  correct: number;
  total: number;
  dangerous_calls: number;
  cost_usd: number;
}

export interface ChoiceRun {
  mode: 'auto' | 'any' | 'forced';
  tool_choice: Record<string, unknown>;
  stop_reason: string;
  text: string;
  tool_calls: { name: string; input: Record<string, unknown> }[];
  cost_usd: number;
}

export interface ChoiceResult {
  message: string;
  runs: ChoiceRun[];
  cost_usd: number;
}

export interface EvalSummary {
  total: number;
  passed: number;
  resolved: number;
  escalated: number;
  asked_identifier: number;
  fcr_rate: number | null;
  resolvable_fcr: number | null;
  correct_routing: number | null;
}

export interface EvalResult {
  id: string;
  title: string;
  message: string;
  expect: Outcome;
  outcome: Outcome;
  passed: boolean;
  notes: string[];
  reply: string;
  trace: TraceItem[];
  iterations: number;
  cost_usd: number;
  facts_block: string;
}

export type EvalEvent =
  | { type: 'run'; run_id: string }
  | { type: 'start'; total: number; model: string }
  | { type: 'progress'; step: string }
  | { type: 'case'; index: number; of: number; result: EvalResult; spent_usd: number }
  | { type: 'done'; summary: EvalSummary; stopped: string | null; cost_usd: number }
  | { type: 'error'; message: string };

/** The support desk agent: a loop over four tools for an invented shop, with every mechanism visible. */
export class SupportDeskService {
  constructor(private readonly client: ApiClient = api) {}

  info(): Promise<SupportInfo> {
    return this.client.get('/api/support-desk/info');
  }

  chat(message: string, model: string, switches: Switches, caseId: string | null): Promise<ChatReply> {
    return this.client.post('/api/support-desk/chat', { message, model, case_id: caseId, ...switches });
  }

  toolSelection(model: string, vague: boolean, dangerous: boolean): Promise<SelectionResult> {
    return this.client.post('/api/support-desk/tool-selection', {
      model,
      vague_tools: vague,
      dangerous_tool: dangerous,
    });
  }

  toolChoice(model: string, message: string): Promise<ChoiceResult> {
    return this.client.post('/api/support-desk/tool-choice', { model, message });
  }

  evaluate(model: string, switches: Switches, onEvent: (e: EvalEvent) => void, signal?: AbortSignal): Promise<void> {
    return this.client.stream('/api/support-desk/evaluate', { model, ...switches }, onEvent, signal);
  }
}

export const supportDeskService = new SupportDeskService();
