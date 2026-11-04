import { ApiClient } from './apiClient';

export interface ModelField {
  field: string;
  label: string;
  type?: string | null;
  description: string;
  custom?: boolean; // made by the agent in this workbook
  sql?: string;
}

export interface ModelTopic {
  topic: string;
  label: string;
  description: string;
  dimensions: ModelField[];
  measures: ModelField[];
  timeframes: string[];
}

export interface Filter {
  field: string;
  op: string;
  values?: unknown[];
}

export interface SchemaTable {
  table: string;
  rows: number;
  note: string;
  columns: { name: string; type: string; values?: string[] }[];
}

/** A semantic query ({topic, dimensions, ...}) or SQL ({sql, limit}); the backend runs either. */
export interface DataQuery {
  topic?: string;
  sql?: string;
  custom_fields?: Record<string, unknown>[];
  dimensions?: string[];
  measures?: string[];
  filters?: Filter[];
  sorts?: { field: string; desc?: boolean }[];
  limit?: number;
}

export interface QueryResult {
  query: DataQuery;
  rows: Record<string, string | number | null>[];
  columns: string[];
  sql: string;
  params: unknown[];
  cached: boolean;
  ms: number;
  row_count: number;
  truncated?: boolean;
  company?: string; // whose rows these are
}

export interface Viewer {
  id: string;
  name: string;
  company: string;
}

export interface Viz {
  kind: 'line' | 'bar' | 'area' | 'table' | 'number';
  title: string;
  x?: string | null;
  y?: string[] | null;
  series?: string | null;
}

export interface Tile {
  id: string;
  title: string;
  query: DataQuery;
  viz: Viz;
  rows?: QueryResult['rows'];
  columns?: string[];
  sql?: string;
  error?: string;
}

export type AgentEvent =
  | { type: 'run'; run_id: string }
  | { type: 'session'; session_id: string }
  | { type: 'text'; text: string }
  | {
      type: 'step';
      tool: string;
      input: Record<string, unknown>;
      label: string;
      detail: string;
      error?: boolean;
      sql?: string;
    }
  | ({ type: 'query' } & QueryResult)
  | { type: 'viz'; viz: Viz }
  | { type: 'field'; topic: string; field: ModelField & { measure: boolean } }
  | { type: 'tile'; dashboard: string; tile: Tile }
  | { type: 'done'; cost_usd: number; total_usd: number; spent_usd: number }
  | { type: 'error'; message: string };

/**
 * The data agent: Claude answers questions about a warehouse through a semantic model, in a workbook.
 * Every call is made as the signed-in viewer, and the backend limits it to that viewer's company.
 */
export class DataAgentService {
  constructor(private readonly client: ApiClient) {}

  /** Stands in for signing in: the backend looks the person up and takes their company from its directory. */
  signIn(viewerId: string): void {
    this.client.setHeader('x-lab-user', viewerId);
  }
  viewers(): Promise<{ viewers: Viewer[] }> {
    return this.client.get('/api/dataagent/viewers');
  }
  model(): Promise<{
    topics: ModelTopic[];
    timeframes: string[];
    max_rows: number;
    schema: { dialect: string; tables: SchemaTable[]; joins: string[]; timestamps: string };
    dashboards: Record<string, Tile[]>;
    viewer: Viewer;
  }> {
    return this.client.get('/api/dataagent/model');
  }
  ask(
    body: { question: string; session_id?: string; model?: string },
    onEvent: (e: AgentEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.client.stream('/api/dataagent/ask', body, onEvent, signal);
  }
  query(q: DataQuery): Promise<QueryResult> {
    return this.client.post('/api/dataagent/query', q);
  }
  sql(sql: string, limit = 500): Promise<QueryResult> {
    return this.client.post('/api/dataagent/sql', { sql, limit });
  }
  dashboard(name: string): Promise<{ name: string; tiles: Tile[] }> {
    return this.client.get(`/api/dataagent/dashboards/${encodeURIComponent(name)}`);
  }
  deleteDashboard(name: string): Promise<{ dashboards: Record<string, Tile[]> }> {
    return this.client.delete(`/api/dataagent/dashboards/${encodeURIComponent(name)}`);
  }
  reset(): Promise<{ reset: boolean }> {
    return this.client.post('/api/dataagent/reset', {});
  }
}

// A client of its own, so the sign-in header goes only to the data agent's routes.
export const dataagentService = new DataAgentService(new ApiClient());
