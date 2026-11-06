import { api, type ApiClient } from './apiClient';

/** What GET /api/status returns. */
interface StatusResponse {
  ok: boolean;
  has_credentials: boolean;
  default_model: string;
  models: string[];
  claude_models?: string[];
  claude_model?: string;
  local?: LocalModelStatus;
  gpt_models?: string[];
  prices: Record<string, { input: number; output: number; cache_read: number }>;
  spent_usd: number;
  budget_usd: number;
  calls: number;
}

/** The open model on this machine (Docker Model Runner), when one is configured. */
export interface LocalModelStatus {
  configured: boolean;
  running?: boolean;
  has_model?: boolean;
  model?: string;
}

/** Whether live Claude features can be used, and why not when they cannot. */
export interface LiveStatus {
  available: boolean;
  has_credentials?: boolean;
  default_model?: string;
  models?: string[]; // the local model first, when one is configured: it is the default where it can do the work
  claude_models?: string[]; // for pages whose work needs Claude (skills, code execution, web search)
  claude_model?: string;
  local?: LocalModelStatus;
  gpt_models?: string[]; // Azure OpenAI deployments; offered only on pages that support them
  prices?: StatusResponse['prices'];
  spent_usd?: number;
  budget_usd?: number;
  reason?: string;
}

const NO_FILE = 'Open this page through the lab backend to use live Claude. The Start section of README.md has the one-time setup and the command: python -m backend';
const NO_SERVER = 'The lab backend is not running. From the project folder, activate the environment with source .venv/bin/activate, then run python -m backend --budget 1. The Start section of README.md has the one-time setup.';
const NO_KEY = 'The server is running but has no API credentials. Set ANTHROPIC_API_KEY and restart it.';

/** The backend's status: credentials, models, prices and spend. Cached until refresh(). */
export class StatusService {
  private cached: Promise<LiveStatus> | null = null;

  constructor(private readonly client: ApiClient) {}

  /** Only a reachable backend is cached, so a page opened after the backend starts checks again. */
  status(): Promise<LiveStatus> {
    const pending = (this.cached ??= this.load());
    pending.then((s) => {
      if (!s.available && this.cached === pending) this.cached = null;
    });
    return pending;
  }

  refresh(): Promise<LiveStatus> {
    this.cached = null;
    return this.status();
  }

  private async load(): Promise<LiveStatus> {
    if (location.protocol === 'file:') return { available: false, reason: NO_FILE };
    try {
      const s = await this.client.get<StatusResponse>('/api/status', { headers: { 'Cache-Control': 'no-store' } });
      return {
        available: true,
        has_credentials: !!s.has_credentials,
        default_model: s.default_model,
        models: s.models || [],
        claude_models: s.claude_models || s.models || [],
        claude_model: s.claude_model || s.default_model,
        local: s.local,
        gpt_models: s.gpt_models || [],
        prices: s.prices || {},
        spent_usd: s.spent_usd,
        budget_usd: s.budget_usd,
        ...(s.has_credentials ? {} : { reason: NO_KEY }),
      };
    } catch {
      return { available: false, reason: NO_SERVER };
    }
  }
}

export const statusService = new StatusService(api);
