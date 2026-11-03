import { api, type ApiClient } from './apiClient';
import type { ContentBlock } from './messagesService';

export type Scenario = 'chain' | 'parallel' | 'team' | 'bash' | 'web';

export interface HarnessRunRequest {
  scenario: Scenario;
  number: number;
  task?: string;
  model?: string;
  effort?: 'low' | 'medium' | 'high';
}

/** Where an event happened: "main", or a sub-agent such as "math_agent 2", and how deeply it is nested. */
interface Where {
  who: string;
  depth: number;
}

/** One line of a live harness run, as python/11_harness_loop.py emits it. */
export type HarnessEvent =
  | { type: 'run'; run_id: string }
  | { type: 'task'; task: string; model: string; tools: string[] }
  | (Where & { type: 'agent_start'; agent: string; task: string; system: string; tools: string[] })
  | (Where & { type: 'request'; agent: string; turn: number; stop_reason: string; content: ContentBlock[]; input_tokens: number; output_tokens: number; cost: number })
  | (Where & { type: 'server_tool'; name: string; input: Record<string, unknown> })
  | (Where & { type: 'says'; agent: string; text: string })
  | (Where & { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> })
  | (Where & { type: 'parallel'; count: number; names: string[] })
  | (Where & { type: 'result'; name: string; tool_use_id: string; content: string; is_error: boolean; seconds: number })
  | (Where & { type: 'approval'; id: string; name: string; input: { command?: string; restart?: boolean }; reason: string; timeout_s: number })
  | { type: 'approval_done'; id: string; allow: boolean; timed_out: boolean }
  | (Where & { type: 'agent_end'; agent: string; answer: string })
  | { type: 'final'; answer: string | null; outcome: string; usage: Record<string, { calls: number; input: number; output: number; cost: number }>; tool_calls: number; tool_seconds: number; wall_seconds: number; cost: number; spent_usd: number }
  | { type: 'error'; message: string };

/** Live runs of the ten-tool harness, and answers to the bash commands that wait for a person. */
export class HarnessService {
  constructor(private readonly client: ApiClient) {}

  run(body: HarnessRunRequest, onEvent: (event: HarnessEvent) => void, signal?: AbortSignal): Promise<void> {
    return this.client.stream('/api/harness/run', body, onEvent, signal);
  }

  approve(runId: string, toolUseId: string, allow: boolean): Promise<{ ok: boolean }> {
    return this.client.post('/api/harness/approve', { run_id: runId, tool_use_id: toolUseId, allow });
  }
}

export const harnessService = new HarnessService(api);
