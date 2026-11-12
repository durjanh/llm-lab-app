import { api, type ApiClient } from './apiClient';

export type NodeKind = 'folder' | 'file' | 'class' | 'interface' | 'function' | 'method';
export type EdgeKind = 'contains' | 'imports' | 'calls' | 'extends';

export interface GraphNode {
  id: string;
  kind: NodeKind;
  name: string;
  qual?: string;
  file: string;
  line?: number;
  end?: number;
  lang?: string;
  lines?: number;
  bases?: string[];
  error?: string;
}

export interface GraphEdge {
  s: string;
  t: string;
  kind: EdgeKind;
  /** How a call or base class was matched by name: same class, same file, imported file or only definition. */
  how?: string;
}

/** A summary of one analysed code base. */
export interface GraphMeta {
  id: string;
  label: string;
  files: number;
  counts: Partial<Record<NodeKind, number>>;
  edge_counts: Partial<Record<EdgeKind, number>>;
  took_s: number;
  notes: string[];
  at: number;
}

export interface CodeGraph {
  id: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  counts: Partial<Record<NodeKind, number>>;
  edge_counts: Partial<Record<EdgeKind, number>>;
  notes: string[];
  files: number;
  took_s: number;
}

export interface NodeRef {
  id: string;
  kind: NodeKind;
  name: string;
  file: string;
  line?: number;
  matched_by?: string;
}

/** What the side panel shows for one node. */
export interface NodeDetail {
  node: GraphNode;
  code: string;
  outline?: NodeRef[];
  imports?: NodeRef[];
  imported_by?: NodeRef[];
  packages?: string[];
  calls: NodeRef[];
  called_by: NodeRef[];
  extends?: NodeRef[];
  subclasses?: NodeRef[];
}

export interface GraphAnswer {
  answer: string;
  steps: { tool: string; input: Record<string, unknown>; found: number }[];
  /** The node ids the tools touched, for the graph to light up. */
  used: string[];
  cost_usd: number;
  model: string;
}

/** The code knowledge graph: analyse a code base, read one node, and ask questions answered through the graph. */
export class CodeGraphService {
  constructor(private readonly client: ApiClient) {}

  info(): Promise<{ sources: GraphMeta[]; model: string; limits: { files: number; archive_mb: number } }> {
    return this.client.get('/api/code-graph/info');
  }

  analyseLab(): Promise<GraphMeta> {
    return this.client.post('/api/code-graph/analyse', { source: 'lab' });
  }

  analyseGithub(url: string): Promise<GraphMeta> {
    return this.client.post('/api/code-graph/analyse', { source: 'github', url });
  }

  upload(name: string, data: string): Promise<GraphMeta> {
    return this.client.post('/api/code-graph/upload', { name, data });
  }

  graph(id: string): Promise<CodeGraph> {
    return this.client.get(`/api/code-graph/${id}`);
  }

  node(id: string, nodeId: string): Promise<NodeDetail> {
    return this.client.get(`/api/code-graph/${id}/node`, { params: { id: nodeId } });
  }

  ask(id: string, question: string, history: { q: string; a: string }[], model?: string): Promise<GraphAnswer> {
    return this.client.post(`/api/code-graph/${id}/ask`, { question, history, model });
  }
}

export const codeGraphService = new CodeGraphService(api);
