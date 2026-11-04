import { api, type ApiClient } from './apiClient';

export interface GeneratedImage {
  id: string;
  kind: 'generated' | 'edited' | 'inpainted' | 'watermarked';
  prompt: string;
  c2pa: boolean;
  bytes: number;
  made_at: string;
  size?: string;
  quality?: string;
  background?: string;
  from?: string[];
  revised_prompt?: string | null;
}

export interface ImageGenInfo {
  configured: boolean;
  model: string;
  sizes: string[];
  qualities: string[];
  backgrounds: string[];
  prompts: { label: string; prompt: string; background?: string }[];
  gallery: GeneratedImage[];
  samples: string[];
  rules: string[];
  video: { status: string; facts: string[]; code: string };
  prices: { text_input_per_m: number; image_input_per_m: number; output_per_m: number };
}

export interface GenerateResult {
  items: GeneratedImage[];
  usage: {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: { text_tokens?: number; image_tokens?: number };
  };
  cost_usd: number;
  seconds: number;
  waited_s: number;
  spent_usd: number;
}

export interface PolicyCheck {
  checks: { rule: string; passed: boolean; evidence: string }[];
  c2pa: boolean;
  cost_usd: number;
}

/** Image generation with gpt-image-2: from a prompt, from reference images and with a mask, plus provenance and checks. */
export class ImageGenService {
  constructor(private readonly client: ApiClient) {}

  info(): Promise<ImageGenInfo> {
    return this.client.get('/api/imagegen/info');
  }
  imageUrl(ref: string): string {
    return `/api/imagegen/images/${encodeURIComponent(ref)}`;
  }
  generate(body: {
    prompt: string;
    size: string;
    quality: string;
    background: string;
    n: number;
  }): Promise<GenerateResult> {
    return this.client.post('/api/imagegen/generate', body);
  }
  edit(body: {
    prompt: string;
    images: string[];
    mask: string;
    size: string;
    quality: string;
  }): Promise<GenerateResult> {
    return this.client.post('/api/imagegen/edit', body);
  }
  watermark(id: string, text: string): Promise<{ item: GeneratedImage; note: string }> {
    return this.client.post('/api/imagegen/watermark', { id, text });
  }
  check(id: string): Promise<PolicyCheck> {
    return this.client.post('/api/imagegen/check', { id });
  }
}

export const imagegenService = new ImageGenService(api);
