import { api, type ApiClient } from './apiClient';

export type SearchMode = 'keyword' | 'vector' | 'hybrid' | 'semantic';

export interface IngestReport {
  steps: { step: string; detail: string; ms: number }[];
  chunks: number;
  sources: number;
  problems: string[];
  at: string;
  cost_usd: number;
}

export interface SearchLabInfo {
  configured: boolean;
  index: string;
  indexed: boolean;
  sources: { id: string; title: string; modality: string; analyzer: string }[];
  queries: { question: string; expect: string }[];
  modes: SearchMode[];
  skillset: unknown;
  report: IngestReport | null;
  embedding: string;
  dimensions: number;
}

export interface SearchHit {
  id: string;
  source: string;
  title: string;
  modality: string;
  chunk: string;
  score: number | null;
  reranker: number | null;
  caption: string | null;
}

export interface QueryResult {
  mode: SearchMode;
  hits: SearchHit[];
  ms: number;
  answer: string | null;
  spent_usd: number;
}

export interface RelevanceResult {
  rows: ({ question: string; expect: string } & Record<SearchMode, { rank: number | null; top: string | null }>)[];
  summary: Record<SearchMode, { hit1: number; hit3: number; mrr: number; ms: number }>;
  n: number;
  spent_usd: number;
}

export interface Health {
  index: { documentCount: number; storageSize: number; vectorIndexSize: number } | null;
  counters: Record<string, { usage: number; quota: number | null }>;
  report: IngestReport | null;
}

export interface AskResult {
  answer: string;
  steps: { query: string; sources: string[] }[];
  cost_usd: number;
  spent_usd: number;
}

/** Search pipeline: ingest every modality into Azure AI Search, enrich it, query it four ways, measure relevance. */
export class SearchLabService {
  constructor(private readonly client: ApiClient) {}

  info(): Promise<SearchLabInfo> {
    return this.client.get('/api/searchlab/info');
  }
  ingest(): Promise<IngestReport & { spent_usd: number }> {
    return this.client.post('/api/searchlab/ingest', {});
  }
  query(text: string, mode: SearchMode): Promise<QueryResult> {
    return this.client.post('/api/searchlab/query', { text, mode });
  }
  evaluate(): Promise<RelevanceResult> {
    return this.client.post('/api/searchlab/evaluate', {});
  }
  health(): Promise<Health> {
    return this.client.get('/api/searchlab/health');
  }
  ask(question: string): Promise<AskResult> {
    return this.client.post('/api/searchlab/ask', { question });
  }
}

export const searchlabService = new SearchLabService(api);
