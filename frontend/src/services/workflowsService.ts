import { api, type ApiClient } from './apiClient';

export interface GraphShape {
  start: string;
  nodes: { id: string; agent: boolean }[];
  edges: { from: string; to: string; kind: string }[];
}

/** One line of a workflow run, as examples/agent-framework/workflows/_wf.py reports it. */
export type WorkflowEvent =
  | { type: 'run'; run_id: string }
  | { type: 'task'; ms: number; pattern: string; title: string; task: string; model: string }
  | ({ type: 'graph'; ms: number } & GraphShape)
  | { type: 'step'; ms: number; node: string; state: 'start' | 'done' | 'failed' | 'skipped'; text: string }
  | { type: 'route'; ms: number; source: string; target: string; how: string }
  | { type: 'ledger'; ms: number; kind: string; text: string }
  | { type: 'output'; ms: number; node: string; text: string }
  | { type: 'note'; ms: number; text: string }
  | { type: 'ask'; ms: number; id: string; question: string }
  | { type: 'answered'; ms: number; id: string; approved: boolean }
  | { type: 'usage'; ms: number; input_tokens: number; output_tokens: number; calls: number }
  | { type: 'approval'; id: string; input: { question: string }; timeout_s: number }
  | { type: 'approval_done'; id: string; allow: boolean; timed_out: boolean }
  | { type: 'final'; cost_usd: number; spent_usd: number; input_tokens: number; output_tokens: number }
  | { type: 'error'; message: string };

/** Live runs of the Agent Framework workflow examples, and answers to a workflow that has stopped for a person. */
export class WorkflowsService {
  constructor(private readonly client: ApiClient) {}

  run(
    pattern: string,
    task: string | undefined,
    onEvent: (e: WorkflowEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.client.stream('/api/workflows/run', { pattern, task }, onEvent, signal);
  }

  approve(runId: string, requestId: string, allow: boolean): Promise<unknown> {
    return this.client.post('/api/workflows/approve', { run_id: runId, tool_use_id: requestId, allow });
  }
}

export const workflowsService = new WorkflowsService(api);
