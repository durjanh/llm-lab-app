import { api, type ApiClient } from './apiClient';

export interface GuardrailsInfo {
  configured: boolean;
  model: string;
  categories: string[];
  default_threshold: number;
  blocklist: { name: string; terms: string[] };
  policy: string;
  messages: { label: string; text: string }[];
  attacks: { label: string; prompt: string; documents: string[] }[];
  grounded: { label: string; query: string; answer: string }[];
  pii_text: string;
  protected: { label: string; text: string }[];
  images: { id: string; label: string }[];
  test_set: number;
  system_message: string;
}

interface Paid {
  cost_usd: number;
  spent_usd: number;
}

export interface Moderation extends Paid {
  categories: Record<string, number>;
  blocklist: string[];
  ms: number;
}

export interface Shield extends Paid {
  prompt_attack: boolean;
  document_attacks: boolean[];
  ms: number;
}

export interface Groundedness extends Paid {
  ungrounded: boolean;
  ungrounded_share: number;
  spans: string[];
  ms: number;
}

export interface Pii extends Paid {
  redacted: string;
  entities: { text: string; category: string; confidence: number }[];
}

export interface ImageCheck extends Paid {
  harm: Record<string, number>;
  ocr: string;
  attack_in_image: boolean;
  model_plain: string;
  model_guarded: string;
}

export interface Stage {
  stage: string;
  verdict: 'pass' | 'block' | 'review';
  detail: string;
  ms: number;
  text?: string;
  spans?: string[];
  severities?: Record<string, number>;
  tokens?: number;
}

export interface PipelineResult extends Paid {
  stages: Stage[];
  outcome: 'sent' | 'review' | 'blocked';
  why: string;
  answer: string;
  ms: number;
}

export interface TestCase {
  text: string;
  kind: 'moderation' | 'shield' | 'document' | 'grounded';
  expect: boolean;
  fired: boolean;
  correct: boolean;
  detail: string;
  ms: number;
}

export interface Evaluation extends Paid {
  results: TestCase[];
  by_kind: Record<string, { caught: number; missed: number; false_alarm: number; clean: number }>;
  correct: number;
  total: number;
  threshold: number;
}

export interface DeploymentFilter {
  deployment: string;
  policy: string;
  read_from_azure: boolean;
  mode: string;
  filters: { name: string; source: string; enabled: boolean; blocking: boolean; threshold: string | null }[];
  custom_policies: string[];
  sku: string;
  model: { name: string; version: string };
}

/** Guardrails: Azure AI Content Safety, Prompt Shields, groundedness and PII detection around a Foundry model. */
export class GuardrailsService {
  constructor(private readonly client: ApiClient) {}

  info(): Promise<GuardrailsInfo> {
    return this.client.get('/api/guardrails/info');
  }
  imageUrl(id: string): string {
    return `/api/guardrails/images/${encodeURIComponent(id)}`;
  }
  moderate(text: string): Promise<Moderation> {
    return this.client.post('/api/guardrails/moderate', { text });
  }
  shield(prompt: string, documents: string[]): Promise<Shield> {
    return this.client.post('/api/guardrails/shield', { prompt, documents });
  }
  groundedness(answer: string, query: string): Promise<Groundedness> {
    return this.client.post('/api/guardrails/groundedness', { answer, query });
  }
  protected(text: string): Promise<{ detected: boolean } & Paid> {
    return this.client.post('/api/guardrails/protected', { text });
  }
  pii(text: string): Promise<Pii> {
    return this.client.post('/api/guardrails/pii', { text });
  }
  image(body: { image_id?: string; data?: string; question: string }): Promise<ImageCheck> {
    return this.client.post('/api/guardrails/image', body);
  }
  pipeline(question: string, document: string, threshold: number): Promise<PipelineResult> {
    return this.client.post('/api/guardrails/pipeline', { question, document, threshold });
  }
  evaluate(threshold: number): Promise<Evaluation> {
    return this.client.post('/api/guardrails/evaluate', { threshold });
  }
  deployment(): Promise<DeploymentFilter> {
    return this.client.get('/api/guardrails/deployment');
  }
}

export const guardrailsService = new GuardrailsService(api);
