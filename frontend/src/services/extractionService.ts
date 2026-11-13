import { api, type ApiClient } from './apiClient';

export type Json = Record<string, unknown>;

export interface ExtractionDoc {
  id: string;
  type: 'invoice' | 'receipt' | 'purchase_order';
  split: 'validation' | 'test';
  layout: string;
  text: string;
  truth: Record<string, string | number | null>;
  conflict: boolean;
  needs_contract: boolean;
  note: string;
}

export interface ExtractionInfo {
  documents: ExtractionDoc[];
  fields: string[];
  examples: { layout: string; text: string; extraction: Json }[];
  schemas: { nullable: Json; required: Json };
  system: string;
  first_pass_tokens: number;
  batch_discount: number;
  prices: Record<string, { input: number; output: number; cache_read: number }>;
}

export interface SchemaDemo {
  doc_id: string;
  model: string;
  cost_usd: number;
  absent_fields: string[];
  invented: Record<'required' | 'nullable', string[]>;
  variants: Record<
    'required' | 'nullable',
    {
      extraction: Json;
      latency_s: number;
      cost_usd: number;
      fields: Record<string, { truth: unknown; got: unknown; verdict: string }>;
    }
  >;
}

export interface RawResponse {
  stop_reason: string;
  content: ({ type: 'text'; text: string } | { type: 'tool_use'; name: string; input: Json } | { type: string })[];
  usage: { input_tokens: number; output_tokens: number };
}

export interface ToolChoiceDemo {
  doc_id: string;
  truth_type: string;
  cost_usd: number;
  steps: {
    mode: string;
    tool_choice: Json;
    tools: string[];
    note: string;
    latency_s: number;
    cost_usd: number;
    response: RawResponse;
  }[];
}

export interface Issue {
  field: string;
  kind: string;
  message: string;
  why?: string;
}

export interface ValidateDemo {
  doc_id: string;
  status: 'accepted' | 'flagged';
  reason: string;
  cost_usd: number;
  needs_contract: boolean;
  left_for_review: Issue[];
  attempts: {
    attempt: number;
    request: string;
    model_output: Json;
    extraction: Json;
    simulated?: string;
    issues: Issue[];
    decision: { action: string; reason: string; stuck: Issue[] };
  }[];
}

export interface FieldScore {
  truth: string | number | null;
  got: unknown;
  correct: boolean;
  empty: boolean;
  confidence: number | null;
}

export interface DocResult {
  doc_id: string;
  type: string;
  split: string;
  issues: Issue[];
  latency_s: number | null;
  cost_usd: number;
  error?: string | null;
  fields: Record<string, FieldScore>;
  conflict_correct: boolean;
}

export interface Summary {
  docs: number;
  overall: number;
  by_type: Record<string, { accuracy: number; n: number }>;
  by_field: Record<string, { accuracy: number; n: number }>;
  weak_spots: { kind: string; name: string; accuracy: number }[];
  empties: number;
  conflicts_right: number;
  docs_perfect: number;
  latency_mean_s: number | null;
  latency_p95_s: number | null;
  cost_usd: number;
  cost_per_doc_usd: number;
}

export type RunEvent =
  | { type: 'run'; run_id: string }
  | { type: 'start'; total: number; model: string; few_shot: boolean }
  | { type: 'doc'; index: number; of: number; spent_usd: number; result: DocResult }
  | {
      type: 'done';
      run_id: string;
      model: string;
      few_shot: boolean;
      summary: Summary;
      stopped: string | null;
      cost_usd: number;
      seconds: number;
    }
  | { type: 'error'; message: string };

export interface ConfidenceAnalysis {
  run_id: string;
  model: string;
  target: number;
  seed: number;
  validation_docs: number;
  test_docs: number;
  calibration: { band: string; n: number; accuracy: number | null; mean_confidence: number | null }[];
  threshold: { threshold: number; accuracy_above: number | null; coverage: number; reached: boolean };
  test: {
    auto: number;
    review: number;
    auto_accuracy: number | null;
    all_accuracy: number | null;
    routing: { doc_id: string; type: string; review: boolean; reasons: string[] }[];
  };
  spot_check: { doc_id: string; type: string; confidence_min: number | null }[];
  overall: Summary;
}

export interface Comparison {
  a: { run_id: string; model: string; few_shot: boolean; summary: Summary };
  b: { run_id: string; model: string; few_shot: boolean; summary: Summary };
  overall_delta: number;
  by_field: Record<string, { a: number; b: number | null; delta: number }>;
  by_type: Record<string, { a: number; b: number | null; delta: number }>;
  regressions: { doc_id: string; field: string; truth: unknown; a: unknown; b: unknown }[];
  improvements: { doc_id: string; field: string; truth: unknown; a: unknown; b: unknown }[];
  cost_per_1000_docs: { a: number; b: number };
  cost_per_correct_field: { a: number | null; b: number | null };
}

export interface BatchSubmitted {
  batch_id: string;
  group_id: string;
  requests: number;
  expires_at: string;
  max_tokens: number;
  first_request: Json;
}

export interface BatchGroup {
  group_id: string;
  docs: number;
  ok: number;
  failed: number;
  summary: Summary | null;
  plan: {
    resubmit: { doc_id: string; reason: string; detail: string; action: 'chunk' | 'resend' }[];
    held: { doc_id: string; reason: string; detail: string }[];
  };
  batches: string[];
  cost_usd: number;
  standard_usd: number;
}

export interface BatchPoll {
  batch_id: string;
  round: number;
  status: string;
  ended: boolean;
  counts: Record<string, number>;
  custom_ids: string[];
  this_batch?: {
    cost_usd: number;
    standard_usd: number;
    outcomes: Record<string, { status: string; reason?: string; detail?: string }>;
  };
  group?: BatchGroup;
}

export interface BatchResubmitted {
  batch_id: string;
  requests: number;
  custom_ids: string[];
  plan: { doc_id: string; action: string; reason: string }[];
}

/** Structured extraction: a labelled document set, and each mechanism the exam asks about, run live. */
export class ExtractionService {
  constructor(private readonly client: ApiClient = api) {}

  info(): Promise<ExtractionInfo> {
    return this.client.get('/api/extraction/info');
  }

  estimate(
    model: string,
    fewShot: boolean,
  ): Promise<{ docs: number; approx_cost_usd: number; approx_cost_batch_usd: number }> {
    return this.client.post('/api/extraction/estimate', { model, few_shot: fewShot });
  }

  schema(docId: string, model: string): Promise<SchemaDemo> {
    return this.client.post('/api/extraction/schema', { doc_id: docId, model });
  }

  toolChoice(docId: string, model: string): Promise<ToolChoiceDemo> {
    return this.client.post('/api/extraction/tool-choice', { doc_id: docId, model });
  }

  validate(docId: string, model: string, simulate: boolean): Promise<ValidateDemo> {
    return this.client.post('/api/extraction/validate', { doc_id: docId, model, simulate_format_errors: simulate });
  }

  run(model: string, fewShot: boolean, onEvent: (e: RunEvent) => void, signal?: AbortSignal): Promise<void> {
    return this.client.stream('/api/extraction/run', { model, few_shot: fewShot }, onEvent, signal);
  }

  confidence(runId: string, target: number, seed: number, perStratum: number): Promise<ConfidenceAnalysis> {
    return this.client.post('/api/extraction/confidence', { run_id: runId, target, seed, per_stratum: perStratum });
  }

  compare(runA: string, runB: string): Promise<Comparison> {
    return this.client.post('/api/extraction/compare', { run_a: runA, run_b: runB });
  }

  batchSubmit(model: string): Promise<BatchSubmitted> {
    return this.client.post('/api/extraction/batch', { model });
  }

  batchPoll(batchId: string): Promise<BatchPoll> {
    return this.client.get(`/api/extraction/batch/${encodeURIComponent(batchId)}`);
  }

  batchResubmit(batchId: string): Promise<BatchResubmitted> {
    return this.client.post(`/api/extraction/batch/${encodeURIComponent(batchId)}/resubmit`, {});
  }
}

export const extractionService = new ExtractionService();
