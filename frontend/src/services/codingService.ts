import { api, type ApiClient } from './apiClient';

export type CodingMode = 'default' | 'accept_edits' | 'plan' | 'bypass' | 'auto';
export type CodingWorkspace = 'practice' | 'files';

export interface Todo {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface CodingState {
  session_id: string;
  workspace: CodingWorkspace;
  mode: CodingMode;
  files: { path: string; new: boolean; changed: boolean }[];
  deleted: string[];
  diff: string;
  todos: Todo[];
  checkpoints: { id: number; path: string; tool: string }[];
  turns: number;
  cost: number;
}

export interface ShotImage {
  media_type: string;
  data: string; // base64
}

/** One line of a run, from python/19_coding_agent.py or from the Agent SDK version; both use the same shapes. */
export type CodingEvent =
  | { type: 'run'; run_id: string }
  | { type: 'session'; session_id: string | null; mode: CodingMode; model: string; sdk?: boolean }
  | { type: 'init'; tools: string[]; model: string; mode: string }
  | {
      type: 'turn';
      depth: number;
      input_tokens: number;
      cache_read: number;
      cache_write: number;
      output_tokens: number;
      cost: number;
    }
  | { type: 'text'; who: string; depth: number; text: string }
  | { type: 'tool_use'; who: string; depth: number; id: string; name: string; input: Record<string, unknown> }
  | { type: 'diff'; id: string; path: string; diff: string }
  | { type: 'approval'; id: string; name: string; input: Record<string, unknown>; reason: string; timeout_s: number }
  | { type: 'approval_done'; id: string; allow: boolean; timed_out: boolean }
  | {
      type: 'result';
      who: string;
      depth: number;
      id: string;
      name: string;
      content: string;
      is_error: boolean;
      images?: ShotImage[]; // what a screenshot or an image read sent to Claude
    }
  | { type: 'todos'; todos: Todo[] }
  | { type: 'checkpoint'; id: number; path: string; tool: string; count: number }
  | { type: 'cleared'; count: number; tokens: number }
  | { type: 'stop_check'; passed: boolean; command: string; output: string }
  | { type: 'installed'; packages: Record<string, string[]>; note: string }
  | { type: 'agent_start'; depth: number; task: string }
  | { type: 'agent_end'; depth: number }
  | {
      type: 'final';
      answer: string | null;
      outcome: string;
      turns: number;
      cost: number;
      tool_calls?: number;
      seconds?: number;
      spent_usd: number;
      state?: CodingState;
      diff?: string;
    }
  | { type: 'error'; message: string };

export interface CodingInfo {
  models: string[]; // Claude models, then the GPT deployments the hand-built harness can use
  gpt_models: string[];
  tasks: Record<string, string>;
  workspaces: Record<CodingWorkspace, string[]>; // the tasks that fit each workspace
  sample: string; // the invented workbook offered in Your files
  modes: CodingMode[];
  sdk: boolean;
  screenshot: boolean; // Chrome was found, so the agent can see pages
  sandbox: string | null; // what contains auto mode: seatbelt, bwrap, container, or nothing
  rules: { deny: string[]; allow: string[]; auto_deny: string[] };
}

/** The coding agent: the hand-built harness and its Agent SDK twin, approvals, the project folder and undo. */
export class CodingService {
  constructor(private readonly client: ApiClient) {}

  info(): Promise<CodingInfo> {
    return this.client.get('/api/coding/info');
  }
  run(
    body: { prompt: string; session_id?: string; mode: CodingMode; model?: string },
    onEvent: (e: CodingEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.client.stream('/api/coding/run', body, onEvent, signal);
  }
  sdkRun(
    body: { prompt: string; mode: CodingMode; model?: string },
    onEvent: (e: CodingEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.client.stream('/api/coding/sdk-run', body, onEvent, signal);
  }
  approve(runId: string, toolUseId: string, allow: boolean): Promise<{ ok: boolean }> {
    return this.client.post('/api/coding/approve', { run_id: runId, tool_use_id: toolUseId, allow });
  }
  state(sessionId: string): Promise<CodingState> {
    return this.client.get(`/api/coding/sessions/${sessionId}`);
  }
  file(
    sessionId: string,
    path: string,
  ): Promise<{ path: string; content: string; original: string | null; image?: string }> {
    return this.client.get(`/api/coding/sessions/${sessionId}/file`, { params: { path } });
  }
  create(workspace: CodingWorkspace): Promise<CodingState> {
    return this.client.post('/api/coding/sessions', { workspace });
  }
  addFile(sessionId: string, file: File): Promise<CodingState> {
    const form = new FormData();
    form.append('file', file);
    return this.client.post(`/api/coding/sessions/${sessionId}/files`, form);
  }
  addSample(sessionId: string): Promise<CodingState> {
    return this.client.post(`/api/coding/sessions/${sessionId}/sample`, {});
  }
  /** A plain link, so it works as a download: the session id is the key. */
  downloadUrl(sessionId: string, path: string): string {
    return `/api/coding/sessions/${sessionId}/download?path=${encodeURIComponent(path)}`;
  }
  undo(sessionId: string): Promise<CodingState & { undone: { path: string; tool: string } }> {
    return this.client.post(`/api/coding/sessions/${sessionId}/undo`, {});
  }
}

export const codingService = new CodingService(api);
