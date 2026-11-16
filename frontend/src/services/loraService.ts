import { api, type ApiClient } from './apiClient';

export interface LoraModel {
  id: string;
  label: string;
  params: number;
  hidden: number;
  layers: number;
  intermediate: number;
  kv: number;
}

export interface LoraMetrics {
  n: number;
  valid_json: number;
  right_keys: number;
  fields: Record<string, number>;
  all_fields: number;
}

export interface LoraSample {
  email: string;
  answer: Record<string, string>;
  output: string;
  fields: Record<string, boolean>;
}

export interface LoraEval {
  phase: 'before' | 'after';
  metrics: LoraMetrics;
  samples: LoraSample[];
  seconds: number;
  cached?: boolean;
}

export interface LoraMemoryRow {
  label: string;
  params: number;
  adapter_params: number;
  adapter_share: number;
  full_gb: number;
  lora_gb: number;
  qlora_gb: number;
  adapter_mb: number;
}

export interface LoraConfig {
  model_id: string;
  r: number;
  alpha: number;
  dropout: number;
  targets: string[];
  lr: number;
  steps: number;
  batch: number;
  seed: number;
}

export interface LoraAdapter {
  id: string;
  created: number;
  model_id: string;
  config: Partial<LoraConfig>;
  params: { trainable: number; total: number; share: number };
  sizes: { adapter_bytes?: number; base_bytes?: number };
  train_s: number;
  before: LoraMetrics;
  after: LoraMetrics;
}

export interface LoraInfo {
  ready: boolean;
  setup: string;
  busy: boolean;
  models: LoraModel[];
  targets: string[];
  fields: string[];
  system: string;
  dataset: { train: number; test: number; examples: { email: string; target: string }[] };
  machine: string;
  qlora_here: boolean | null;
  memory: LoraMemoryRow[];
  adapters: LoraAdapter[];
}

export interface LoraResult {
  model_id: string;
  device: string;
  config: LoraConfig & { quantize: string };
  params: { trainable: number; total: number; share: number };
  sizes: { adapter_bytes: number; base_bytes: number };
  before: LoraEval;
  after: LoraEval;
  merge: { max_logit_difference?: number; tokens_compared?: number };
  train_s: number;
  total_s: number;
  memory_mb: number;
  final_loss: number | null;
}

export type LoraEvent =
  | { type: 'run'; run_id: string }
  | { type: 'progress'; step: string }
  | { type: 'setup'; device: string; dtype: string; train_examples: number; test_examples: number }
  | ({ type: 'eval' } & LoraEval)
  | { type: 'params'; trainable: number; total: number; share: number }
  | { type: 'step'; step: number; steps: number; loss: number; lr: number; elapsed_s: number; memory_mb: number }
  | { type: 'merge'; max_logit_difference: number; tokens_compared: number }
  | ({ type: 'result' } & LoraResult)
  | { type: 'done'; adapter_id: string }
  | { type: 'error'; message: string };

export interface LoraTryResult {
  base: string;
  adapter: string | null;
  base_json: boolean;
  adapter_json: boolean;
  model_id: string;
}

export interface HubAccount {
  signed_in: boolean;
  name?: string;
  orgs?: string[];
  reason?: string;
  sign_in: string; // the command that signs the LoRA environment in
  suggested?: string; // a repo name to start from, for the model asked about
}

export interface AdapterCard {
  repo_id: string;
  card: string;
  files: string[];
  base_model: string;
  existing: { private: boolean } | null; // the repo is already there: an upload replaces its README and files
}

export interface Published {
  url: string;
  private: boolean;
  commit: string;
  files: string[];
  account: string;
}

/** Fine-tuning with LoRA on this machine: train, score before and after, and try an adapter. */
export class LoraService {
  constructor(private readonly client: ApiClient = api) {}

  info(): Promise<LoraInfo> {
    return this.client.get('/api/lora/info');
  }

  train(config: LoraConfig, onEvent: (e: LoraEvent) => void, signal?: AbortSignal): Promise<void> {
    return this.client.stream('/api/lora/train', config, onEvent, signal);
  }

  cancel(): Promise<{ cancelled: boolean }> {
    return this.client.post('/api/lora/cancel', {});
  }

  tryEmail(email: string, adapterId: string | null): Promise<LoraTryResult> {
    return this.client.post('/api/lora/try', { email, adapter_id: adapterId });
  }

  /** Who the LoRA environment is signed in to Hugging Face as. The token stays in that environment. */
  account(modelId: string): Promise<HubAccount> {
    return this.client.get(`/api/lora/account?model_id=${encodeURIComponent(modelId)}`);
  }

  card(adapterId: string, repoId: string): Promise<AdapterCard> {
    return this.client.post(`/api/lora/adapters/${encodeURIComponent(adapterId)}/card`, { repo_id: repoId });
  }

  /** Uploads to Hugging Face. The page calls it only after the person has confirmed. */
  publish(adapterId: string, repoId: string, isPrivate: boolean, card: string, replace: boolean): Promise<Published> {
    return this.client.post(`/api/lora/adapters/${encodeURIComponent(adapterId)}/publish`, {
      repo_id: repoId,
      private: isPrivate,
      card,
      replace_existing: replace,
      confirm: true,
    });
  }

  remove(adapterId: string): Promise<{ deleted: string }> {
    return this.client.delete(`/api/lora/adapters/${encodeURIComponent(adapterId)}`);
  }
}

export const loraService = new LoraService(api);
