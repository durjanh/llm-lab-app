import { api, type ApiClient } from './apiClient';

export interface McpStep {
  kind: 'call' | 'say' | 'answer';
  text?: string;
  tool?: string;
  input?: Record<string, unknown>;
  result?: string;
  is_error?: boolean;
  declined?: boolean;
  writes?: boolean;
}

/** One raw HTTP exchange with the MCP server, for showing exactly what goes over the wire. */
export interface McpExchange {
  request: { url: string; headers: Record<string, string>; body: unknown };
  status: number;
  headers: Record<string, string>;
  body: unknown;
  ms: number;
}

/** The MCP lab: the example engagements server hosted in the backend, and Claude using it. */
export class McpLabService {
  constructor(private readonly client: ApiClient) {}

  info(): Promise<{ url: string; tokens: Record<string, string> }> {
    return this.client.get('/api/mcp-lab/info');
  }

  reset(): Promise<{ ok: boolean }> {
    return this.client.post('/api/mcp-lab/reset', {});
  }

  ask(task: string, allowWrites: boolean, model?: string): Promise<{ steps: McpStep[]; cost: number }> {
    return this.client.post('/api/mcp-lab/ask', { task, allow_writes: allowWrites, ...(model ? { model } : {}) });
  }

  /**
   * A JSON-RPC request straight to the MCP server, as any MCP client would send it: no lab headers,
   * only the protocol's own, and a bearer token if one is chosen.
   */
  async rpc(url: string, token: string, method: string, params: unknown): Promise<McpExchange> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-06-18',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    const body = { jsonrpc: '2.0', id: 1, method, params };
    const started = performance.now();
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    const text = await r.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* not JSON: show it as text */
    }
    const shown: Record<string, string> = {};
    for (const h of ['content-type', 'www-authenticate']) {
      const v = r.headers.get(h);
      if (v) shown[h] = v;
    }
    return { request: { url, headers, body }, status: r.status, headers: shown, body: parsed, ms: Math.round(performance.now() - started) };
  }
}

export const mcpLabService = new McpLabService(api);
