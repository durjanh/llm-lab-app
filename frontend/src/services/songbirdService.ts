import type { Note } from '@/pages/songbird/songs';
import { api, type ApiClient } from './apiClient';

export interface ComposedSong {
  title: string;
  explanation: string;
  notes: Note[];
  tries: { attempt: number; problems: string[] }[];
  cost_usd: number;
  model: string;
}

/** The songbird page: a model writes a score for the two-voice synth, and code checks it can be sung. */
export class SongbirdService {
  constructor(private readonly client: ApiClient = api) {}

  compose(description: string, model: string): Promise<ComposedSong> {
    return this.client.post('/api/songbird/compose', { description, model });
  }
}

export const songbirdService = new SongbirdService();
