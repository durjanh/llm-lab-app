import { api, type ApiClient } from './apiClient';

export interface OpsInfo {
  configured: boolean;
  deployment_types: [string, string, string][];
  gate: Record<string, number>;
  eval_cases: number;
  metrics: string[];
  cicd: Record<string, string>;
}

export interface Deployment {
  resource: string;
  region: string;
  name: string;
  model: string;
  version: string;
  sku: string;
  capacity: number | null;
  guardrail: string | null;
  upgrade: string | null;
  lifecycle: string | null;
  retires: string | null;
}

export interface Quota {
  region: string;
  quota: string;
  used: number;
  limit: number;
  this_lab: number;
  unit: string;
}

export interface MetricSeries {
  resource: string;
  metric: string;
  unit: string;
  deployment: string;
  aggregation: 'total' | 'average';
  points: { t: string; total: number | null; average: number | null }[];
  sum: number;
  max: number;
}

export interface SecurityReport {
  resources: {
    name: string;
    region: string;
    kind: string;
    checks: { check: string; ok: boolean; note: string }[];
    roles: { role: string; principal_type: string; scope: string }[];
  }[];
}

export interface OpsEvalRow {
  question: string;
  response: string;
  reference: string;
  groundedness: number;
  relevance: number;
  coherence: number;
  reason: string;
  f1: number;
  content_safety_ungrounded: boolean | null;
  passed: boolean;
}

export interface EvalReport {
  rows: OpsEvalRow[];
  means: Record<string, number>;
  gate: Record<string, number>;
  release: boolean;
  seconds: number;
  cost_usd: number;
}

export interface Span {
  name: string;
  parent: number | null;
  id: number;
  start_ms: number;
  ms: number;
  attributes: Record<string, unknown>;
}

export interface TraceReport {
  spans: Span[];
  answer: string;
  trace_id: string;
  cost_usd: number;
}

/** Foundry operations: deployments, quotas, rate limits, metrics, security, evaluations and tracing. */
export class FoundryOpsService {
  constructor(private readonly client: ApiClient) {}

  info(): Promise<OpsInfo> {
    return this.client.get('/api/foundryops/info');
  }
  deployments(): Promise<{ deployments: Deployment[] }> {
    return this.client.get('/api/foundryops/deployments');
  }
  quotas(): Promise<{ quotas: Quota[] }> {
    return this.client.get('/api/foundryops/quotas');
  }
  rateLimit(): Promise<{ headers: Record<string, string>; ms: number; cost_usd: number }> {
    return this.client.post('/api/foundryops/rate-limit', {});
  }
  metrics(hours = 24): Promise<{ series: MetricSeries[]; hours: number; notes: string[] }> {
    return this.client.get(`/api/foundryops/metrics?hours=${hours}`);
  }
  security(): Promise<SecurityReport> {
    return this.client.get('/api/foundryops/security');
  }
  evaluate(): Promise<EvalReport> {
    return this.client.post('/api/foundryops/evaluate', {});
  }
  trace(question: string): Promise<TraceReport> {
    return this.client.post('/api/foundryops/trace', { question });
  }
}

export const foundryopsService = new FoundryOpsService(api);
