import type { AxiosProgressEvent } from 'axios';
import { api, type ApiClient } from './apiClient';

/* The assistant page's backend: stored chats, uploads, a streamed agentic turn, plan approvals and previews. */

export type Provider = 'anthropic' | 'azure-openai' | 'local';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
/** Why a turn ended; 'running' is a stored turn that has not ended yet (it may be running in another tab). */
export type StopReason = 'finished' | 'budget' | 'time' | 'stopped' | 'refused' | 'error' | 'running';
export type StepStatus = 'todo' | 'doing' | 'done' | 'skipped';

export interface AssistantModel {
  id: string;
  name: string;
  provider: Provider;
  context_window: number;
  /** The effort levels this model accepts; empty when it ignores effort (the local model). */
  efforts: Effort[];
}

export interface AssistantInfo {
  models: AssistantModel[];
  default_model: string;
  efforts_all: Effort[];
  run_budget_usd: number;
  max_parallel_agents: number;
  run_time_limit_s: number;
  compact_at_tokens: number;
  sandbox: { available: boolean; kind: string; message: string };
  upload: { max_files: number; max_file_bytes: number; extensions: string[] };
}

export interface ChatSummary {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  model: string;
  status: 'idle' | 'running';
  cost_usd: number;
}

export interface AssistantFile {
  id: string;
  name: string;
  size: number;
  media_type: string;
  /** Media-route paths: they need no lab header, so img tags and plain links can use them. */
  url: string;
  previews: string[];
}

/** An uploaded file as the upload route returns it, before it is part of a turn. */
export interface UploadedFile {
  id: string;
  name: string;
  size: number;
  media_type: string;
}

export interface PlanStep {
  text: string;
  status: StepStatus;
}

export interface Plan {
  steps: PlanStep[];
  revision: number;
}

export interface ChatSettings {
  model: string;
  effort: Effort;
  run_budget_usd: number;
  approve_plans: boolean;
  /** MCP servers enabled in this chat; absent on chats made before MCP servers existed (then: every enabled one). */
  mcp_servers?: string[];
}

export interface McpTool {
  name: string;
  description: string;
}

/** A remote MCP server the person added. Its token never comes back from the backend; only whether one is set. */
export interface McpServer {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  ask_before_call: boolean;
  token_set: boolean;
  status: 'ok' | 'error' | 'unchecked';
  message: string;
  checked_at: number | null;
  tools: McpTool[];
}

export interface McpServerInput {
  name: string;
  url: string;
  /** Only sent when the person typed one; '' on an edit clears the stored token. */
  token?: string;
  ask_before_call: boolean;
}

export interface McpServerPatch {
  name?: string;
  url?: string;
  token?: string;
  enabled?: boolean;
  ask_before_call?: boolean;
}

/** A deliverable from any chat, newest first, for the start screen and the Files view. */
export interface RecentFile {
  chat_id: string;
  chat_title: string;
  turn_id: string;
  created_at: string;
  file: AssistantFile;
}

export interface Turn {
  id: string;
  created_at: string;
  user: { text: string; attachments: AssistantFile[] };
  assistant: {
    text: string;
    model: string;
    models_used: string[];
    plan: Plan | null;
    files: AssistantFile[];
    cost_usd: number;
    stopped: StopReason;
    error?: string;
  };
  log_count: number;
}

export interface Chat {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  status: 'idle' | 'running';
  cost_usd: number;
  settings: ChatSettings;
  uploads: AssistantFile[];
  turns: Turn[];
}

interface Stamped {
  ts: number;
}

/** Every line the send route streams. Each belongs to an agent ("main", "sub-1", …) where that makes sense. */
export type AssistantEvent = Stamped &
  (
    | { type: 'run'; run_id: string }
    | { type: 'turn'; turn_id: string }
    | { type: 'model_call'; agent: string; model: string; effort: Effort | null; n: number }
    | { type: 'text'; agent: string; delta: string }
    | { type: 'thinking'; agent: string; text: string }
    | { type: 'plan'; agent: string; plan: Plan; reason?: string }
    | { type: 'plan_approval'; approval_id: string; plan: Plan }
    | {
        type: 'tool_call';
        agent: string;
        id: string;
        name: string;
        input: unknown;
        network: boolean;
        /** Set when the tool belongs to one of the person's MCP servers. */
        /** `description` is the server's own text (untrusted), sent only on the tool's first use in a turn. */
        mcp?: { server_id: string; server: string; tool: string; description?: string };
      }
    | {
        type: 'tool_approval';
        approval_id: string;
        agent: string;
        server: string;
        tool: string;
        input: unknown;
      }
    | { type: 'note'; agent: string; text: string }
    | {
        type: 'tool_result';
        agent: string;
        id: string;
        ok: boolean;
        output: string;
        exit_code?: number;
        duration_ms: number;
        truncated: boolean;
      }
    | { type: 'file'; agent: string; file: AssistantFile }
    | { type: 'agent_start'; agent: string; brief: string; expected_output: string }
    | { type: 'agent_end'; agent: string; summary: string; cost_usd: number; stopped: StopReason }
    | {
        type: 'usage';
        agent: string;
        model: string;
        input_tokens: number;
        output_tokens: number;
        cache_read_tokens: number;
        cost_usd: number;
        run_cost_usd: number;
        /** A call stopped or failed part-way: the cost is an estimate from what had streamed. */
        partial?: boolean;
      }
    | { type: 'compaction'; covers_until: string; tokens_before: number; tokens_after: number; model: string }
    | { type: 'model_switch'; from: string; to: string }
    | { type: 'fallback'; agent: string; from: string; to: string; reason: string }
    | { type: 'title'; title: string }
    | { type: 'done'; stopped: StopReason; cost_usd: number; text: string }
    | { type: 'error'; message: string }
  );

export type EventType = AssistantEvent['type'];

export interface SendRequest {
  text: string;
  attachments: string[];
  model: string;
  /** '' for a model that takes no effort setting. */
  effort: Effort | '';
  run_budget_usd: number;
  approve_plans: boolean;
  /** The chat's MCP servers, sent only when the person changed them; left out, the chat keeps its saved list. */
  mcp_servers?: string[];
}

export interface ApproveRequest {
  run_id: string;
  approval_id: string;
  decision: 'approve' | 'reject';
  steps?: PlanStep[];
  note?: string;
}

export interface CompactResult {
  compacted: boolean;
  covers_until: string;
  tokens_before: number;
  tokens_after: number;
}

const chatPath = (id: string) => `/api/assistant/chats/${encodeURIComponent(id)}`;

/** The general assistant: chats with an agent that plans, works in the sandbox and makes files. */
export class AssistantService {
  constructor(private readonly client: ApiClient) {}

  info(): Promise<AssistantInfo> {
    return this.client.get('/api/assistant/info');
  }

  chats(): Promise<ChatSummary[]> {
    return this.client.get('/api/assistant/chats');
  }

  create(): Promise<ChatSummary> {
    return this.client.post('/api/assistant/chats', {});
  }

  chat(id: string): Promise<Chat> {
    return this.client.get(chatPath(id));
  }

  rename(id: string, title: string): Promise<ChatSummary> {
    return this.client.patch(chatPath(id), { title });
  }

  remove(id: string): Promise<void> {
    return this.client.delete(chatPath(id));
  }

  /** Puts files in the chat's inputs folder; free, so it needs no budget. */
  upload(id: string, files: File[], onProgress?: (fraction: number) => void): Promise<UploadedFile[]> {
    const form = new FormData();
    for (const f of files) form.append('files', f, f.name);
    return this.client.post(`${chatPath(id)}/files`, form, {
      onUploadProgress: (e: AxiosProgressEvent) => onProgress?.(e.total ? e.loaded / e.total : 0),
    });
  }

  /** Sends one message and streams the turn: plan, commands, files, reply and the reason it stopped. */
  send(id: string, req: SendRequest, onEvent: (e: AssistantEvent) => void, signal?: AbortSignal): Promise<void> {
    return this.client.stream(`${chatPath(id)}/send`, req, onEvent, signal);
  }

  approve(req: ApproveRequest): Promise<unknown> {
    return this.client.post('/api/assistant/approve', req);
  }

  stop(runId: string): Promise<unknown> {
    return this.client.post(`/api/assistant/runs/${encodeURIComponent(runId)}/stop`, {});
  }

  compact(id: string): Promise<CompactResult> {
    return this.client.post(`${chatPath(id)}/compact`, {});
  }

  /** The saved activity log of one past turn. */
  log(id: string, turnId: string): Promise<AssistantEvent[]> {
    return this.client.get(`${chatPath(id)}/turns/${encodeURIComponent(turnId)}/log`);
  }

  /** Deliverables from every chat, newest first. */
  recentFiles(limit = 12): Promise<RecentFile[]> {
    return this.client.get(`/api/assistant/files/recent?limit=${limit}`);
  }

  mcpServers(): Promise<McpServer[]> {
    return this.client.get('/api/assistant/mcp');
  }

  /** Adds a server; the backend connects and lists its tools first, and refuses one it cannot reach. */
  addMcpServer(input: McpServerInput): Promise<McpServer> {
    return this.client.post('/api/assistant/mcp', input);
  }

  updateMcpServer(id: string, patch: McpServerPatch): Promise<McpServer> {
    return this.client.patch(`/api/assistant/mcp/${encodeURIComponent(id)}`, patch);
  }

  removeMcpServer(id: string): Promise<void> {
    return this.client.delete(`/api/assistant/mcp/${encodeURIComponent(id)}`);
  }

  /** Reconnects and refreshes the server's tools and status. */
  checkMcpServer(id: string): Promise<McpServer> {
    return this.client.post(`/api/assistant/mcp/${encodeURIComponent(id)}/check`, {});
  }
}

export const assistantService = new AssistantService(api);
