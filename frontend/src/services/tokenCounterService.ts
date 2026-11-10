import { api, type ApiClient } from './apiClient';

/** One model family in the token counter, and how its count is made. */
export interface CounterModel {
  id: string;
  provider: string;
  name: string;
  how: 'count_tokens' | 'tokenizer';
  repo?: string;
  exact: boolean;
  note: string;
  input_price: number | null; // dollars per million input tokens, where the lab has a price
  context: number | null;
  ready: boolean; // the tokenizer is downloaded (always true for count_tokens)
}

/** A run of text that the tokenizer made into `tokens` tokens (more than one when a character is split). */
export interface Segment {
  text: string;
  tokens: number;
}

export interface CountResult extends CounterModel {
  tokens: number | null;
  system_tokens?: number;
  prompt_tokens?: number;
  request_tokens?: number | null; // with the framing a request carries, where the lab can count it
  segments?: { system: Segment[]; prompt: Segment[] } | null; // null when the tokenizer is not published
  cost_usd?: number | null;
  error?: string;
}

/** The token counter's backend: /api/token-counter. Counting is free. */
export class TokenCounterService {
  constructor(private readonly client: ApiClient) {}

  models(): Promise<CounterModel[]> {
    return this.client.get('/api/token-counter/models');
  }

  count(body: { model: string; system: string; prompt: string }): Promise<CountResult> {
    return this.client.post('/api/token-counter/count', body);
  }

  compare(body: { system: string; prompt: string }): Promise<CountResult[]> {
    return this.client.post('/api/token-counter/compare', body);
  }
}

export const tokenCounterService = new TokenCounterService(api);
