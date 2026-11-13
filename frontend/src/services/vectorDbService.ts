import { api, type ApiClient } from './apiClient';

export interface VectorSource {
  collection: string;
  source: string;
  chunks: number;
  characters?: number;
  added?: string;
  access?: string;
  tags?: string[];
}

export interface VectorDbStatus {
  embedder: { configured: boolean; running?: boolean; has_model?: boolean; model?: string };
  database: {
    where: string;
    running: boolean;
    server?: string;
    pgvector?: string | null;
    has_pgvector?: boolean;
    tables?: { name: string; rows: number; bytes: number }[];
    error?: string;
  };
  chunk_chars: number;
  readers?: Record<string, string[]>;
  access?: string[];
  samples: Record<string, { title: string; collection: string; documents: number }>;
  dims?: number;
  create_sql?: string;
  sources?: VectorSource[];
}

export interface VectorAdded {
  source: string;
  collection: string;
  chunks: number;
  dims: number;
  embed_ms: number;
  store_ms: number;
  preview: { chunk: number; content: string; head: number[] }[];
}

export interface VectorRow {
  id: number;
  source: string;
  chunk: number;
  content: string;
  similarity?: number;
  rank?: number;
  score?: number;
  semantic_place?: number | null;
  access?: string;
  tags?: string[];
  keyword_place?: number | null;
}

export interface VectorList {
  sql: string;
  ms: number;
  rows: VectorRow[];
}

export interface VectorSearchResult {
  semantic: VectorList;
  keyword: VectorList;
  hybrid: VectorList;
  plan: string;
  embed_ms: number;
  dims: number;
  model: string;
  query_head: number[];
  visible?: number;
  hidden?: number;
  reader?: string | null;
  groups?: string[] | null;
}

export interface VectorAnswer {
  answer: string;
  passages: VectorRow[];
  cited: number[];
  unknown: number[];
  cost_usd: number;
  model: string | null;
}

/** The vector database page: PostgreSQL with pgvector, filled and searched with the local embedding model. */
export class VectorDbService {
  constructor(private readonly client: ApiClient = api) {}

  status(): Promise<VectorDbStatus> {
    return this.client.get('/api/vectordb/status');
  }

  add(
    collection: string,
    source: string,
    text: string,
    access = 'everyone',
    tags: string[] = [],
  ): Promise<VectorAdded> {
    return this.client.post('/api/vectordb/documents', { collection, source, text, access, tags });
  }

  addSamples(key: string): Promise<{ collection: string; documents: number; chunks: number; embed_ms: number }> {
    return this.client.post(`/api/vectordb/samples/${encodeURIComponent(key)}`, {});
  }

  remove(collection: string, source?: string): Promise<{ deleted: number }> {
    return this.client.post('/api/vectordb/remove', { collection, source: source ?? null });
  }

  search(
    collection: string,
    query: string,
    k: number,
    reader: string | null,
    tags: string[],
  ): Promise<VectorSearchResult> {
    return this.client.post('/api/vectordb/search', { collection, query, k, reader, tags });
  }

  answer(
    collection: string,
    query: string,
    k: number,
    model: string,
    reader: string | null,
    tags: string[],
  ): Promise<VectorAnswer> {
    return this.client.post('/api/vectordb/answer', { collection, query, k, model, reader, tags });
  }
}

export const vectorDbService = new VectorDbService();
