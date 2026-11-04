import { api, type ApiClient } from './apiClient';

export type MediaKind = 'document' | 'image' | 'video' | 'audio';

export interface UnderstandingInfo {
  configured: boolean;
  model: string;
  cu_model: string;
  samples: { id: string; label: string; kind: MediaKind; ready: boolean }[];
  analyzers: {
    id: string;
    kind: MediaKind;
    label: string;
    custom: boolean;
    about?: string;
    schema?: Record<string, { type: string; method?: string; description?: string; enum?: string[] }>;
  }[];
  tasks: string[];
  policy_rules: string[];
  narration: string;
}

export interface Box {
  page: number;
  points: number[][];
}

export interface CuField {
  name: string;
  type: string;
  value: unknown;
  confidence: number | null;
  boxes: Box[];
  item_boxes?: Box[][];
}

export interface CuResult {
  analyzer: string;
  sample: string;
  kind: string;
  markdown: string;
  unit: string | null;
  pages: { width: number; height: number }[];
  fields: CuField[];
  tables: number;
  paragraphs: number;
  words: number;
  transcript: { speaker: string; start: number; end: number; text: string; confidence: number }[];
  keyframes: number[];
  shots: number[];
  duration_ms: number | null;
  usage: Record<string, unknown>;
  seconds: number;
  cost_usd: number;
  spent_usd: number;
}

export interface VisionResult {
  task: string;
  text: string;
  prompt: string;
  seconds: number;
  tokens: { input: number; output: number };
  cost_usd: number;
  spent_usd: number;
  data?: {
    regions?: { label: string; box: number[] }[];
    answer?: string;
    answerable?: boolean;
    evidence?: { what: string; box: number[] }[];
    checks?: { rule: string; passed: boolean; evidence: string }[];
  };
}

/** Content Understanding and vision: documents, photos, audio and video, read by Foundry Tools and a multimodal model. */
export class UnderstandingService {
  constructor(private readonly client: ApiClient) {}

  info(): Promise<UnderstandingInfo> {
    return this.client.get('/api/understanding/info');
  }
  mediaUrl(id: string): string {
    return `/api/understanding/media/${encodeURIComponent(id)}`;
  }
  prepare(): Promise<UnderstandingInfo & { made: string[]; cost_usd: number }> {
    return this.client.post('/api/understanding/prepare', {});
  }
  analyze(sample: string, analyzer: string): Promise<CuResult> {
    return this.client.post('/api/understanding/analyze', { sample, analyzer });
  }
  vision(images: string[], task: string, question = ''): Promise<VisionResult> {
    return this.client.post('/api/understanding/vision', { images, task, question });
  }
}

export const understandingService = new UnderstandingService(api);
