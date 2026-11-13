import { api, type ApiClient } from './apiClient';

export interface ReviewFinding {
  file: string;
  line: number;
  severity: string;
  issue: string;
  suggested_fix?: string;
  detected_pattern?: string;
  status?: string;
  confidence?: number;
  verdict: 'found' | 'duplicate' | 'noise' | 'not in key';
  matches: string;
  status_ok?: boolean;
}

export interface ReviewVariant {
  name: string;
  about: string;
  model: string;
  findings: ReviewFinding[];
  found: string[];
  missed: string[];
  false_positives: number;
  noise_hits: number;
  duplicates: number;
  precision: number | null;
  recall: number;
  tokens_in: number;
  tokens_out: number;
  calls: number;
  cost_usd: number;
  steps?: { step: string; findings: number }[];
  contradictions?: { file: string; a: string; b: string }[];
  explanation?: string;
}

export interface ReviewInfo {
  files: { name: string; code: string; lines: number }[];
  key: { id: string; severity: string; cross_file: boolean; what: string; where: string[] }[];
  noise: { id: string; kind: string; what: string }[];
  prompts: { vague: string; explicit: string };
  thresholds: { comment: number; triage: number };
  schema: unknown;
}

export interface ConfidenceResult {
  variant: ReviewVariant;
  routing: { lane: string; count: number; real: number; dismissed: number; findings: ReviewFinding[] }[];
  dismissed_patterns: { pattern: string; count: number }[];
}

export interface CiResult {
  changed_file: string;
  first: ReviewVariant;
  second: ReviewVariant;
  fixed: string[];
  still_open: string[];
}

/** The review-passes lab: each call runs a few reviews of one invented change set and scores them against a key. */
export class ReviewPassesService {
  constructor(private readonly client: ApiClient = api) {}

  info(): Promise<ReviewInfo> {
    return this.client.get('/api/review-passes/info');
  }
  criteria(model: string): Promise<{ variants: ReviewVariant[] }> {
    return this.client.post('/api/review-passes/criteria', { model });
  }
  passes(model: string): Promise<{ variants: ReviewVariant[] }> {
    return this.client.post('/api/review-passes/passes', { model });
  }
  independent(model: string): Promise<{ variants: ReviewVariant[] }> {
    return this.client.post('/api/review-passes/independent', { model });
  }
  confidence(model: string): Promise<ConfidenceResult> {
    return this.client.post('/api/review-passes/confidence', { model });
  }
  ci(model: string): Promise<CiResult> {
    return this.client.post('/api/review-passes/ci', { model });
  }
}

export const reviewPassesService = new ReviewPassesService();
