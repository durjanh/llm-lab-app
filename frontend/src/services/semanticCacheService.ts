import { api, type ApiClient } from './apiClient';

export interface CachePair {
  a: string;
  b: string;
  same: boolean;
  why: string;
  similarity?: number;
  numbers_match?: boolean;
}

export interface CacheEntry {
  id: number;
  scope: string;
  question: string;
  answer: string;
  cost_usd: number;
  ms: number;
  hits: number;
  created: string;
}

export interface CacheStats {
  hits: number;
  misses: number;
  saved_usd: number;
  saved_ms: number;
  spent_usd: number;
}

export interface CacheStatus {
  embedder: { has_model?: boolean; model?: string };
  database: { running: boolean; where: string; error?: string };
  users: string[];
  threshold: number;
  ttl_s: number;
  prompt_version: string;
  stats: CacheStats;
  pairs: CachePair[];
  dims?: number;
  create_sql?: string;
  lookup_sql?: string;
  entries?: CacheEntry[];
}

export interface CacheCheck {
  id: number;
  passed: boolean;
  by: 'numbers' | 'model' | 'threshold';
  reason: string;
}

export interface CacheReply {
  hit: boolean;
  answer: string;
  matched: string | null;
  similarity: number | null;
  neighbours: { id: number; question: string; similarity: number }[];
  checked: CacheCheck[];
  scope: string;
  embed_ms: number;
  lookup_ms: number;
  model_ms: number;
  total_ms: number;
  cost_usd: number;
  saved_usd: number;
  stats: CacheStats;
}

export interface CacheAskOptions {
  question: string;
  model: string;
  user: string;
  threshold: number;
  use_cache: boolean;
  check_numbers: boolean;
  check_model: boolean;
}

/** The semantic cache page: a help desk with a cache of answered questions in front of the model. */
export class SemanticCacheService {
  constructor(private readonly client: ApiClient = api) {}

  status(): Promise<CacheStatus> {
    return this.client.get('/api/semantic-cache/status');
  }

  pairs(): Promise<{ pairs: CachePair[]; embed_ms: number; model: string }> {
    return this.client.post('/api/semantic-cache/pairs', {});
  }

  verifyPairs(): Promise<{
    pairs: { a: string; b: string; same_answer: boolean; reason: string }[];
    cost_usd: number;
  }> {
    return this.client.post('/api/semantic-cache/pairs/verify', {});
  }

  ask(options: CacheAskOptions): Promise<CacheReply> {
    return this.client.post('/api/semantic-cache/ask', options);
  }

  clear(): Promise<{ deleted: number }> {
    return this.client.post('/api/semantic-cache/clear', {});
  }
}

export const semanticCacheService = new SemanticCacheService();
