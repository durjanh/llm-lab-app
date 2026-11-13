import { api, type ApiClient } from './apiClient';

export interface PersonalVoiceState {
  status: 'consent' | 'voice' | 'ready' | 'failed';
  error: string | null;
  speaker_profile_id: string | null;
  base_model: string;
}

export interface TutorPersonDto {
  id: string;
  name: string;
  body: 'F' | 'M';
  avatar: string; // sonia, ava, ryan or custom
  voice: string; // an Azure neural voice
  locale: string;
  avatar_url: string | null;
  personal: PersonalVoiceState | null;
}

export interface PeopleListing {
  people: TutorPersonDto[];
  standard_voices: Record<string, string>;
  built_in_avatars: Record<string, 'F' | 'M'>;
  locales: string[];
  consent: string; // the consent statement, with {name} and {company}
  sample_text: string;
  personal_voice: { configured: boolean; ready: boolean; detail: string; region?: string; resource?: string };
  base_model: string;
}

export type PersonInput = Pick<TutorPersonDto, 'name' | 'body' | 'avatar' | 'voice' | 'locale'>;

/** The tutor's people: names, faces and voices, including a person's own voice through Azure personal voice. */
export class TutorPeopleService {
  constructor(private readonly client: ApiClient = api) {}

  list(): Promise<PeopleListing> {
    return this.client.get('/api/tutor/people');
  }

  create(person: PersonInput): Promise<TutorPersonDto> {
    return this.client.post('/api/tutor/people', person);
  }

  update(id: string, changes: Partial<PersonInput>): Promise<TutorPersonDto> {
    return this.client.patch(`/api/tutor/people/${id}`, changes);
  }

  remove(id: string): Promise<{ deleted: string }> {
    return this.client.delete(`/api/tutor/people/${id}`);
  }

  uploadAvatar(id: string, file: File): Promise<TutorPersonDto> {
    const form = new FormData();
    form.append('file', file);
    return this.client.post(`/api/tutor/people/${id}/avatar`, form);
  }

  startVoice(id: string, company: string, consent: Blob, sample: Blob): Promise<TutorPersonDto> {
    const form = new FormData();
    form.append('company', company);
    form.append('consent', consent, 'consent.wav');
    form.append('sample', sample, 'sample.wav');
    return this.client.post(`/api/tutor/people/${id}/voice`, form);
  }

  refreshVoice(id: string): Promise<TutorPersonDto> {
    return this.client.get(`/api/tutor/people/${id}/voice`);
  }

  removeVoice(id: string): Promise<TutorPersonDto> {
    return this.client.delete(`/api/tutor/people/${id}/voice`);
  }

  personalToken(): Promise<{ token: string; region: string }> {
    return this.client.get('/api/tutor/personal-voice-token');
  }
}

export const tutorPeopleService = new TutorPeopleService();
