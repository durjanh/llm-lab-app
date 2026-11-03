import { api, type ApiClient } from './apiClient';

/** A Messages API request. The backend keeps a safe subset and defaults the model. */
export interface MessagesRequest {
  model?: string;
  max_tokens?: number;
  system?: string | Record<string, unknown>[];
  messages: { role: 'user' | 'assistant'; content: unknown }[];
  tools?: Record<string, unknown>[];
  tool_choice?: Record<string, unknown>;
  output_config?: Record<string, unknown>;
  cache_control?: Record<string, unknown>;
  stop_sequences?: string[];
}

export interface ContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

/** Claude's reply, as the API's JSON. */
export interface ClaudeMessage {
  id: string;
  model: string;
  content: ContentBlock[];
  stop_reason: string | null;
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
}

export interface MessagesResult {
  message: ClaudeMessage;
  timing: { total_ms: number; ttft_ms?: number };
  cost_usd: number | null;
  spent_usd: number;
}

type StreamLine =
  | { type: 'text'; text: string }
  | ({ type: 'done' } & MessagesResult)
  | { type: 'error'; message: string };

/** One request to Claude at a time: /api/messages, /api/stream and /api/count_tokens. */
export class MessagesService {
  constructor(private readonly client: ApiClient) {}

  create(body: MessagesRequest): Promise<MessagesResult> {
    return this.client.post('/api/messages', body);
  }

  countTokens(body: MessagesRequest): Promise<{ input_tokens: number }> {
    return this.client.post('/api/count_tokens', body);
  }

  /** Streams one request. onText(chunk) is called as text arrives; resolves to the final result. */
  async stream(body: MessagesRequest, onText?: (chunk: string) => void): Promise<MessagesResult> {
    let final: MessagesResult | null = null;
    await this.client.stream<StreamLine>('/api/stream', body, (line) => {
      if (line.type === 'text') onText?.(line.text);
      else if (line.type === 'done') final = line;
      else throw new Error(line.message);
    });
    if (!final) throw new Error('The stream ended without a final message.');
    return final;
  }

  /** The visible text of a reply. */
  static text(message: ClaudeMessage | null | undefined): string {
    return message?.content ? message.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('') : '';
  }
}

export const messagesService = new MessagesService(api);
