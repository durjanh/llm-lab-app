import { api, type ApiClient } from './apiClient';

export type GraphMode = 'vector' | 'local' | 'global';

export interface GraphEstimate {
  chunks: number;
  used: number;
  capped: boolean;
  calls: number;
  cost_usd: number;
  model: string;
}

export interface GraphCollection {
  collection: string;
  chunks: number;
  documents: number;
  entities: number;
  relations: number;
  communities: number;
  built: string | null;
  estimate: GraphEstimate;
}

export interface GraphStatus {
  sample: { collection: string; title: string; documents: number };
  questions: Record<string, { local: string[]; global: string[] }>;
  limits: { chunks: number; communities: number };
  embedder: { configured: boolean; running?: boolean; has_model?: boolean; model?: string };
  collections: GraphCollection[];
  dims?: number;
  error?: string;
}

export interface GraphEntity {
  key: string;
  name: string;
  type: string;
  description: string;
  refs: { source: string; chunk: number }[];
  degree: number;
  community: number;
}

export interface GraphRelation {
  source: string;
  target: string;
  description: string;
  strength: number;
}

export interface GraphCommunity {
  community: number;
  title: string;
  summary: string;
  members: string[];
}

export interface KnowledgeGraph {
  entities: GraphEntity[];
  relations: GraphRelation[];
  communities: GraphCommunity[];
}

export type GraphBuildEvent =
  | { type: 'run'; run_id: string }
  | { type: 'progress'; step: string; done?: number; total?: number }
  | { type: 'note'; message: string }
  | {
      type: 'chunk';
      done: number;
      total: number;
      source: string;
      chunk: number;
      entities: number;
      relationships: number;
      cost_usd: number;
    }
  | { type: 'merged'; mentions: number; entities: number; relations: number }
  | { type: 'communities'; count: number; summarised: number; sizes: number[] }
  | {
      type: 'done';
      entities: number;
      relations: number;
      communities: number;
      cost_usd: number;
      model: string;
      seconds: number;
    }
  | { type: 'error'; message: string };

export interface GraphEvidence {
  kind: 'chunk' | 'entity' | 'relation' | 'community';
  label: string;
  text: string;
  key?: string;
  keys?: string[];
  community?: number;
}

export interface GraphAnswer {
  mode: GraphMode;
  answer: string;
  evidence: GraphEvidence[];
  cited: number[];
  unknown: number[];
  highlight: { entities: string[]; seeds?: string[]; communities: number[] };
  cost_usd: number;
  model: string | null;
  ms: number;
  sql?: string;
  hops?: Record<string, number>;
  mapped?: number;
}

/** GraphRAG: a knowledge graph built from a vector database collection, searched three ways. */
export class GraphRagService {
  constructor(private readonly client: ApiClient = api) {}

  status(model: string): Promise<GraphStatus> {
    return this.client.get('/api/graphrag/status', { params: { model } });
  }

  loadSample(): Promise<{ collection: string; documents: number; chunks: number }> {
    return this.client.post('/api/graphrag/sample', {});
  }

  graph(collection: string): Promise<KnowledgeGraph> {
    return this.client.get('/api/graphrag/graph', { params: { collection } });
  }

  build(collection: string, model: string, onEvent: (e: GraphBuildEvent) => void, signal?: AbortSignal): Promise<void> {
    return this.client.stream('/api/graphrag/build', { collection, model }, onEvent, signal);
  }

  ask(collection: string, question: string, mode: GraphMode, model: string): Promise<GraphAnswer> {
    return this.client.post('/api/graphrag/ask', { collection, question, mode, model });
  }
}

export const graphragService = new GraphRagService();
