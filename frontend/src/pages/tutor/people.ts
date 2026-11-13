import type { TutorPersonDto } from '@/services/tutorPeopleService';
import { VOICES, type VoiceSpec } from './speech';

/**
 * Everyone the learner can talk to: the three built-in tutors, and the people made on this page (you, colleagues),
 * each with a name, a face and a voice. A person's id is what the settings keep: a built-in tutor's is its Azure voice
 * name, as before; a made person's is "person:" and their id.
 */
export interface TutorPerson {
  id: string;
  name: string;
  label: string;
  voice: VoiceSpec;
  /** A built-in avatar's id (sonia, ava, ryan), or "custom:" and the person's id for an uploaded GLB. */
  avatar: string;
}

const BUILT_IN: TutorPerson[] = VOICES.map((v) => ({
  id: v.id,
  name: v.name,
  label: v.label,
  voice: { voice: v.id },
  avatar: v.avatar,
}));

let made: TutorPerson[] = [];
const uploaded = new Map<string, { url: string; body: 'F' | 'M' }>();

/** Replaces the made people with the backend's list. Call it before rendering anything that reads tutorFor. */
export function setPeople(list: TutorPersonDto[]): void {
  uploaded.clear();
  made = list.map((p) => {
    if (p.avatar === 'custom' && p.avatar_url) uploaded.set(`custom:${p.id}`, { url: p.avatar_url, body: p.body });
    const own = p.personal?.status === 'ready' && p.personal.speaker_profile_id;
    return {
      id: `person:${p.id}`,
      name: p.name,
      label: `${p.name}${own ? ' (own voice)' : ''}`,
      voice: own
        ? { voice: p.voice, speakerProfileId: p.personal!.speaker_profile_id, baseModel: p.personal!.base_model }
        : { voice: p.voice },
      avatar: p.avatar === 'custom' && p.avatar_url ? `custom:${p.id}` : p.avatar,
    };
  });
}

export const allPeople = (): TutorPerson[] => [...BUILT_IN, ...made];
export const builtInPeople = (): TutorPerson[] => BUILT_IN;
export const madePeople = (): TutorPerson[] => made;

/** The person with this id; the first built-in tutor for one that no longer exists. */
export const tutorFor = (id: string): TutorPerson => allPeople().find((p) => p.id === id) ?? BUILT_IN[0];

/** An uploaded avatar's file and body type, for avatar keys that start with "custom:". */
export const uploadedAvatar = (key: string) => uploaded.get(key);
