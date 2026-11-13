import { api, type ApiClient } from './apiClient';

export type TaskType = 'analysis' | 'research' | 'drafting' | 'brainstorming';

export interface Template {
  task_type: TaskType;
  label: string;
  sections: Record<'role' | 'context' | 'task' | 'constraints' | 'output_format', string>;
  prompt: string;
}
export interface TaskRuns {
  runs: (Template & { answer: string })[];
  cost_usd: number;
  model: string;
}
export interface Decomposed {
  summary: string;
  steps: { title: string; what_to_ask: string; check_before_next: string; depends_on_previous: boolean }[];
  cost_usd: number;
}
export interface Rewritten {
  versions: { audience: string; text: string; what_changed: string; why: string }[];
  cost_usd: number;
}
export type ClaimVerdict = 'supported' | 'contradicted' | 'unverifiable';
export interface Checked {
  claims: { claim: string; verdict: ClaimVerdict; evidence: string }[];
  details_to_check: { detail: string; kind: string; why: string }[];
  bias_signs: { quote: string; concern: string }[];
  verdict: 'send' | 'review_first' | 'do_not_send';
  verdict_reason: string;
  raised_by_code: boolean;
  has_source: boolean;
  cost_usd: number;
}
export interface UseCaseResult {
  verdict: 'appropriate' | 'needs_care' | 'not_appropriate';
  reasons: string[];
  data_issues: { item: string; kind: string; action: string }[];
  redacted_description: string;
  personal_data_found_by_code: string[];
  raised_by_code: boolean;
  escalate: { needed: boolean; to: 'none' | 'developer' | 'architect'; reason: string };
  safer_approach: string;
  cost_usd: number;
}

/** Claude at work: the Associate-exam lab's live tools (prompt by task type, audiences, answer check, use-case check). */
export class AtWorkService {
  constructor(private readonly client: ApiClient = api) {}

  template(taskType: TaskType, goal: string, context: string): Promise<Template> {
    const q = new URLSearchParams({ task_type: taskType, goal, context });
    return this.client.get(`/api/at-work/template?${q}`);
  }
  run(goal: string, context: string, taskTypes: TaskType[], model: string): Promise<TaskRuns> {
    return this.client.post('/api/at-work/run', { goal, context, task_types: taskTypes, model });
  }
  decompose(request: string, model: string): Promise<Decomposed> {
    return this.client.post('/api/at-work/decompose', { request, model });
  }
  rewrite(source: string, audiences: string[], model: string): Promise<Rewritten> {
    return this.client.post('/api/at-work/rewrite', { source, audiences, model });
  }
  check(answer: string, source: string, model: string): Promise<Checked> {
    return this.client.post('/api/at-work/check', { answer, source, model });
  }
  useCase(task: string, data: string, model: string): Promise<UseCaseResult> {
    return this.client.post('/api/at-work/use-case', { task, data, model });
  }
}

export const atWorkService = new AtWorkService();
