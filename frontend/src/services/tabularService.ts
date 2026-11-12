import { api, type ApiClient } from './apiClient';

export type TabularTask = 'classification' | 'regression';

export interface TabularColumn {
  name: string;
  type: string;
  distinct: number;
  missing: number;
  examples: string[];
  min?: number;
  max?: number;
  note?: string;
}

export interface TabularTable {
  table_id: string;
  name: string;
  rows: number;
  columns: TabularColumn[];
  /** The header, then the first rows. */
  preview: string[][];
}

export interface TabularInfo {
  samples: { id: string; label: string; about: string }[];
  ready: boolean;
  setup: string;
  model: string;
  limits: { upload_mb: number; rows: number; train_rows: number; columns: number };
}

export interface TabularSuggestion {
  target: string;
  task: TabularTask;
  why: string;
  tries: { attempt: number; problems: string[] }[];
  cost_usd: number;
}

export interface ModelResult {
  metrics: Record<string, number | null> & { confusion?: { labels: string[]; matrix: number[][] } };
  fit_s: number;
  predict_s: number;
  sample: { actual: string | number; predicted: string | number; probabilities?: Record<string, number> }[];
  scatter?: [number, number][];
}

/** Everything the script measured. Every number on the page comes from here. */
export interface TabularResult {
  task: TabularTask;
  target: string;
  rows: number;
  train_rows: number;
  test_rows: number;
  columns: number;
  dropped_columns: string[];
  results: { tabpfn: ModelResult; gradient_boosting: ModelResult };
  versions: { tabpfn: string; weights: string };
}

export type TabularEvent =
  | { type: 'run'; run_id: string }
  | { type: 'progress'; step: string }
  | { type: 'result'; result: TabularResult }
  | { type: 'done'; explanation: string; tries: { attempt: number; problems: string[] }[]; cost_usd: number }
  | { type: 'error'; message: string };

/** Tabular foundation models: a table, the suggested target, and TabPFN against gradient boosting. */
export class TabularService {
  constructor(private readonly client: ApiClient) {}

  info(): Promise<TabularInfo> {
    return this.client.get('/api/tabular/info');
  }

  sample(id: string): Promise<TabularTable> {
    return this.client.post(`/api/tabular/samples/${id}`, {});
  }

  upload(file: File): Promise<TabularTable> {
    const form = new FormData();
    form.append('file', file);
    return this.client.post('/api/tabular/tables', form);
  }

  suggest(tableId: string, model?: string): Promise<TabularSuggestion> {
    return this.client.post('/api/tabular/suggest', { table_id: tableId, model });
  }

  run(
    tableId: string,
    target: string,
    task: TabularTask,
    model: string | undefined,
    onEvent: (e: TabularEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.client.stream('/api/tabular/run', { table_id: tableId, target, task, model }, onEvent, signal);
  }
}

export const tabularService = new TabularService(api);
