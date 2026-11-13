import { api, type ApiClient } from './apiClient';

export type PatternId = 'tool_loop' | 'react' | 'plan_execute' | 'reflexion';

export interface PatternTask {
  id: string;
  level: string;
  title: string;
  prompt: string;
  expected: string;
  checks: string[];
  flaky: boolean;
}

export interface PatternsInfo {
  tasks: PatternTask[];
  patterns: { id: PatternId; name: string }[];
  tools: { name: string; description: string }[];
  policies: Record<string, string>;
  today: string;
  max_steps: number;
  max_steps_plan: number;
  products: { id: string; name: string; price: number; stock: number }[];
  orders: { id: string; customer: string; placed: string; delivered: string | null; status: string }[];
}

/** One step of one pattern, as it happened. */
export interface PatternStep {
  type: 'step';
  pattern: PatternId;
  kind:
    | 'start'
    | 'call'
    | 'thought'
    | 'text'
    | 'note'
    | 'action'
    | 'observation'
    | 'plan'
    | 'step'
    | 'step_done'
    | 'attempt'
    | 'critique';
  role?: string;
  calls?: number;
  cost_usd?: number;
  tokens?: number;
  text?: string;
  tool?: string;
  input?: Record<string, unknown>;
  result?: Record<string, unknown>;
  ok?: boolean;
  steps?: string[];
  revision?: number;
  attempt?: number;
  verdict?: 'pass' | 'revise';
  problems?: string[];
}

export interface PatternResult {
  type: 'result';
  pattern: PatternId;
  answer: string;
  passed: boolean;
  detail: string;
  stopped: string | null;
  model_calls: number;
  tool_calls: number;
  input_tokens: number;
  output_tokens: number;
  seconds: number;
  cost_usd: number;
}

export type PatternEvent =
  | { type: 'run'; run_id: string }
  | { type: 'started'; task: string; patterns: PatternId[]; model: string; budget_usd: number }
  | PatternStep
  | PatternResult
  | { type: 'done'; spent_usd: number; passed: PatternId[] }
  | { type: 'error'; message: string };

/** ReAct and planning patterns: the same task run by several agent patterns at once, streamed. */
export class PlanningPatternsService {
  constructor(private readonly client: ApiClient = api) {}

  info(): Promise<PatternsInfo> {
    return this.client.get('/api/planning-patterns/info');
  }

  run(
    task: string,
    patterns: PatternId[],
    model: string,
    budgetUsd: number,
    onEvent: (e: PatternEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.client.stream(
      '/api/planning-patterns/run',
      { task, patterns, model, budget_usd: budgetUsd },
      onEvent,
      signal,
    );
  }
}

export const planningPatternsService = new PlanningPatternsService();
