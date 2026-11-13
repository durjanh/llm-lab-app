import { api, type ApiClient } from './apiClient';

export interface Design {
  summary: string;
  requirements: { functional: string[]; infrastructure: string[]; success_measures: string[] };
  pattern: { choice: 'augmented_llm' | 'workflow' | 'agent'; reasons: string[]; would_change_if: string[] };
  components: {
    model: { choice: string; reasons: string[] };
    retrieval: string;
    tools: { name: string; purpose: string; mechanism: string; why: string }[];
    guardrails: string[];
  };
  value: { pillar: string; claim: string; measure: string }[];
  risks: { risk: string; mitigation: string; human_in_the_loop: string }[];
  compliance: { regulation: string; why_it_may_apply: string; what_to_check: string }[];
  authn_authz: string[];
  evaluation: {
    metrics: { accuracy: string; latency: string; cost: string; safety: string };
    dataset: string;
    ab_test: string;
  };
  slas: { name: string; target: string; how_measured: string }[];
  open_questions: string[];
  adr: {
    title: string;
    status: string;
    context: string;
    decision: string;
    alternatives: string[];
    consequences: string[];
  };
}

export interface DesignResult {
  design: Design;
  tries: { attempt: number; problems: string[] }[];
  cost_usd: number;
  model: string;
}

/** The delivery page: a model turns a business brief into a first-pass design, and code checks its shape. */
export class DeliveryService {
  constructor(private readonly client: ApiClient = api) {}

  design(brief: string, model: string): Promise<DesignResult> {
    return this.client.post('/api/delivery/design', { brief, model });
  }
}

export const deliveryService = new DeliveryService();
