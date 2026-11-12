import { api, type ApiClient } from './apiClient';

export type RiskAnswer = 'yes' | 'no' | 'unsure';

export interface BrainInfo {
  risks: { id: string; factor: string; question: string }[];
  notice: string;
  clock_time: string;
  model: string;
}

export interface ClockScore {
  score: number;
  out_of: number;
  points: Record<string, boolean>;
  notes: string;
}

/** One saved check, kept only when the person agreed. */
export interface BrainEntry {
  date: string;
  total: number;
  recall: number;
  orientation: number;
  clock: number | null;
  animals: number;
  outcome: string;
}

export interface BrainResult {
  date: string;
  user: string;
  scores: {
    recall: { score: number; out_of: number; remembered: string[]; missed: string[] };
    orientation: { score: number; out_of: number; right: Record<string, boolean> };
    clock: ClockScore | null;
    fluency: { count: number; animals: string[] };
    total: number;
    total_out_of: number;
  };
  outcome: { key: 'fine' | 'repeat' | 'gp' | 'concern'; title: string; text: string; low: string[]; drops: string[] };
  risks: { factor: string; advice: string; why: string }[];
  earlier: BrainEntry[];
  notice: string;
  next_check: string;
  saved: boolean;
  cost_usd: number;
}

export interface BrainAnswers {
  model?: string;
  user: string;
  save: boolean;
  concern: boolean;
  today: string;
  recall: string[];
  orientation: { weekday: string; day: string; month: string; year: string };
  fluency_text: string;
  risks: Record<string, RiskAnswer>;
}

/** The brain health check: its tasks in order, the scoring done by the backend, and the saved history. */
export class BrainService {
  constructor(private readonly client: ApiClient) {}

  info(): Promise<BrainInfo> {
    return this.client.get('/api/brain/info');
  }

  start(): Promise<{ check_id: string; words: string[] }> {
    return this.client.post('/api/brain/checks', {});
  }

  clock(checkId: string, image: string, model?: string): Promise<{ clock: ClockScore; cost_usd: number }> {
    return this.client.post(`/api/brain/checks/${checkId}/clock`, { image, model });
  }

  finish(checkId: string, answers: BrainAnswers): Promise<BrainResult> {
    return this.client.post(`/api/brain/checks/${checkId}/finish`, answers);
  }

  pdf(checkId: string): Promise<void> {
    return this.client.saveFile(`/api/brain/checks/${checkId}/pdf`, 'brain-health-check.pdf');
  }

  forget(user: string): Promise<{ history: BrainEntry[] }> {
    return this.client.delete(`/api/brain/history/${encodeURIComponent(user)}`);
  }
}

export const brainService = new BrainService(api);
