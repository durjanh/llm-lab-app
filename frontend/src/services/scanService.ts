import { api, type ApiClient } from './apiClient';

/** The form the model fills in for one medical image, after the backend's wording checks. */
export interface ScanReading {
  is_medical_image: boolean;
  modality: string;
  body_region: string;
  view: string;
  quality: 'good' | 'limited' | 'poor';
  quality_limits: string;
  observations: { what: string; where: string; confidence: 'low' | 'medium' | 'high'; plain: string }[];
  looks_normal: string[];
  cannot_tell: string[];
  possibilities: { name: string; why: string; also_consider: string }[];
  urgency: 'routine' | 'soon' | 'urgent';
  urgency_reason: string;
  questions: string[];
  summary: string;
  /** The reply to a question asked in the note; empty when the note asked nothing. */
  answer: string;
}

export interface ScanResult {
  reading: ScanReading;
  tries: { attempt: number; problems: string[] }[];
  cost_usd: number;
  model: string;
  notice: string;
  /** Set by code when the picture is not a medical image. */
  message: string | null;
  /** Set by code when the model flagged something urgent. */
  urgent_message: string | null;
}

export interface ScanInfo {
  notice: string;
  model: string;
  max_mb: number;
  accepts: string[];
}

/** The scan explainer: what a model can see in a medical image, and follow-up questions. Nothing is stored. */
export class ScanService {
  constructor(private readonly client: ApiClient) {}

  info(): Promise<ScanInfo> {
    return this.client.get('/api/scans/info');
  }

  read(image: string, note: string, model?: string): Promise<ScanResult> {
    return this.client.post('/api/scans/read', { image, note, model });
  }

  ask(question: string, reading: ScanReading, image: string | null, model?: string) {
    return this.client.post<{ answer: string; cost_usd: number }>('/api/scans/ask', {
      question,
      reading,
      image,
      model,
    });
  }
}

export const scanService = new ScanService(api);
