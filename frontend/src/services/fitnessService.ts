import type { Exercise, View } from '@/pages/fitness-coach/form';
import { api, type ApiClient } from './apiClient';

export type CoachSends = 'numbers' | 'photo' | 'both';

export interface CoachRequest {
  model: string;
  exercise: Exercise;
  exercise_label: string;
  send: CoachSends;
  question: string;
  view: View;
  in_position: boolean;
  hold_seconds: number | null;
  target_seconds: number | null;
  similarity: number | null;
  measures: { label: string; value: number; unit: string; ideal: string }[];
  checks: { label: string; ok: boolean; detail: string }[];
  photo: string;
}

export interface CoachReply {
  reply: string;
  sent: string; // the text the model read
  photo_sent: boolean;
  model: string;
  cost_usd: number;
  seconds: number;
  input_tokens: number | null;
}

/** The fitness coach: the page measures the pose; a model turns the measurements into a spoken sentence or two. */
export class FitnessService {
  constructor(private readonly client: ApiClient = api) {}

  coach(body: CoachRequest): Promise<CoachReply> {
    return this.client.post('/api/fitness/coach', body);
  }
}

export const fitnessService = new FitnessService();
