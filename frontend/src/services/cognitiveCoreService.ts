import { api, type ApiClient } from './apiClient';

export type SetupId = 'core_closed' | 'core_rag' | 'core_tools' | 'big_closed' | 'big_rag' | 'big_tools';

export interface CoreQuestion {
  id: string;
  kind: string;
  text: string;
  expected: string;
}

export interface CoreInfo {
  core_model: string;
  default_big_model: string;
  setups: { id: SetupId; name: string }[];
  questions: CoreQuestion[];
  library: { title: string; text: string }[];
  tools: { name: string; description: string }[];
  prompts: { closed: string; rag: string; tools: string };
  max_steps: number;
}

/** One step of one setup on one question, as it happened. */
export interface CoreStep {
  type: 'step';
  question: string;
  setup: SetupId;
  kind: 'call' | 'tool' | 'observation' | 'retrieved';
  calls?: number;
  cost_usd?: number;
  tool?: string;
  input?: Record<string, unknown>;
  result?: Record<string, unknown>;
  titles?: string[];
}

export interface CoreAnswer {
  type: 'answer';
  question: string;
  setup: SetupId;
  model: string;
  answer: string;
  correct: boolean;
  stopped: string | null;
  model_calls: number;
  tool_calls: number;
  input_tokens: number;
  output_tokens: number;
  seconds: number;
  cost_usd: number;
}

export interface CoreSummary {
  setup: SetupId;
  answered: number;
  correct: number;
  tool_calls: number;
  tokens: number;
  seconds: number;
  cost_usd: number;
}

export type CoreEvent =
  | { type: 'run'; run_id: string }
  | {
      type: 'started';
      questions: string[];
      setups: SetupId[];
      core_model: string;
      big_model: string;
      budget_usd: number;
    }
  | CoreStep
  | CoreAnswer
  | { type: 'done'; spent_usd: number; summary: CoreSummary[] }
  | { type: 'error'; message: string };

/** The cognitive core: a small model and a big one, closed book, with retrieval done for them, and with their own
 * tools, on the same questions, streamed. */
export class CognitiveCoreService {
  constructor(private readonly client: ApiClient = api) {}

  info(): Promise<CoreInfo> {
    return this.client.get('/api/cognitive-core/info');
  }

  run(
    questions: string[],
    setups: SetupId[],
    model: string,
    budgetUsd: number,
    onEvent: (e: CoreEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.client.stream(
      '/api/cognitive-core/run',
      { questions, setups, model, budget_usd: budgetUsd },
      onEvent,
      signal,
    );
  }
}

export const cognitiveCoreService = new CognitiveCoreService();
